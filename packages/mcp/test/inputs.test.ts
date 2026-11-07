import { request as httpRequest } from "node:http";
import { ContextRepository, Database, encodePng, Masker, newVaultKey, Vault, type EntityDetector, type OcrWord, type Span, type TextRecognizer } from "@sf-agent-po/core";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, Intake, IntakeError, MAX_ROUNDS, pageReviewer, requestDigest, type ApprovalRequest, type Decision, type Reviewer } from "../src/index.js";

const fakeModel =
  (names: readonly string[]): EntityDetector =>
  async (text) => {
    const spans: Span[] = [];
    for (const name of names) for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) spans.push({ start: i, end: i + name.length, type: "PER", source: "ner" });
    return spans;
  };

type Answer = Partial<Omit<Decision, "digest">> | ((req: ApprovalRequest) => Partial<Omit<Decision, "digest">>);

/** A user who answers each request in turn, and the requests they were shown. */
function scripted(...answers: Answer[]): Reviewer & { seen: ApprovalRequest[] } {
  const seen: ApprovalRequest[] = [];
  return {
    seen,
    async review(req) {
      seen.push(req);
      const a = answers.shift();
      if (!a) throw new Error("No answer left.");
      const d = typeof a === "function" ? a(req) : a;
      return { status: "approved", missed: [], ...d, digest: requestDigest(req) };
    },
  };
}

const word = (text: string, x0: number, x1: number, confidence = 95): OcrWord => ({ text, confidence, box: { x0, y0: 10, x1, y1: 30 } });
const fakeOcr = (lines: OcrWord[][]): TextRecognizer => ({ recognize: async () => ({ lines, confidence: 90 }), close: async () => {} });
const blankPng = (width: number, height: number) => encodePng({ width, height, data: new Uint8Array(width * height * 4).fill(255) });

function setup(reviewer: Reviewer, { version = "1.0.0-next.1", model, ocr }: { version?: string; model?: EntityDetector; ocr?: TextRecognizer } = {}) {
  const db = new Database(":memory:");
  const vault = new Vault(db, newVaultKey());
  const contexts = new ContextRepository(db);
  const masker = new Masker({ vault, model });
  let created = 0;
  const intake = new Intake({
    contexts,
    masker,
    reviewer,
    version,
    recognizer: async () => (created++, ocr ?? fakeOcr([])),
  });
  return { contexts, masker, intake, created: () => created };
}

const notes = { kind: "meeting-notes" as const, title: "Call with Karim Benali", source: "/notes/karim.txt", content: "Karim Benali and Lea Martin agreed on the VIP flag." };

describe("adding inputs with review", () => {
  it("adds a masked input only after the user approved it, as they saw it", async () => {
    const user = scripted({ status: "approved" });
    const { intake, contexts } = setup(user, { model: fakeModel(["Karim Benali", "Lea Martin"]) });
    const result = await intake.addDocuments("acme", [notes]);

    expect(user.seen).toHaveLength(1);
    const shown = user.seen[0]!;
    expect(shown).toMatchObject({ kind: "input", title: "Call with [PERSON_1]", counts: { PERSON: 3 } });
    expect(shown.kind === "input" && shown.content).toContain("[PERSON_1] and [PERSON_2] agreed");
    expect(shown.kind === "input" && shown.content).toContain("Source: [SOURCE_1]");
    expect(JSON.stringify(shown)).not.toMatch(/Karim|Lea|notes\/karim/);

    expect(result.added).toHaveLength(1);
    expect(contexts.documents("acme")[0]).toMatchObject({ title: "Call with [PERSON_1]", source: "[SOURCE_1]", masked: true });
  });

  it("hides values the user names, asks again, and keeps them hidden in later inputs", async () => {
    const user = scripted({ status: "revise", choice: "approved", missed: ["Lea Martin", "x"] }, { status: "approved" }, { status: "approved" });
    const { intake, contexts } = setup(user, { model: fakeModel(["Karim Benali"]) });
    const first = await intake.addDocuments("acme", [notes]);

    expect(user.seen).toHaveLength(2);
    const again = user.seen[1]!;
    expect(again.kind === "input" && again.content).toContain("[PERSON_1] and [PERSON_2] agreed");
    expect(first.ignored).toBe(1);
    expect(contexts.documents("acme")).toHaveLength(1);

    // A later input, with no model at all: the declared name is still hidden.
    await intake.addDocuments("acme", [{ kind: "email", title: "Re: flag", source: "mail-2", content: "LEA MARTIN said yes." }]);
    expect(user.seen[2]!.kind === "input" && (user.seen[2] as { content: string }).content).toContain("[PERSON_2] said yes.");
  });

  it("sets aside rejected and expired inputs and stops asking after a few rounds", async () => {
    const rounds = Array.from({ length: MAX_ROUNDS }, () => ({ status: "revise" as const, choice: "approved" as const, missed: ["agreed"] }));
    const user = scripted({ status: "rejected" }, { status: "expired" }, ...rounds);
    const { intake, contexts } = setup(user);
    const result = await intake.addDocuments("acme", [notes, { ...notes, source: "b" }, { ...notes, source: "c" }]);
    expect(result.setAside.map((s) => s.reason)).toEqual(["rejected", "expired", "too-many-rounds"]);
    expect(result.added).toEqual([]);
    expect(contexts.documents("acme")).toEqual([]);
  });

  it("hides the values named alongside a reject in later inputs", async () => {
    const user = scripted({ status: "rejected", missed: ["Lea Martin"] }, { status: "approved" });
    const { intake } = setup(user);
    expect((await intake.addDocuments("acme", [notes])).setAside).toEqual([{ title: "Call with Karim Benali", reason: "rejected" }]);
    await intake.addDocuments("acme", [{ kind: "email", title: "Re", source: "m", content: "Lea Martin said yes." }]);
    expect((user.seen[1] as { content: string }).content).toContain("[PERSON_1] said yes.");
  });

  it("refuses a decision about anything but what was shown", async () => {
    const reviewer: Reviewer = { review: async () => ({ status: "approved", missed: [], digest: "0".repeat(64) }) };
    const { intake, contexts } = setup(reviewer);
    await expect(intake.addDocuments("acme", [notes])).rejects.toThrow(/does not match what was shown/);
    expect(contexts.documents("acme")).toEqual([]);
  });

  it("reports what was added before a review failed", async () => {
    let calls = 0;
    const reviewer: Reviewer = {
      review: async (req) => {
        if (++calls > 1) throw new Error("no browser");
        return { status: "approved", missed: [], digest: requestDigest(req) };
      },
    };
    const { intake } = setup(reviewer);
    const err = await intake.addDocuments("acme", [notes, { ...notes, source: "b" }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntakeError);
    expect((err as IntakeError).partial.added).toHaveLength(1);
  });

  it("skips the review when it is off: in a release, or by the context's setting", async () => {
    const user = scripted();
    const released = setup(user, { version: "1.0.0" });
    expect((await released.intake.addDocuments("acme", [notes])).added).toHaveLength(1);

    const pre = setup(user);
    pre.contexts.updateSettings("acme", { reviewInputs: false });
    expect((await pre.intake.addDocuments("acme", [notes])).added[0]).toMatchObject({ masked: true });
    expect(user.seen).toEqual([]);
  });
});

describe("adding images", () => {
  const lines = [[word("Owner", 10, 60), word("Karim", 70, 120), word("Benali", 130, 190), word("Qz7", 200, 230, 40)], [word("board", 10, 60), word("7", 70, 80)]];
  const input = { title: "Karim Benali board.png", source: "/shots/board.png", raw: blankPng(240, 40) };

  it("stores the redacted image the user confirmed, even when input review is off", async () => {
    const user = scripted({ status: "approved" });
    const { intake, contexts, created } = setup(user, { version: "1.0.0", model: fakeModel(["Karim Benali"]), ocr: fakeOcr(lines) });
    const result = await intake.addImage("acme", input);

    const shown = user.seen[0]!;
    expect(shown).toMatchObject({ kind: "image", title: "[PERSON_1] board.png", text: "Owner [PERSON_1] Qz7\nboard 7", trusted: true, width: 240, height: 40 });
    expect(shown.kind === "image" && shown.uncertain).toHaveLength(1);
    expect(result.images).toEqual([result.added[0]!.id]);
    const stored = contexts.getImage("acme", result.added[0]!.id)!;
    expect(Buffer.compare(stored.png, Buffer.from((shown as { image: Uint8Array }).image))).toBe(0);
    expect(stored.digest).toBe(requestDigest(shown));
    expect(contexts.documents("acme")[0]).toMatchObject({ kind: "other", source: "[SOURCE_1]", content: "Owner [PERSON_1] Qz7\nboard 7", metadata: { image: { textOnly: false } } });
    expect(created()).toBe(1);
  });

  it("keeps only the text when the user says so", async () => {
    const user = scripted({ status: "text-only" });
    const { intake, contexts } = setup(user, { ocr: fakeOcr(lines) });
    const result = await intake.addImage("acme", input);
    expect(result.images).toEqual([]);
    expect(contexts.getImage("acme", result.added[0]!.id)).toBeUndefined();
    expect(contexts.documents("acme")[0]!.metadata).toMatchObject({ image: { textOnly: true } });
  });

  it("blacks out the uncertain words or the values the user names, then asks again", async () => {
    const user = scripted({ status: "redact-uncertain" }, { status: "revise", choice: "approved", missed: ["board 7"] }, { status: "approved" });
    const { intake } = setup(user, { ocr: fakeOcr(lines) });
    await intake.addImage("acme", input);
    const [first, second, third] = user.seen as Extract<ApprovalRequest, { kind: "image" }>[];
    expect(first!.uncertain).toHaveLength(1);
    expect(second!.uncertain).toEqual([]);
    expect(second!.image).not.toEqual(first!.image);
    expect(third!.text).toBe("Owner Karim Benali Qz7\n[PRIVATE_1]");
    expect(third!.counts).toEqual({ PRIVATE: 1 });
  });

  it("sets an image aside when the user uses neither", async () => {
    const user = scripted({ status: "rejected" });
    const { intake, contexts } = setup(user, { ocr: fakeOcr(lines) });
    expect((await intake.addImage("acme", input)).setAside).toEqual([{ title: "Karim Benali board.png", reason: "rejected" }]);
    expect(contexts.documents("acme")).toEqual([]);
  });
});

/** A raw HTTP call, as the user's browser makes it. */
function call(url: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("reviewing on the approval page", () => {
  const servers: ApprovalServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it("opens the page, and the user's answer there decides", async () => {
    const server = new ApprovalServer();
    servers.push(server);
    const pages: string[] = [];
    const browser = async (link: string) => {
      const r = await call(link);
      const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
      const page = new URL(String(r.headers.location), link).toString();
      setTimeout(async () => {
        const html = (await call(page, { headers: { cookie } })).body;
        pages.push(html);
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
        const missed = pages.length === 1 ? "Lea Martin" : "";
        await call(page, {
          method: "POST",
          body: new URLSearchParams({ csrf, decision: "approved", missed }).toString(),
          headers: { origin: new URL(page).origin, cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
        });
      });
      return true;
    };
    const { intake, contexts } = setup(pageReviewer(server, browser), { model: fakeModel(["Karim Benali"]) });
    const result = await intake.addDocuments("acme", [notes]);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("Lea Martin agreed");
    expect(pages[1]).toContain("<mark>[PERSON_2]</mark> agreed");
    expect(result.added).toHaveLength(1);
    expect(contexts.documents("acme")[0]!.content).toBe("[PERSON_1] and [PERSON_2] agreed on the VIP flag.");
  });

  it("stores the image exactly as the page showed it", async () => {
    const server = new ApprovalServer();
    servers.push(server);
    let shown: Buffer | undefined;
    const browser = async (link: string) => {
      const r = await call(link);
      const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
      const page = new URL(String(r.headers.location), link).toString();
      setTimeout(async () => {
        const html = (await call(page, { headers: { cookie } })).body;
        const src = /<img src="([^"]+)"/.exec(html)![1]!.replace(/&#38;/g, "&");
        shown = await new Promise<Buffer>((resolve, reject) =>
          httpRequest(new URL(src, page), { headers: { cookie } }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
          })
            .on("error", reject)
            .end(),
        );
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
        await call(page, {
          method: "POST",
          body: new URLSearchParams({ csrf, decision: "approved" }).toString(),
          headers: { origin: new URL(page).origin, cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
        });
      });
      return true;
    };
    const lines = [[{ text: "Karim", confidence: 95, box: { x0: 10, y0: 10, x1: 60, y1: 30 } }]];
    const { intake, contexts } = setup(pageReviewer(server, browser), { model: fakeModel(["Karim"]), ocr: fakeOcr(lines) });
    const result = await intake.addImage("acme", { title: "shot.png", source: "/shot.png", raw: blankPng(80, 40) });
    const stored = contexts.getImage("acme", result.images[0]!)!;
    expect(shown && Buffer.compare(stored.png, shown)).toBe(0);
  });

  it("withdraws the request and adds nothing when no browser opens", async () => {
    const server = new ApprovalServer();
    servers.push(server);
    const { intake, contexts } = setup(pageReviewer(server, () => false));
    await expect(intake.addDocuments("acme", [notes])).rejects.toThrow(/could not be opened in a browser/);
    expect(contexts.documents("acme")).toEqual([]);
  });
});
