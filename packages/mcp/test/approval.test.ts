import { request as httpRequest } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, browserCommand, describeCounts, isPrerelease, markPseudonyms, openInBrowser, requestDigest, reviewsInputs, type ApprovalRequest } from "../src/index.js";

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

/** Opens a single-use link as the browser does: it gets the cookie and the page's own address. */
async function open(link: string): Promise<{ page: string; cookie: string }> {
  const r = await call(link);
  expect(r.status).toBe(303);
  const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
  return { page: new URL(String(r.headers.location), link).toString(), cookie };
}

/** Posts the page's form as a browser does: from the page's own origin, with its cookie and token. */
async function submit(tab: { page: string; cookie: string }, fields: Record<string, string>, extra: Record<string, string> = {}): Promise<Reply> {
  const page = await call(tab.page, { headers: { cookie: tab.cookie } });
  const origin = new URL(tab.page).origin;
  const body = new URLSearchParams({ csrf: csrfOf(page.body.toString()), ...fields }).toString();
  return call(tab.page, { method: "POST", body, headers: { origin, cookie: tab.cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", ...extra } });
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

const image = () => ({
  kind: "image" as const,
  title: "Screenshot.png",
  image: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  width: 200,
  height: 100,
  text: "Owner: [PERSON_1]\nNotes <b>",
  trusted: false,
  uncertain: [{ x0: 20, y0: 10, x1: 60, y1: 30 }],
  counts: { PERSON: 1, EMAIL: 2 },
});

const publish: ApprovalRequest = { kind: "publish", target: "Jira ACME-12 (update)", title: "VIP <flag>", body: "As Sarah Whitfield, I want my VIP flag.\nLogin stays [SECRET_1].", kept: ["[SECRET_1]"] };

describe("approval page", () => {
  it("shows the unmasked preview, escaped, and returns the user's decision once", async () => {
    const s = server();
    const pending = await s.request(publish);
    expect(pending.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a\/[\w-]{32}\?k=[\w-]{32}$/);
    const tab = await open(pending.url);
    expect(tab.cookie).toMatch(/^sfa=[\w-]{32}$/);
    const page = await call(tab.page, { headers: { cookie: tab.cookie } });
    const html = page.body.toString();
    expect(page.status).toBe(200);
    expect(html).toContain("As Sarah Whitfield, I want my VIP flag.");
    expect(html).toContain("VIP &#60;flag&#62;");
    expect(html).not.toContain("<flag>");
    expect(html).toContain("<mark>[SECRET_1]</mark>");
    expect(html).not.toMatch(/<script|style="/i);
    expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/);
    expect(page.headers["content-security-policy"]).not.toMatch(/unsafe/);
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.headers["cache-control"]).toBe("no-store");

    const posted = await submit(tab, { decision: "approved", comment: " Ship it " });
    expect(posted.status).toBe(303);
    expect(await pending.decision).toEqual({ status: "approved", choice: "approved", missed: [], comment: "Ship it", digest: pending.digest });
    // A second post changes nothing; the page now shows the outcome.
    const again = await call(tab.page, { method: "POST", headers: { origin: s.origin!, cookie: tab.cookie }, body: "decision=rejected" });
    expect(again.status).toBe(409);
    expect((await call(tab.page, { headers: { cookie: tab.cookie } })).body.toString()).toContain("Approved.");
  });

  it("opens only for the browser that used the link, and withdraws a request whose link is used twice", async () => {
    const s = server();
    const pending = await s.request(publish);
    const page = pending.url.split("?")[0]!;
    // Without the link's cookie, nothing is shown: not the page, not the image, not the form.
    expect((await call(page)).status).toBe(403);
    expect((await call(page, { headers: { cookie: "sfa=guess" } })).body.toString()).not.toContain("Sarah");
    expect((await call(`${pending.url.slice(0, -4)}AAAA`)).status).toBe(403);
    // The wrong key withdrew it already: a guess cannot be followed by the right link.
    expect((await pending.decision).status).toBe("expired");

    const second = await s.request(publish);
    await open(second.url);
    // The same link again (read from a process list or history) withdraws the request.
    expect((await call(second.url)).body.toString()).toContain("works once");
    expect((await second.decision).status).toBe("expired");
  });

  it("refuses posts from other sites, without the page's token, or with a decision the request does not offer", async () => {
    const s = server();
    const pending = await s.request(publish);
    const tab = await open(pending.url);
    const csrf = csrfOf((await call(tab.page, { headers: { cookie: tab.cookie } })).body.toString());
    const form = (fields: Record<string, string>) => new URLSearchParams({ csrf, ...fields }).toString();
    const post = (headers: Record<string, string>, body: string) => call(tab.page, { method: "POST", headers: { cookie: tab.cookie, ...headers }, body });
    // No Origin, as a script outside a browser would send.
    expect((await post({}, form({ decision: "approved" }))).status).toBe(403);
    expect((await post({ origin: "https://evil.example" }, form({ decision: "approved" }))).status).toBe(403);
    expect((await post({ origin: s.origin!, "sec-fetch-site": "cross-site" }, form({ decision: "approved" }))).status).toBe(403);
    expect((await post({ origin: "null" }, form({ decision: "approved" }))).status).toBe(403);
    expect((await post({ origin: s.origin! }, "csrf=wrong&decision=approved")).status).toBe(403);
    expect((await post({ origin: s.origin! }, form({ decision: "text-only" }))).status).toBe(400);
    expect((await post({ origin: s.origin! }, form({ decision: "approved", pad: "x".repeat(70_000) }))).status).toBe(413);
    // Still open. A browser that sends "Origin: null" from the page itself is accepted.
    expect((await submit(tab, { decision: "rejected" }, { origin: "null" })).status).toBe(303);
    expect((await pending.decision).status).toBe("rejected");
  });

  it("answers only on its own host name, and only for requests that exist", async () => {
    const s = server();
    const pending = await s.request(publish);
    // A name that resolves to 127.0.0.1 (DNS rebinding) sends its own Host.
    expect((await call(pending.url, { headers: { host: "attacker.example" } })).status).toBe(421);
    const tab = await open(pending.url.replace("127.0.0.1", "localhost"));
    expect((await call(tab.page, { headers: { cookie: tab.cookie } })).status).toBe(200);
    expect((await call(`${s.origin}/a/${"x".repeat(32)}`)).status).toBe(404);
    expect((await call(`${s.origin}/`)).status).toBe(404);
  });

  it("shows exactly what was asked, even if the caller changes it afterwards", async () => {
    const s = server();
    const req = { ...image(), uncertain: [{ x0: 20, y0: 10, x1: 60, y1: 30 }] };
    const digest = requestDigest(req);
    const pending = await s.request(req);
    req.image[0] = 0;
    req.uncertain.length = 0;
    req.text = "changed";
    expect(pending.digest).toBe(digest);
    const tab = await open(pending.url);
    const html = (await call(tab.page, { headers: { cookie: tab.cookie } })).body.toString();
    expect(html).toContain("Owner: <mark>[PERSON_1]</mark>");
    expect(html).toContain('class="uncertain u0"');
    expect((await call(`${tab.page}/image.png`, { headers: { cookie: tab.cookie } })).body[0]).toBe(0x89);
    expect(requestDigest(req)).not.toBe(digest);
  });

  it("shows a redacted image with its uncertain words and a warning when it was not read reliably", async () => {
    const s = server();
    const req = image();
    const pending = await s.request(req);
    const tab = await open(pending.url);
    const html = (await call(tab.page, { headers: { cookie: tab.cookie } })).body.toString();
    expect(html).toContain("could not be read reliably");
    expect(html).toContain(".u0{left:10.000%;top:10.000%;width:20.000%;height:20.000%}");
    expect(html).toContain("Owner: <mark>[PERSON_1]</mark>\nNotes &#60;b&#62;");
    expect(html).toContain("1 name, 2 email addresses");
    expect(html).toContain('value="redact-uncertain"');
    expect((await call(`${tab.page}/image.png`)).status).toBe(403);
    const png = await call(`${tab.page}/image.png`, { headers: { cookie: tab.cookie } });
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.body.equals(Buffer.from(req.image))).toBe(true);
    expect((await submit(tab, { decision: "text-only" })).status).toBe(303);
    expect(await pending.decision).toMatchObject({ status: "text-only", choice: "text-only", missed: [] });
    // Once decided, the image is no longer served.
    expect((await call(`${tab.page}/image.png`, { headers: { cookie: tab.cookie } })).status).toBe(404);
  });

  it("can black out the uncertain words too, and offers it only when there are some", async () => {
    const s = server();
    const pending = await s.request(image());
    await submit(await open(pending.url), { decision: "redact-uncertain" });
    expect((await pending.decision).status).toBe("redact-uncertain");
    const none = await s.request({ ...image(), uncertain: [] });
    const tab = await open(none.url);
    expect((await call(tab.page, { headers: { cookie: tab.cookie } })).body.toString()).not.toContain("redact-uncertain");
    expect((await submit(tab, { decision: "redact-uncertain" })).status).toBe(400);
  });

  it("refuses an image request without a real size", async () => {
    await expect(server().request({ ...image(), width: 0 })).rejects.toThrow(/width and height/);
    await expect(server().request({ ...image(), uncertain: [{ x0: Number.NaN, y0: 0, x1: 1, y1: 1 }] })).rejects.toThrow(/not a number/);
  });

  it("asks to check an input again when the user lists values still in clear, keeping the button pressed", async () => {
    const s = server();
    const pending = await s.request({ kind: "input", title: "Call notes", content: "[PERSON_1] met Tom Baker.", counts: { PERSON: 1 } });
    const tab = await open(pending.url);
    const html = (await call(tab.page, { headers: { cookie: tab.cookie } })).body.toString();
    expect(html).toContain("<mark>[PERSON_1]</mark> met Tom Baker.");
    await submit(tab, { decision: "approved", missed: "Tom Baker\r\n\r\n Tom Baker \nACME-secret" });
    expect(await pending.decision).toMatchObject({ status: "revise", choice: "approved", missed: ["Tom Baker", "ACME-secret"] });
    expect((await call(tab.page, { headers: { cookie: tab.cookie } })).body.toString()).toContain("asked to check again");
  });

  it("confirms a scope: the ticked objects among those offered, and typed ones that look like API names", async () => {
    const s = server();
    const pending = await s.request({
      kind: "scope",
      title: "renewals",
      source: "org:00D000000000001AAA",
      reason: "[PERSON_1] asked for <renewals>",
      proposed: [{ name: "Policy__c", label: 'Policy <"&>', detail: "3 fields, 1 <flow>" }],
      suggested: [{ name: "Claim__c", detail: "1 link: Flow Open_Claim (writes)" }],
    });
    const tab = await open(pending.url);
    const html = (await call(tab.page, { headers: { cookie: tab.cookie } })).body.toString();
    expect(html).toContain('name="object" value="Policy__c" checked>');
    expect(html).toContain('name="object" value="Claim__c">');
    expect(html).toContain("<mark>[PERSON_1]</mark> asked for &#60;renewals&#62;");
    expect(html).toContain("Policy &#60;&#34;&#38;&#62;");
    expect(html).toContain("3 fields, 1 &#60;flow&#62;");
    expect(html).not.toMatch(/<script|style="/i);
    const page = await call(tab.page, { headers: { cookie: tab.cookie } });
    const body = `csrf=${encodeURIComponent(csrfOf(page.body.toString()))}&decision=approved&object=Claim__c&object=Evil__c&added=${encodeURIComponent("Account, Claim__c; Invoice__c <x> 1bad")}`;
    const posted = await call(tab.page, { method: "POST", body, headers: { origin: s.origin!, cookie: tab.cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" } });
    expect(posted.status).toBe(303);
    expect(await pending.decision).toEqual({ status: "approved", choice: "approved", missed: [], selected: ["Claim__c"], added: ["Account", "Invoice__c"], digest: pending.digest });
  });

  it("confirms requirements: ticked items among those offered, known priorities, and typed lines", async () => {
    const s = server();
    const pending = await s.request({
      kind: "requirements",
      title: "renewals",
      items: [
        { key: "R1", id: "R1", kind: "functional", priority: "must", statement: "Send <the> letter", sources: ["Notes & more"], note: "Changed" },
        { key: "n1", kind: "compliance", priority: "could", statement: "Keep [SECRET_1] safe", sources: [], note: "New" },
      ],
      warnings: ["new 1: <b>vague</b>"],
    });
    const tab = await open(pending.url);
    const html = (await call(tab.page, { headers: { cookie: tab.cookie } })).body.toString();
    expect(html).toContain('name="item" value="R1" checked>');
    expect(html).toContain('<code>R1</code> Send &#60;the&#62; letter');
    expect(html).toContain("from Notes &#38; more");
    expect(html).toContain("<mark>[SECRET_1]</mark>");
    expect(html).toContain('<option value="could" selected>');
    expect(html).toContain("new 1: &#60;b&#62;vague&#60;/b&#62;");
    expect(html).not.toMatch(/<script|style="/i);
    const page = await call(tab.page, { headers: { cookie: tab.cookie } });
    const lines = ["Send a reminder", "", "Send a reminder", "ok", "okay", "x".repeat(1_200)].join("\r\n");
    const body = `csrf=${encodeURIComponent(csrfOf(page.body.toString()))}&decision=approved&item=n1&item=R9&priority-R1=wont&priority-n1=urgent&priority-R9=must&added=${encodeURIComponent(lines)}`;
    const posted = await call(tab.page, { method: "POST", body, headers: { origin: s.origin!, cookie: tab.cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" } });
    expect(posted.status).toBe(303);
    expect(await pending.decision).toEqual({ status: "approved", choice: "approved", missed: [], selected: ["n1"], priorities: { R1: "wont" }, lines: ["Send a reminder", "x".repeat(1_000)], digest: pending.digest });
  });

  it("expires requests that wait too long, are cancelled, or are open when the server closes", async () => {
    const s = server({ timeoutMs: 50 });
    const late = await s.request(publish);
    expect(await late.decision).toMatchObject({ status: "expired", missed: [] });
    const s2 = server({ timeoutMs: 2 ** 40 });
    const cancelled = await s2.request(publish);
    cancelled.cancel();
    expect((await cancelled.decision).status).toBe("expired");
    const open2 = await s2.request(publish);
    await s2.close();
    expect((await open2.decision).status).toBe("expired");
    await expect(s2.request(publish)).rejects.toThrow(/closed/);
  });

  it("closes at once even while a form is half sent", async () => {
    const s = server();
    const pending = await s.request(publish);
    const tab = await open(pending.url);
    const url = new URL(tab.page);
    const socket = new Socket();
    await new Promise<void>((r) => socket.connect(Number(url.port), "127.0.0.1", r));
    socket.on("error", () => {});
    socket.write(`POST ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${url.origin}\r\nCookie: ${tab.cookie}\r\nContent-Length: 100\r\n\r\ncsrf=`);
    await new Promise((r) => setTimeout(r, 50));
    const started = performance.now();
    await s.close();
    expect(performance.now() - started).toBeLessThan(1000);
    socket.destroy();
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
    const link = `http://127.0.0.1:1/a/${"x".repeat(32)}?k=${"y".repeat(32)}`;
    const node = { file: process.execPath, args: () => ["-e", ""] };
    expect(await openInBrowser("https://example.com/", node)).toBe(false);
    expect(await openInBrowser("http://127.0.0.1:1/other", node)).toBe(false);
    // null, not undefined: undefined would take the real browser.
    expect(await openInBrowser(link, null)).toBe(false);
    expect(await openInBrowser(link, node)).toBe(true);
    expect(await openInBrowser(link, { file: "/no/such/program", args: () => [] })).toBe(false);
  });
});
