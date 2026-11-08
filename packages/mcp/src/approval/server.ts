// The approval page (AR5): a small server on 127.0.0.1 where the user, not the model, approves
// what the agents write and checks what they read. The page is plain HTML forms with no
// script.
//
// Each request is opened once through a single-use link, which the browser trades for a
// cookie that only it holds; every later page, image and form needs that cookie. A link seen
// elsewhere (a process list, the browser's history) is then worth nothing, and a second use
// of it withdraws the request, since someone else had it.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { REQUIREMENT_PRIORITIES, type RequirementKind, type RequirementPriority } from "@sf-agent-po/core";
import { donePage, requestPage } from "./page.js";

/** A rectangle in image pixels (x1 and y1 exclusive), as the masking reports it. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A write to approve: the real values, as they will be written. */
export interface PublishRequest {
  kind: "publish";
  /** Where it goes, for example "Jira ACME-12 (update)". */
  target: string;
  title: string;
  /** The body, unmasked. */
  body: string;
  /** Pseudonyms left in the body (secrets, unknown labels), from Masker.unmask. */
  kept?: readonly string[];
}

/** A redacted image to confirm before a model sees it (FE4), from Masker.maskImage. */
export interface ImageRequest {
  kind: "image";
  title: string;
  /** The redacted PNG. */
  image: Uint8Array;
  width: number;
  height: number;
  /** The masked OCR text. */
  text: string;
  /** False when the OCR read the page poorly. */
  trusted: boolean;
  /** Words left visible that the OCR was unsure of, outlined on the page. */
  uncertain: readonly Box[];
  counts?: Record<string, number>;
}

/** A masked input to check before the agents use it (masked-input review). */
export interface InputRequest {
  kind: "input";
  title: string;
  /** The masked content. */
  content: string;
  counts?: Record<string, number>;
}

/**
 * The scope of a piece of work to confirm (decision SC): the objects the agent proposed,
 * ticked, and objects they touch, not ticked. Names and labels are the org's own, in clear:
 * the page is only in the user's browser.
 */
export interface ScopeRequest {
  kind: "scope";
  /** The requirement context. */
  title: string;
  /** The indexed source, "org:00D..." or "repo:name#hash". */
  source: string;
  /** Why the agent proposes these objects, masked. */
  reason?: string;
  proposed: ScopeChoice[];
  suggested: ScopeChoice[];
}

export interface ScopeChoice {
  /** The object's API name. */
  name: string;
  label?: string;
  /** What comes with it, or why it is suggested: "12 fields, 2 flows" or "written by Flow X". */
  detail: string;
}

/**
 * The requirements of a context to confirm (decision D1): what the agent extracted from the
 * inputs, with the real values, and the requirements kept from before. The user unticks what
 * is wrong, changes priorities and types in what is missing.
 */
export interface RequirementsRequest {
  kind: "requirements";
  /** The requirement context. */
  title: string;
  items: RequirementItem[];
  /** What the checks found, for the user to weigh. */
  warnings: string[];
}

export interface RequirementItem {
  /** The form key: the requirement's id ("R3"), or "n1", "n2"... for a new one. */
  key: string;
  /** The requirement's id, once it has one. */
  id?: string;
  kind: RequirementKind;
  priority: RequirementPriority;
  statement: string;
  /** The titles of the documents it comes from. */
  sources: string[];
  /** "New", "Changed", "Unchanged", "Kept from before"... */
  note: string;
}

export type ApprovalRequest = PublishRequest | ImageRequest | InputRequest | ScopeRequest | RequirementsRequest;

/**
 * What the user decided.
 * - `revise`: the user listed values still in clear (`missed`). Hide them (Masker.declare),
 *   mask the input again and ask again; `choice` is the button the user pressed.
 * - `text-only`: use an image's masked text, not the image.
 * - `redact-uncertain`: black out the words the OCR was unsure of too (maskImage's
 *   `redactUncertain`), then ask again.
 * `digest` names the content the user saw (requestDigest): use only content with that digest.
 * `comment` is the user's own words, in clear: mask it before a model sees it.
 */
export interface Decision {
  status: "approved" | "rejected" | "revise" | "text-only" | "redact-uncertain" | "expired";
  choice?: "approved" | "rejected" | "text-only" | "redact-uncertain";
  missed: string[];
  comment?: string;
  /** For a scope: the objects the user kept ticked, among those offered. For requirements: the keys of the items kept ticked. */
  selected?: string[];
  /** For a scope: other objects the user typed, as API names (not checked against the index here). */
  added?: string[];
  /** For requirements: the priority the user chose for each item, by key. */
  priorities?: Record<string, RequirementPriority>;
  /** For requirements: the requirements the user typed, one per line, in clear. */
  lines?: string[];
  digest: string;
}

/**
 * A request waiting on the page. `url` works once: open it with openInBrowser and never give
 * it to the model, since whoever opens it first can decide.
 */
export interface PendingApproval {
  id: string;
  url: string;
  /** The digest of what the page shows (requestDigest). */
  digest: string;
  decision: Promise<Decision>;
  /** Withdraws the request; its decision becomes "expired". */
  cancel(): void;
}

export interface ApprovalServerOptions {
  /** How long a request waits before it expires; 30 minutes by default. */
  timeoutMs?: number;
  /** The port to listen on; a free one by default. */
  port?: number;
}

const CHOICES: Record<ApprovalRequest["kind"], readonly NonNullable<Decision["choice"]>[]> = {
  publish: ["approved", "rejected"],
  image: ["approved", "text-only", "redact-uncertain", "rejected"],
  input: ["approved", "rejected"],
  scope: ["approved", "rejected"],
  requirements: ["approved", "rejected"],
};

/** Objects a user can type in on a scope page. */
const MAX_ADDED = 50;
const API_NAME = /^[A-Za-z][\w.]{0,120}$/;
/** Requirements a user can type in on a requirements page, and how long each can be. */
export const MAX_TYPED_LINES = 50;
export const MAX_LINE = 1_000;

const MAX_FORM = 64 * 1024;
const MAX_MISSED = 200;
const MAX_TIMEOUT = 2 ** 31 - 1;

/** Stable JSON: object keys sorted, bytes as base64. */
function stable(value: unknown): string {
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"));
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** A SHA-256 of a request's content, to check that what is used is what the user saw. */
export function requestDigest(req: ApprovalRequest): string {
  return createHash("sha256").update(stable(req)).digest("hex");
}

/** A copy the caller cannot change afterwards: the page shows exactly what was asked. */
function snapshot(req: ApprovalRequest): ApprovalRequest {
  if (req.kind !== "image") return structuredClone(req);
  const { image, ...rest } = req;
  return { ...structuredClone(rest), image: image.slice() };
}

function validate(req: ApprovalRequest): void {
  if (req.kind !== "image") return;
  for (const v of [req.width, req.height]) if (!Number.isInteger(v) || v <= 0) throw new Error("An image request needs its width and height in pixels.");
  for (const b of req.uncertain) if (![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite)) throw new Error("An uncertain box has a coordinate that is not a number.");
}

const same = (a: string | undefined, b: string) => a !== undefined && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

interface Entry {
  req: ApprovalRequest;
  digest: string;
  csrf: string;
  /** The single-use link token; undefined once used. */
  launch?: string;
  /** What the browser that used the link holds. */
  session: string;
  finish: (d: Omit<Decision, "digest">) => void;
  timer: NodeJS.Timeout;
  done?: Decision["status"];
}

const token = (bytes = 24) => randomBytes(bytes).toString("base64url");

export class ApprovalServer {
  private server?: Server;
  private port = 0;
  private starting?: Promise<void>;
  private closed = false;
  private readonly entries = new Map<string, Entry>();
  private readonly timeoutMs: number;

  constructor(private readonly opts: ApprovalServerOptions = {}) {
    this.timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 30 * 60_000, 1), MAX_TIMEOUT);
  }

  /** The page's origin once started, such as "http://127.0.0.1:53412". */
  get origin(): string | undefined {
    return this.server ? `http://127.0.0.1:${this.port}` : undefined;
  }

  private start(): Promise<void> {
    this.starting ??= new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
          res.end("Something went wrong.");
        });
      });
      // A slow or stalled client does not hold the page (or close()) for minutes.
      server.requestTimeout = 15_000;
      server.headersTimeout = 10_000;
      server.once("error", reject);
      // Only this computer can reach it.
      server.listen(this.opts.port ?? 0, "127.0.0.1", () => {
        this.port = (server.address() as AddressInfo).port;
        this.server = server;
        // An idle page server does not keep the process alive.
        server.unref();
        resolve();
      });
    });
    return this.starting;
  }

  /** Puts a request on the page and returns its single-use link and the user's decision to come. */
  async request(req: ApprovalRequest): Promise<PendingApproval> {
    if (this.closed) throw new Error("The approval page is closed.");
    validate(req);
    const shown = snapshot(req);
    const digest = requestDigest(shown);
    await this.start();
    if (this.closed) throw new Error("The approval page is closed.");
    const id = token();
    let resolve!: (d: Decision) => void;
    const decision = new Promise<Decision>((r) => (resolve = r));
    const finish = (d: Omit<Decision, "digest">) => {
      const entry = this.entries.get(id);
      if (!entry || entry.done) return;
      clearTimeout(entry.timer);
      entry.done = d.status;
      // The decided request stays a little while, so a reload shows its outcome, then goes.
      setTimeout(() => this.entries.delete(id), 60_000).unref();
      resolve({ ...d, digest });
    };
    const timer = setTimeout(() => finish({ status: "expired", missed: [] }), this.timeoutMs);
    timer.unref();
    const launch = token();
    this.entries.set(id, { req: shown, digest, csrf: token(), launch, session: token(), finish, timer });
    return { id, url: `${this.origin}/a/${id}?k=${launch}`, digest, decision, cancel: () => finish({ status: "expired", missed: [] }) };
  }

  /** Stops the server; requests still open expire, and no new ones are taken. */
  async close(): Promise<void> {
    this.closed = true;
    for (const e of [...this.entries.values()]) e.finish({ status: "expired", missed: [] });
    this.entries.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    const closing = new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections();
    await closing;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const nonce = token(16);
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // same-origin, not no-referrer: with no-referrer, browsers send "Origin: null" on the form's post.
      "referrer-policy": "same-origin",
      "x-frame-options": "DENY",
      "content-security-policy": `default-src 'none'; img-src 'self'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    };
    const send = (status: number, body: string | Uint8Array, type = "text/html; charset=utf-8", extra: Record<string, string> = {}) => {
      res.writeHead(status, { ...headers, "content-type": type, ...extra });
      res.end(body);
    };
    // A web page elsewhere could reach this port through a name that resolves to 127.0.0.1
    // (DNS rebinding); it then sends its own Host, which is refused.
    if (req.headers.host !== `127.0.0.1:${this.port}` && req.headers.host !== `localhost:${this.port}`) return send(421, "Wrong host.", "text/plain");

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = /^\/a\/([\w-]{32})(\/image\.png)?$/.exec(url.pathname);
    const entry = match ? this.entries.get(match[1]!) : undefined;
    if (!match || !entry) return send(404, donePage("gone", nonce));
    const action = `/a/${match[1]}`;

    // The single-use link: the browser that brings it gets the cookie; anyone after it withdraws the request.
    const launch = url.searchParams.get("k");
    if (launch !== null) {
      if (req.method !== "GET") return send(405, "Method not allowed.", "text/plain");
      if (entry.launch && same(launch, entry.launch)) {
        entry.launch = undefined;
        return send(303, "", "text/plain", { location: action, "set-cookie": `sfa=${entry.session}; Path=${action}; HttpOnly; SameSite=Strict` });
      }
      if (!entry.done) entry.finish({ status: "expired", missed: [] });
      return send(403, donePage("reused", nonce));
    }
    if (!same(cookie(req, "sfa"), entry.session)) return send(403, donePage("elsewhere", nonce));

    if (match[2]) {
      if (req.method !== "GET" || entry.req.kind !== "image" || entry.done) return send(404, "Not found.", "text/plain");
      return send(200, entry.req.image, "image/png");
    }
    if (req.method === "GET") return send(200, entry.done ? donePage(entry.done, nonce) : requestPage(entry.req, { action, csrf: entry.csrf, imageUrl: `${action}/image.png`, nonce }));
    if (req.method !== "POST") return send(405, "Method not allowed.", "text/plain");

    // A form posted from another site is refused: browsers say where a post comes from.
    const from = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    const ownOrigin = from === `http://127.0.0.1:${this.port}` || from === `http://localhost:${this.port}` || (from === "null" && site === "same-origin");
    if (!ownOrigin || (site && site !== "same-origin")) return send(403, "This form can only be sent from its own page.", "text/plain");
    if (entry.done) return send(409, donePage(entry.done, nonce));

    const form = await readForm(req);
    if (!form) return send(413, "The form is too large.", "text/plain");
    if (!same(form.get("csrf") ?? undefined, entry.csrf)) return send(403, "This form is out of date. Reload the page.", "text/plain");
    const choice = form.get("decision") as NonNullable<Decision["choice"]>;
    const offered = CHOICES[entry.req.kind].includes(choice) && !(choice === "redact-uncertain" && entry.req.kind === "image" && !entry.req.uncertain.length);
    if (!offered) return send(400, "Unknown decision.", "text/plain");
    const missed = [...new Set((form.get("missed") ?? "").split(/\r?\n/).map((v) => v.trim()).filter(Boolean))].slice(0, MAX_MISSED);
    const comment = form.get("comment")?.trim() || undefined;
    if (entry.req.kind === "scope") {
      const offered = new Set([...entry.req.proposed, ...entry.req.suggested].map((o) => o.name));
      const selected = [...new Set(form.getAll("object"))].filter((o) => offered.has(o));
      const added = [...new Set((form.get("added") ?? "").split(/[\s,;]+/).map((v) => v.trim()).filter((v) => API_NAME.test(v) && !offered.has(v)))].slice(0, MAX_ADDED);
      entry.finish({ status: choice, choice, missed: [], selected, added, ...(comment ? { comment } : {}) });
      return send(303, "", "text/plain", { location: action });
    }
    if (entry.req.kind === "requirements") {
      const keys = new Set(entry.req.items.map((i) => i.key));
      const selected = [...new Set(form.getAll("item"))].filter((k) => keys.has(k));
      const priorities: Record<string, RequirementPriority> = {};
      for (const k of keys) {
        const p = form.get(`priority-${k}`) as RequirementPriority | null;
        if (p && REQUIREMENT_PRIORITIES.includes(p)) priorities[k] = p;
      }
      const lines = [...new Set((form.get("added") ?? "").split(/\r?\n/).map((v) => v.trim().slice(0, MAX_LINE)).filter((v) => v.length >= 3))].slice(0, MAX_TYPED_LINES);
      entry.finish({ status: choice, choice, missed: [], selected, priorities, lines, ...(comment ? { comment } : {}) });
      return send(303, "", "text/plain", { location: action });
    }
    // Values still in clear come first: unless the input is rejected, it is checked again once they are hidden.
    entry.finish({ status: missed.length && choice !== "rejected" ? "revise" : choice, choice, missed, ...(comment ? { comment } : {}) });
    // Post, then redirect: a reload does not send the form again.
    send(303, "", "text/plain", { location: action });
  }
}

/** A url-encoded form body, or undefined if it is larger than MAX_FORM. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_FORM) return undefined;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
