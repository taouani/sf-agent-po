// Stands in for the user at the approval pages during an evaluation run: the input review, the
// requirements and the scope. The v1 server opens each page with the program in
// SF_AGENT_PO_BROWSER; for the evaluation that program (opener.ts) hands the address to the
// runner, which loads the page and approves it as a person would, with what the page proposes.
// The server has no bypass: without the page, nothing is approved.

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

/** One page the runner answered. */
export interface ApprovalRecord {
  /** The label of the button it pressed, e.g. "Confirm the requirements", or the page's title when it failed. */
  page: string;
  ok: boolean;
  error?: string;
}

/** The approval pages' addresses, as the server opens them. */
const PAGE_LINK = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/a\/[\w-]{32}\?k=[\w-]+$/;

/** The approval decision each kind of page offers. */
const APPROVE = "approved";

export class Approver {
  readonly records: ApprovalRecord[] = [];
  private readonly pending = new Set<Promise<void>>();
  private hook?: Server;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Answers the page at `url`, in the background; false when it is not an approval page. */
  open(url: string): boolean {
    if (!PAGE_LINK.test(url)) return false;
    // Recorded when the page opens, and completed when it is answered: the server may return to
    // the agent before this side hears back from the form.
    const record: ApprovalRecord = { page: "approval page", ok: false };
    this.records.push(record);
    const p = approvePage(url, this.fetchImpl).then(
      (page) => Object.assign(record, { page, ok: true }),
      (err: unknown) => Object.assign(record, { error: err instanceof Error ? err.message : String(err) }),
    ).then(() => undefined);
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
    return true;
  }

  /**
   * Listens for the addresses the opener program sends, and returns the environment that makes a
   * v1 server open its pages with that program.
   */
  async listen(opener = openerPath()): Promise<Record<string, string>> {
    const token = randomBytes(16).toString("hex");
    const server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== `/${token}`) return void res.writeHead(404).end();
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const opened = this.open(Buffer.concat(chunks).toString("utf8").trim());
        res.writeHead(opened ? 204 : 400).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.hook = server;
    const { port } = server.address() as { port: number };
    return { SF_AGENT_PO_BROWSER: JSON.stringify([process.execPath, opener]), SF_AGENT_EVAL_APPROVER: `http://127.0.0.1:${port}/${token}` };
  }

  /** Waits for the pages being answered, then stops listening. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    await new Promise<void>((resolve) => (this.hook ? this.hook.close(() => resolve()) : resolve()));
  }
}

/** The opener program next to this file: dist/opener.js once built. */
export function openerPath(): string {
  return fileURLToPath(new URL(`./opener${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url));
}

/**
 * Loads an approval page from its single-use link and presses its approve button, leaving every
 * field as the page shows it (proposed items ticked, priorities as proposed, nothing typed).
 * Returns the button's label.
 */
export async function approvePage(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const origin = new URL(url).origin;
  const launch = await fetchImpl(url, { redirect: "manual" });
  const cookie = launch.headers.get("set-cookie")?.split(";")[0];
  const location = launch.headers.get("location");
  if (launch.status !== 303 || !cookie || !location) throw new Error(`The approval link answered ${launch.status}.`);
  const pageUrl = new URL(location, origin);
  const page = await fetchImpl(pageUrl, { headers: { cookie } });
  if (page.status !== 200) throw new Error(`The approval page answered ${page.status}.`);
  const form = parseForm(await page.text());
  const button = form.buttons.find((b) => b.value === APPROVE);
  if (!button) throw new Error(`The approval page has no "${APPROVE}" button.`);
  const body = new URLSearchParams([...form.fields, [button.name, button.value]]);
  const sent = await fetchImpl(new URL(form.action, pageUrl), {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (sent.status !== 303) throw new Error(`Approving the page answered ${sent.status}: ${(await sent.text()).slice(0, 200)}`);
  return button.label;
}

export interface ParsedForm {
  action: string;
  /** What the browser would send for the fields, in order: hidden and text inputs, ticked boxes, selected options, text areas. */
  fields: [string, string][];
  buttons: { name: string; value: string; label: string }[];
}

/** Reads the one form of an approval page, the way a browser would submit it untouched. */
export function parseForm(html: string): ParsedForm {
  const form = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) throw new Error("The approval page has no form.");
  const action = attrs(form[1]!).action ?? "";
  const body = form[2]!;
  const fields: [string, string][] = [];
  const buttons: ParsedForm["buttons"] = [];
  // In document order, as a browser collects them.
  for (const m of body.matchAll(/<(input|textarea|select|button)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/gi)) {
    const tag = m[1]!.toLowerCase();
    const a = attrs(m[2]!);
    if (!a.name || "disabled" in a) continue;
    if (tag === "button") buttons.push({ name: a.name, value: a.value ?? "", label: text(m[3] ?? "") });
    else if (tag === "textarea") fields.push([a.name, unescape(m[3] ?? "")]);
    else if (tag === "select") {
      const options = [...(m[3] ?? "").matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((o) => ({ a: attrs(o[1]!), label: text(o[2]!) }));
      const chosen = options.find((o) => "selected" in o.a) ?? options[0];
      if (chosen) fields.push([a.name, chosen.a.value ?? chosen.label]);
    } else {
      const type = (a.type ?? "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if ("checked" in a) fields.push([a.name, a.value ?? "on"]);
      } else if (!["submit", "button", "image", "reset", "file"].includes(type)) fields.push([a.name, a.value ?? ""]);
    }
  }
  return { action, fields, buttons };
}

function attrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)")?/g)) out[m[1]!.toLowerCase()] = unescape(m[2] ?? "");
  return out;
}

const text = (html: string) => unescape(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

function unescape(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(Number(k.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[k]!;
  });
}
