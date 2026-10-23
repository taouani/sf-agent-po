import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
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
    docs.push(parseDocument(file, await readFile(file, "utf8"), kind));
  }
  return docs;
}

export function parseDocument(file: string, raw: string, kind?: DocumentKind): NewDocument {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".eml" || (kind === "email" && looksLikeEmail(raw))) {
    return parseEmail(file, raw, kind);
  }
  const content = ext === ".html" || ext === ".htm" ? htmlToText(raw) : raw;
  return {
    kind: kind ?? "other",
    title: firstHeading(content) ?? path.basename(file),
    source: path.resolve(file),
    content,
  };
}

/** Builds a document from text pasted directly into the conversation. */
export function textDocument(title: string, content: string, kind: DocumentKind): NewDocument {
  return { kind, title, source: `inline:${title}`, content };
}

function looksLikeEmail(raw: string): boolean {
  return /^(from|subject|to|date):/im.test(raw.slice(0, 2000));
}

/** Minimal RFC 822 parsing: headers we care about plus the plain-text body. */
export function parseEmail(file: string, raw: string, kind?: DocumentKind): NewDocument {
  const normalised = raw.replace(/\r\n/g, "\n");
  const split = normalised.indexOf("\n\n");
  const headerBlock = split === -1 ? normalised : normalised.slice(0, split);
  const body = split === -1 ? "" : normalised.slice(split + 2);

  const headers: Record<string, string> = {};
  let last = "";
  for (const line of headerBlock.split("\n")) {
    if (/^\s/.test(line) && last) {
      headers[last] += " " + line.trim();
      continue;
    }
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) {
      last = m[1].toLowerCase();
      headers[last] = m[2];
    }
  }

  const subject = headers["subject"] ?? path.basename(file);
  return {
    kind: kind ?? "email",
    title: subject,
    source: path.resolve(file),
    content: extractPlainBody(body, headers["content-type"]),
    metadata: { from: headers["from"], to: headers["to"], cc: headers["cc"], date: headers["date"], subject },
  };
}

function extractPlainBody(body: string, contentType = ""): string {
  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
  if (!boundary) return /text\/html/i.test(contentType) ? htmlToText(body) : body.trim();
  const parts = body.split(`--${boundary}`);
  const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p));
  const html = parts.find((p) => /content-type:\s*text\/html/i.test(p));
  const pick = plain ?? html;
  if (!pick) return body.trim();
  const partBody = pick.replace(/\r\n/g, "\n").split("\n\n").slice(1).join("\n\n").trim();
  return plain ? partBody : htmlToText(partBody);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
