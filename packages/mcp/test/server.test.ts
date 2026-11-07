import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ContextRepository, Database, encodePng, Masker, newVaultKey, Vault, type EntityDetector, type Span, type TextRecognizer } from "@sf-agent-po/core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, createServer, lazyDetector, requestDigest, type ApprovalRequest, type Decision, type Reviewer } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "sf-agent-mcp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fakeModel =
  (names: readonly string[]): EntityDetector =>
  async (text) => {
    const spans: Span[] = [];
    for (const name of names) for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) spans.push({ start: i, end: i + name.length, type: "PER", source: "ner" });
    return spans;
  };

const ocr: TextRecognizer = {
  recognize: async () => ({ lines: [[{ text: "Owner", confidence: 95, box: { x0: 2, y0: 2, x1: 30, y1: 12 } }, { text: "Karim", confidence: 95, box: { x0: 34, y0: 2, x1: 70, y1: 12 } }]], confidence: 90 }),
  close: async () => {},
};
const png = (w: number, h: number) => encodePng({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(255) });

type Answer = Partial<Omit<Decision, "digest">>;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function connect(opts: { answers?: Answer[]; version?: string; model?: EntityDetector; open?: (url: string) => boolean; modelReady?: () => boolean } = {}) {
  const db = new Database(":memory:");
  const vault = new Vault(db, newVaultKey());
  const contexts = new ContextRepository(db);
  const masker = new Masker({ vault, model: opts.model ?? fakeModel(["Karim Benali", "Karim"]) });
  const approval = new ApprovalServer();
  const seen: ApprovalRequest[] = [];
  const answers = opts.answers;
  const reviewer: Reviewer | undefined = answers && {
    async review(req) {
      seen.push(req);
      return { status: "approved", missed: [], ...answers.shift(), digest: requestDigest(req) };
    },
  };
  const server = createServer({
    contexts,
    masker,
    errorMasker: new Masker({ vault }),
    approval,
    recognizer: async () => ocr,
    version: opts.version ?? "1.0.0-next.0",
    reviewer: reviewer && (() => reviewer),
    modelReady: opts.modelReady,
    review: { open: opts.open ?? (() => false), progressEveryMs: 20 },
  });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(async () => {
    await client.close();
    await approval.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}, options?: Parameters<Client["callTool"]>[2]) => {
    const r = (await client.callTool({ name, arguments: args }, undefined, options)) as { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
    return { ...r, text: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") };
  };
  return { call, contexts, seen, client, vault };
}

describe("v1 context tools", () => {
  it("adds pasted text masked, after the user approved it, and returns only pseudonyms", async () => {
    const { call, seen, contexts } = await connect({ answers: [{ status: "approved" }] });
    const r = await call("context_add_text", { context: "acme", title: "Call with Karim Benali", content: "Karim Benali wants the VIP flag.", kind: "meeting-notes" });
    expect(r.isError).toBeFalsy();
    expect(seen[0]).toMatchObject({ kind: "input", title: "Call with [PERSON_1]" });
    expect(r.text).toContain("Call with [PERSON_1]");
    expect(r.text).toContain("hidden: 2 names");
    expect(r.text).not.toContain("Karim");
    expect(contexts.documents("acme")).toHaveLength(1);

    const read = await call("context_read", { context: "acme" });
    expect(read.text).toContain("[PERSON_1] wants the VIP flag.");
    expect(read.text).not.toContain("Karim");
    expect((await call("context_show", { context: "acme" })).text).toContain("input review on");
  });

  it("tells the model what the user set aside, without the values", async () => {
    const { call, contexts } = await connect({ answers: [{ status: "rejected", missed: ["VIP flag"] }] });
    const r = await call("context_add_text", { context: "acme", title: "Notes", content: "Karim Benali wants the VIP flag.", kind: "other" });
    expect(r.text).toContain("Nothing was added");
    expect(r.text).toContain("the user did not want it used");
    expect(r.text).not.toMatch(/Karim|VIP/);
    expect(contexts.documents("acme")).toEqual([]);
  });

  it("adds a folder's files and images, and returns confirmed images to read", async () => {
    const folder = join(dir, "inputs");
    mkdirSync(join(folder, "shots"), { recursive: true });
    writeFileSync(join(folder, "notes.txt"), "Karim agreed.");
    writeFileSync(join(folder, "shots", "board.png"), png(80, 16));
    writeFileSync(join(folder, "shots", "fake.png"), "not a png");
    const { call, seen, contexts } = await connect({ answers: [{ status: "approved" }, { status: "approved" }] });
    const r = await call("context_add_file", { context: "acme", path: folder });
    expect(r.isError).toBeFalsy();
    expect(seen.map((s) => s.kind)).toEqual(["input", "image"]);
    expect(r.text).toContain("Added 2 input(s)");
    expect(r.text).toContain(", image)");
    expect(r.text).toContain("1 file(s) could not be read");
    expect(r.text).not.toContain(folder); // sources are pseudonyms
    expect(contexts.documents("acme").map((d) => d.content)).toEqual(["[PERSON_1] agreed.", "Owner [PERSON_1]"]);

    const read = await call("context_read", { context: "acme" });
    expect(read.content.filter((c) => c.type === "image")).toHaveLength(1);
    const noImages = await call("context_read", { context: "acme", images: false });
    expect(noImages.content.filter((c) => c.type === "image")).toHaveLength(0);
  });

  it("masks error messages, which may quote a file name", async () => {
    const { call } = await connect({ answers: [] });
    const r = await call("context_add_file", { context: "acme", path: join(dir, "Karim Benali", "missing.txt") });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("[PERSON_1]");
    expect(r.text).not.toContain("Karim");
  });

  it("masks errors with the rules when the model cannot load", async () => {
    const broken = lazyDetector(() => Promise.reject(new Error("offline")));
    const { call } = await connect({ answers: [], model: broken });
    const r = await call("context_add_text", { context: "acme", title: "t", content: "write to karim@example.com", kind: "other" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("could not be loaded");
  });

  it("never shows inputs that are not masked yet", async () => {
    const { call, contexts } = await connect({ answers: [] });
    contexts.addDocuments("acme", [{ kind: "other", title: "Call with Karim Benali", source: "/home/kbenali/notes.txt", content: "x" }]);
    const r = await call("context_show", { context: "acme" });
    expect(r.text).toContain("1 input(s) are not masked yet");
    expect(r.text).not.toMatch(/Karim|kbenali/);
    expect((await call("context_read", { context: "acme" })).text).toBe("No matching inputs.");
  });

  it("tells what was added before a failure, with the same pseudonyms", async () => {
    const folder = join(dir, "partial");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "a.txt"), "Karim agreed.");
    writeFileSync(join(folder, "b.png"), png(80, 16));
    const db = new Database(":memory:");
    const vault = new Vault(db, newVaultKey());
    const contexts = new ContextRepository(db);
    const masker = new Masker({ vault, model: fakeModel(["Karim"]) });
    let calls = 0;
    const reviewer: Reviewer = {
      async review(req) {
        if (++calls > 1) throw new Error("browser gone");
        return { status: "approved", missed: [], digest: requestDigest(req) };
      },
    };
    const approval = new ApprovalServer();
    const server = createServer({ contexts, masker, approval, recognizer: async () => ocr, version: "1.0.0-next.0", reviewer: () => reviewer });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    cleanups.push(async () => {
      await client.close();
      await approval.close();
    });
    const r = (await client.callTool({ name: "context_add_file", arguments: { context: "acme", path: folder } })) as { content: { text: string }[]; isError?: boolean };
    const out = r.content[0]!.text;
    expect(r.isError).toBe(true);
    expect(out).toContain("browser gone");
    expect(out).toContain("Added 1 input(s)");
    expect(out).toContain("(" + contexts.documents("acme")[0]!.source + ",");
    expect(out).not.toContain("LITERAL");
  });

  it("counts a cut-off image as unread and goes on with the others", async () => {
    const folder = join(dir, "cut");
    mkdirSync(folder, { recursive: true });
    const whole = png(80, 16);
    writeFileSync(join(folder, "a.png"), whole.subarray(0, 40));
    writeFileSync(join(folder, "b.png"), whole);
    const { call, contexts } = await connect({ answers: [{ status: "approved" }] });
    const r = await call("context_add_file", { context: "acme", path: folder });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("1 file(s) could not be read");
    expect(contexts.documents("acme")).toHaveLength(1);
  });

  it("refuses a context name it cannot store, before asking the user anything", async () => {
    const { call, seen } = await connect({ answers: [{ status: "approved" }] });
    const r = await call("context_review_inputs", { context: "Acme Feature", on: false });
    expect(r.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("turns input review off only once the user approved it", async () => {
    const { call, seen } = await connect({ answers: [{ status: "rejected" }, { status: "approved" }] });
    expect((await call("context_review_inputs", { context: "acme", on: false })).text).toContain("stays on");
    expect(seen[0]).toMatchObject({ kind: "publish", title: "Stop checking inputs" });
    expect((await call("context_review_inputs", { context: "acme", on: false })).text).toContain("off");
    await call("context_add_text", { context: "acme", title: "t", content: "Karim agreed.", kind: "other" });
    expect(seen).toHaveLength(2);
    expect((await call("context_review_inputs", { context: "acme", on: true })).text).toContain("on");
    expect(seen).toHaveLength(2);
  });
});

/** A raw HTTP call, as the user's browser makes it. */
function http(url: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** The user's browser: opens the link and presses `decision`. */
async function decide(link: string, decision: string): Promise<void> {
  const r = await http(link);
  const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
  const page = new URL(String(r.headers.location), link).toString();
  const html = (await http(page, { headers: { cookie } })).body;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  await http(page, {
    method: "POST",
    body: new URLSearchParams({ csrf, decision }).toString(),
    headers: { origin: new URL(page).origin, cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
  });
}

describe("reaching the user from a tool call", () => {
  it("opens the page in the browser, and reports progress while the user decides", async () => {
    const opened: string[] = [];
    const { call, contexts } = await connect({
      open: (url) => {
        opened.push(url);
        setTimeout(() => void decide(url, "approved"), 80);
        return true;
      },
    });
    let progress = 0;
    const r = await call("context_add_text", { context: "acme", title: "t", content: "Karim agreed.", kind: "other" }, { onprogress: () => progress++, resetTimeoutOnProgress: true });
    expect(r.isError).toBeFalsy();
    expect(opened).toHaveLength(1);
    expect(progress).toBeGreaterThan(0);
    expect(contexts.documents("acme")).toHaveLength(1);
    // The link is for the user only: it is never in what the model reads.
    expect(r.text).not.toContain("http");
  });

  it("withdraws the request when the call is cancelled", async () => {
    let link = "";
    const { call, contexts } = await connect({
      open: (url) => {
        link = url;
        return true;
      },
    });
    const controller = new AbortController();
    const pending = call("context_add_text", { context: "acme", title: "t", content: "Karim agreed.", kind: "other" }, { signal: controller.signal }).catch((e: Error) => e);
    while (!link) await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 50)); // the cancellation reaches the server
    // Withdrawn: the page only says so.
    const r = await http(link);
    const page = await http(new URL(String(r.headers.location), link).toString(), { headers: { cookie: String(r.headers["set-cookie"]).split(";")[0]! } });
    expect(page.body).toContain("This request expired.");
    expect(contexts.documents("acme")).toEqual([]);
  });

  it("fails without a browser, and withdraws the request", async () => {
    const { call, contexts } = await connect();
    const r = await call("context_add_text", { context: "acme", title: "t", content: "Karim agreed.", kind: "other" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("could not be opened in a browser");
    expect(contexts.documents("acme")).toEqual([]);
  });
});
