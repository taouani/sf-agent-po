import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, browserCommand, describeCounts, isPrerelease, markPseudonyms, openInBrowser, reviewsInputs, type ApprovalRequest } from "../src/index.js";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** A raw HTTP call, so tests can set Host and Origin as a browser or an attacker would. */
function call(url: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1]!;

/** Posts the page's form as a browser does: from the page's own origin, with its token. */
async function submit(url: string, fields: Record<string, string>, extra: Record<string, string> = {}): Promise<Reply> {
  const page = await call(url);
  const origin = new URL(url).origin;
  const body = new URLSearchParams({ csrf: csrfOf(page.body.toString()), ...fields }).toString();
  return call(url, { method: "POST", body, headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", ...extra } });
}

const servers: ApprovalServer[] = [];
const server = (opts?: ConstructorParameters<typeof ApprovalServer>[0]) => {
  const s = new ApprovalServer(opts);
  servers.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const publish: ApprovalRequest = { kind: "publish", target: "Jira ACME-12 (update)", title: "VIP <flag>", body: "As Sarah Whitfield, I want my VIP flag.\nLogin stays [SECRET_1].", kept: ["[SECRET_1]"] };

describe("approval page", () => {
  it("shows the unmasked preview, escaped, and returns the user's decision once", async () => {
    const s = server();
    const pending = await s.request(publish);
    expect(pending.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a\/[\w-]{32}$/);
    const page = await call(pending.url);
    const html = page.body.toString();
    expect(page.status).toBe(200);
    expect(html).toContain("As Sarah Whitfield, I want my VIP flag.");
    expect(html).toContain("VIP &#60;flag&#62;");
    expect(html).not.toContain("<flag>");
    expect(html).toContain("<mark>[SECRET_1]</mark>");
    expect(html).not.toMatch(/<script/i);
    expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/);
    expect(page.headers["cache-control"]).toBe("no-store");

    const posted = await submit(pending.url, { decision: "approved", comment: " Ship it " });
    expect(posted.status).toBe(303);
    expect(await pending.decision).toEqual({ status: "approved", missed: [], comment: "Ship it" });
    // A second post changes nothing; the page now shows the outcome.
    const again = await call(pending.url, { method: "POST", headers: { origin: s.origin! }, body: "decision=rejected" });
    expect(again.status).toBe(409);
    expect((await call(pending.url)).body.toString()).toContain("Approved.");
  });

  it("refuses posts from other sites, without the page's token, or with a decision the request does not offer", async () => {
    const s = server();
    const pending = await s.request(publish);
    const csrf = csrfOf((await call(pending.url)).body.toString());
    const form = (fields: Record<string, string>) => new URLSearchParams({ csrf, ...fields }).toString();
    // No Origin, as a script outside a browser would send.
    expect((await call(pending.url, { method: "POST", body: form({ decision: "approved" }) })).status).toBe(403);
    expect((await call(pending.url, { method: "POST", headers: { origin: "https://evil.example" }, body: form({ decision: "approved" }) })).status).toBe(403);
    expect((await call(pending.url, { method: "POST", headers: { origin: s.origin!, "sec-fetch-site": "cross-site" }, body: form({ decision: "approved" }) })).status).toBe(403);
    expect((await call(pending.url, { method: "POST", headers: { origin: s.origin! }, body: "csrf=wrong&decision=approved" })).status).toBe(403);
    expect((await call(pending.url, { method: "POST", headers: { origin: s.origin! }, body: form({ decision: "text-only" }) })).status).toBe(400);
    expect((await call(pending.url, { method: "POST", headers: { origin: s.origin! }, body: form({ decision: "approved", pad: "x".repeat(70_000) }) })).status).toBe(413);
    // Still open.
    expect((await submit(pending.url, { decision: "rejected" })).status).toBe(303);
    expect((await pending.decision).status).toBe("rejected");
  });

  it("answers only on its own host name, and only for requests that exist", async () => {
    const s = server();
    const pending = await s.request(publish);
    // A name that resolves to 127.0.0.1 (DNS rebinding) sends its own Host.
    expect((await call(pending.url, { headers: { host: "attacker.example" } })).status).toBe(421);
    expect((await call(pending.url.replace("127.0.0.1", "localhost"))).status).toBe(200);
    expect((await call(`${s.origin}/a/${"x".repeat(32)}`)).status).toBe(404);
    expect((await call(`${s.origin}/`)).status).toBe(404);
  });

  it("shows a redacted image with its uncertain words and a warning when it was not read reliably", async () => {
    const s = server();
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const pending = await s.request({
      kind: "image",
      title: "Screenshot.png",
      image,
      width: 200,
      height: 100,
      text: "Owner: [PERSON_1]\nNotes <b>",
      trusted: false,
      uncertain: [{ x0: 20, y0: 10, x1: 60, y1: 30 }],
      counts: { PERSON: 1, EMAIL: 2 },
    });
    const html = (await call(pending.url)).body.toString();
    expect(html).toContain("could not be read reliably");
    expect(html).toContain("left:10.000%;top:10.000%;width:20.000%;height:20.000%");
    expect(html).toContain("Owner: <mark>[PERSON_1]</mark>\nNotes &#60;b&#62;");
    expect(html).toContain("1 name, 2 email addresses");
    const png = await call(`${pending.url}/image.png`);
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.body.equals(image)).toBe(true);
    expect((await submit(pending.url, { decision: "text-only" })).status).toBe(303);
    expect(await pending.decision).toEqual({ status: "text-only", missed: [] });
    // Once decided, the image is no longer served.
    expect((await call(`${pending.url}/image.png`)).status).toBe(404);
  });

  it("asks to check an input again when the user lists values still in clear", async () => {
    const s = server();
    const pending = await s.request({ kind: "input", title: "Call notes", content: "[PERSON_1] met Tom Baker.", counts: { PERSON: 1 } });
    const html = (await call(pending.url)).body.toString();
    expect(html).toContain("<mark>[PERSON_1]</mark> met Tom Baker.");
    await submit(pending.url, { decision: "approved", missed: "Tom Baker\r\n\r\n Tom Baker \nACME-secret" });
    expect(await pending.decision).toEqual({ status: "revise", missed: ["Tom Baker", "ACME-secret"] });
    expect((await call(pending.url)).body.toString()).toContain("asked to check again");
  });

  it("expires requests that wait too long, are cancelled, or are open when the server closes", async () => {
    const s = server({ timeoutMs: 50 });
    const late = await s.request(publish);
    expect(await late.decision).toEqual({ status: "expired", missed: [] });
    expect((await call(late.url)).body.toString()).toContain("expired");
    const s2 = server();
    const cancelled = await s2.request(publish);
    cancelled.cancel();
    expect((await cancelled.decision).status).toBe("expired");
    const open = await s2.request(publish);
    await s2.close();
    expect((await open.decision).status).toBe("expired");
  });
});

describe("helpers", () => {
  it("marks pseudonyms and escapes the rest", () => {
    expect(markPseudonyms("<a> [NATIONAL_ID_2] & [x_1] [PERSON_10]")).toBe("&#60;a&#62; <mark>[NATIONAL_ID_2]</mark> &#38; [x_1] <mark>[PERSON_10]</mark>");
    expect(describeCounts({ PERSON: 2, ADDRESS: 1, CUSTOM_TYPE: 3, IP: 0 })).toBe("2 names, 1 address, 3 custom type values");
    expect(describeCounts()).toBe("nothing");
  });

  it("reviews inputs in pre-releases unless the context says otherwise", () => {
    expect(isPrerelease("1.0.0-next.3")).toBe(true);
    expect(isPrerelease("1.0.0")).toBe(false);
    expect(reviewsInputs(undefined, "1.0.0-next.1")).toBe(true);
    expect(reviewsInputs({}, "1.0.0")).toBe(false);
    expect(reviewsInputs({ reviewInputs: false }, "1.0.0-next.1")).toBe(false);
    expect(reviewsInputs({ reviewInputs: true }, "1.0.0")).toBe(true);
  });

  it("opens only its own page, with a fixed program per OS", async () => {
    expect(browserCommand("darwin")?.file).toBe("/usr/bin/open");
    const win = browserCommand("win32", { SystemRoot: "C:\\Windows" })!;
    expect(win.file.replace(/\\/g, "/")).toMatch(/C:\/Windows\/System32\/rundll32\.exe$/);
    expect(win.args("http://127.0.0.1:1/a/x")).toEqual(["url.dll,FileProtocolHandler", "http://127.0.0.1:1/a/x"]);
    expect(await openInBrowser("https://example.com/", { file: "/bin/true", args: () => [] })).toBe(false);
    // null, not undefined: undefined would take the real browser.
    expect(await openInBrowser("http://127.0.0.1:1/a/x", null)).toBe(false);
    expect(await openInBrowser("http://127.0.0.1:1/a/x", { file: process.execPath, args: () => ["-e", ""] })).toBe(true);
  });
});
