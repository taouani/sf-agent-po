// The approval page (AR5): a small server on 127.0.0.1 where the user, not the model, approves
// what the agents write and checks what they read. Each request has its own unguessable
// address; the page is plain HTML forms with no script.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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

export type ApprovalRequest = PublishRequest | ImageRequest | InputRequest;

/**
 * What the user decided. `revise`: the user listed values still in clear (`missed`); hide
 * them (Masker.remember) and ask again. `text-only`: use an image's text, not the image.
 */
export interface Decision {
  status: "approved" | "rejected" | "revise" | "text-only" | "expired";
  missed: string[];
  comment?: string;
}

/** A request waiting on the page. Give `url` to the user only, never to the model: whoever opens it can decide. */
export interface PendingApproval {
  id: string;
  url: string;
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

const STATUSES: Record<ApprovalRequest["kind"], readonly Decision["status"][]> = {
  publish: ["approved", "rejected"],
  image: ["approved", "text-only", "rejected"],
  input: ["approved", "rejected"],
};

const MAX_FORM = 64 * 1024;
const MAX_MISSED = 200;

interface Entry {
  req: ApprovalRequest;
  csrf: string;
  finish: (d: Decision) => void;
  timer: NodeJS.Timeout;
  done?: Decision["status"];
}

const token = (bytes = 24) => randomBytes(bytes).toString("base64url");

export class ApprovalServer {
  private server?: Server;
  private port = 0;
  private starting?: Promise<void>;
  private readonly entries = new Map<string, Entry>();
  private readonly timeoutMs: number;

  constructor(private readonly opts: ApprovalServerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 30 * 60_000;
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

  /** Puts a request on the page and returns its address and the user's decision to come. */
  async request(req: ApprovalRequest): Promise<PendingApproval> {
    await this.start();
    const id = token();
    let resolve!: (d: Decision) => void;
    const decision = new Promise<Decision>((r) => (resolve = r));
    const finish = (d: Decision) => {
      const entry = this.entries.get(id);
      if (!entry || entry.done) return;
      clearTimeout(entry.timer);
      entry.done = d.status;
      // The decided request stays a little while, so a reload shows its outcome, then goes.
      setTimeout(() => this.entries.delete(id), 60_000).unref();
      resolve(d);
    };
    const timer = setTimeout(() => finish({ status: "expired", missed: [] }), this.timeoutMs);
    timer.unref();
    this.entries.set(id, { req: { ...req }, csrf: token(), finish, timer });
    return { id, url: `${this.origin}/a/${id}`, decision, cancel: () => finish({ status: "expired", missed: [] }) };
  }

  /** Stops the server; requests still open expire. */
  async close(): Promise<void> {
    for (const e of [...this.entries.values()]) e.finish({ status: "expired", missed: [] });
    this.entries.clear();
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const nonce = token(16);
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": `default-src 'none'; img-src 'self'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    };
    const send = (status: number, body: string | Uint8Array, type = "text/html; charset=utf-8") => {
      res.writeHead(status, { ...headers, "content-type": type });
      res.end(body);
    };
    // A web page elsewhere could reach this port through a name that resolves to 127.0.0.1
    // (DNS rebinding); it then sends its own Host, which is refused.
    if (req.headers.host !== `127.0.0.1:${this.port}` && req.headers.host !== `localhost:${this.port}`) return send(421, "Wrong host.", "text/plain");

    const match = /^\/a\/([\w-]{32})(\/image\.png)?$/.exec((req.url ?? "").split("?")[0]!);
    const entry = match ? this.entries.get(match[1]!) : undefined;
    if (!match || !entry) return send(404, donePage("gone", nonce));
    const action = `/a/${match[1]}`;

    if (match[2]) {
      if (req.method !== "GET" || entry.req.kind !== "image" || entry.done) return send(404, "Not found.", "text/plain");
      return send(200, entry.req.image, "image/png");
    }
    if (req.method === "GET") return send(200, entry.done ? donePage(entry.done, nonce) : requestPage(entry.req, { action, csrf: entry.csrf, imageUrl: `${action}/image.png`, nonce }));
    if (req.method !== "POST") return send(405, "Method not allowed.", "text/plain");

    // A form posted from another site is refused: browsers send where a post comes from.
    const from = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    if (!from || (from !== `http://127.0.0.1:${this.port}` && from !== `http://localhost:${this.port}`) || (site && site !== "same-origin")) return send(403, "This form can only be sent from its own page.", "text/plain");
    if (entry.done) return send(409, donePage(entry.done, nonce));

    const form = await readForm(req);
    if (!form) return send(413, "The form is too large.", "text/plain");
    if (form.get("csrf") !== entry.csrf) return send(403, "This form is out of date. Reload the page.", "text/plain");
    const status = form.get("decision") as Decision["status"];
    if (!STATUSES[entry.req.kind].includes(status)) return send(400, "Unknown decision.", "text/plain");
    const missed = [...new Set((form.get("missed") ?? "").split(/\r?\n/).map((v) => v.trim()).filter(Boolean))].slice(0, MAX_MISSED);
    const comment = form.get("comment")?.trim() || undefined;
    // Values still in clear come first: whatever was chosen, the input is checked again once they are hidden.
    const decided: Decision = { status: missed.length && status !== "rejected" ? "revise" : status, missed, ...(comment ? { comment } : {}) };
    entry.finish(decided);
    // Post, then redirect: a reload does not send the form again.
    res.writeHead(303, { ...headers, location: action });
    res.end();
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
