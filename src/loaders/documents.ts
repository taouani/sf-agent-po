import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import PostalMime, { type Address } from "postal-mime";
import type { DocumentKind } from "../context/types.js";
import type { NewDocument } from "../context/store.js";

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".eml", ".csv", ".json", ".html", ".htm"]);

/**
 * Loads meeting notes, emails, PI planning exports and other local files.
 * A directory is loaded recursively. When `kind` is omitted it is inferred
 * from the file (an .eml file is an email, everything else is "other").
 */
export async function loadLocalDocuments(target: string, kind?: DocumentKind): Promise<NewDocument[]> {
  const info = await stat(target);
  const files = info.isDirectory() ? await listFiles(target) : [target];
  const docs: NewDocument[] = [];
  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    docs.push(await parseDocument(file, await readFile(file), kind));
  }
  return docs;
}

export async function parseDocument(file: string, raw: Buffer, kind?: DocumentKind): Promise<NewDocument> {
  const ext = path.extname(file).toLowerCase();
  const text = raw.toString("utf8");
  if (ext === ".eml" || (kind === "email" && looksLikeEmail(text))) {
    return parseEmail(file, raw, kind);
  }
  const content = ext === ".html" || ext === ".htm" ? htmlToText(text) : text;
  return {
    kind: kind ?? "other",
    title: firstHeading(content) ?? path.basename(file),
    source: path.resolve(file),
    content,
  };
}

/**
 * Builds a document from text pasted directly into the conversation. The
 * source includes a content hash so two pastes with the same title are kept
 * apart, while pasting identical text again replaces the earlier copy.
 */
export function textDocument(title: string, content: string, kind: DocumentKind): NewDocument {
  const hash = createHash("sha1").update(content).digest("hex").slice(0, 8);
  return { kind, title, source: `inline:${title}#${hash}`, content };
}

function looksLikeEmail(raw: string): boolean {
  return /^(from|subject|to|date):/im.test(raw.slice(0, 2000));
}

/**
 * Parses an RFC 822 message, including multipart bodies, attachments,
 * quoted-printable/base64 transfer encodings and encoded subjects.
 */
export async function parseEmail(file: string, raw: Buffer | string, kind?: DocumentKind): Promise<NewDocument> {
  const email = await PostalMime.parse(raw);
  const subject = email.subject ?? path.basename(file);
  const body = email.text?.trim() || (email.html ? htmlToText(email.html) : "");
  const attachments = email.attachments.map((a) => a.filename).filter((f): f is string => !!f);
  return {
    kind: kind ?? "email",
    title: subject,
    source: path.resolve(file),
    content: body,
    metadata: {
      from: formatAddresses(email.from ? [email.from] : undefined),
      to: formatAddresses(email.to),
      cc: formatAddresses(email.cc),
      date: email.date,
      subject,
      ...(attachments.length ? { attachments } : {}),
    },
  };
}

function formatAddresses(list: Address[] | undefined): string | undefined {
  if (!list?.length) return undefined;
  const mailboxes = list.flatMap((a) => (a.group ? a.group : [a]));
  return mailboxes.map((m) => (m.name ? `${m.name} <${m.address}>` : m.address)).join(", ");
}

export function htmlToText(html: string): string {
  return (
    html
      // Confluence code macros wrap their body in CDATA; keep it verbatim.
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, code: string) => `\n${code}\n`.replace(/</g, "&lt;").replace(/>/g, "&gt;"))
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Decode &amp; last so "&amp;lt;" becomes "&lt;", not "<".
      .replace(/&amp;/g, "&")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function firstHeading(content: string): string | undefined {
  return content.match(/^#{1,3}\s+(.+)$/m)?.[1].trim();
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out.sort();
}
