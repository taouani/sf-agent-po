import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import PostalMime, { type Address } from "postal-mime";
import type { DocumentKind, NewDocument } from "@sf-agent-po/core";
export { htmlToText } from "./html.js";
import { htmlToText } from "./html.js";
import { readCsv } from "./readers/csv.js";
import { readDrawio } from "./readers/drawio.js";
import { readDocx, readPptx, readXlsx, type ReadResult } from "./readers/office.js";
import { readPdf } from "./readers/pdf.js";

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".eml", ".json", ".html", ".htm"]);

/** Formats read into text, by extension. */
const READERS: Record<string, (raw: Buffer) => ReadResult | Promise<ReadResult>> = {
  ".pdf": readPdf,
  ".docx": readDocx,
  ".docm": readDocx,
  ".pptx": readPptx,
  ".pptm": readPptx,
  ".xlsx": readXlsx,
  ".xlsm": readXlsx,
  ".csv": (raw) => readCsv(decodeText(raw)),
  ".tsv": (raw) => readCsv(decodeText(raw), "\t"),
  ".drawio": (raw) => readDrawio(raw.toString("utf8")),
  ".dio": (raw) => readDrawio(raw.toString("utf8")),
};

/**
 * Text whose encoding is not declared, such as a CSV export: a byte order mark decides, else
 * UTF-8 if the bytes are valid UTF-8, else Windows-1252 (what Excel writes on Windows).
 */
export function decodeText(raw: Uint8Array): string {
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return new TextDecoder("utf-8").decode(raw.subarray(3));
  if (raw[0] === 0xff && raw[1] === 0xfe) return new TextDecoder("utf-16le").decode(raw.subarray(2));
  if (raw[0] === 0xfe && raw[1] === 0xff) return new TextDecoder("utf-16be").decode(raw.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return new TextDecoder("windows-1252").decode(raw);
  }
}

/** Files larger than this are not read. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** The extensions loadLocalDocuments reads. */
export const READABLE_EXTENSIONS: readonly string[] = [...TEXT_EXTENSIONS, ...Object.keys(READERS), ".drawio.xml"].sort();

const extensionOf = (file: string) => {
  const lower = file.toLowerCase();
  return lower.endsWith(".drawio.xml") ? ".drawio" : path.extname(lower);
};

/** A file of a folder that could not be read. */
export interface LoadError {
  file: string;
  message: string;
}

/**
 * Loads meeting notes, emails, PI planning exports and other local files.
 * A directory is loaded recursively. When `kind` is omitted it is inferred
 * from the file (an .eml file is an email, everything else is "other").
 * A file that cannot be read stops the load, unless `errors` is given: then
 * the other files of a folder are still loaded and each failure is added to
 * `errors`. A single file always throws.
 */
export async function loadLocalDocuments(target: string, kind?: DocumentKind, opts: { errors?: LoadError[] } = {}): Promise<NewDocument[]> {
  const info = await stat(target);
  const folder = info.isDirectory();
  const files = folder ? await listFiles(target) : [target];
  const docs: NewDocument[] = [];
  for (const file of files) {
    const ext = extensionOf(file);
    if (!TEXT_EXTENSIONS.has(ext) && !READERS[ext]) continue;
    try {
      const size = (await stat(file)).size;
      if (size > MAX_FILE_BYTES) throw new Error(`${path.basename(file)} is ${Math.round(size / 2 ** 20)} MB; files over ${MAX_FILE_BYTES / 2 ** 20} MB are not read.`);
      docs.push(await parseDocument(file, await readFile(file), kind));
    } catch (err) {
      if (!folder || !opts.errors) throw err;
      opts.errors.push({ file, message: (err as Error).message });
    }
  }
  return docs;
}

export async function parseDocument(file: string, raw: Buffer, kind?: DocumentKind): Promise<NewDocument> {
  const ext = extensionOf(file);
  const reader = READERS[ext];
  if (reader) {
    let read: ReadResult;
    try {
      read = await reader(raw);
    } catch (err) {
      throw new Error(`Could not read ${path.basename(file)}: ${(err as Error).message}`);
    }
    return {
      kind: kind ?? "other",
      title: read.title?.trim() || path.basename(file),
      source: path.resolve(file),
      content: read.content,
      metadata: { format: ext.slice(1), ...read.metadata },
    };
  }
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

function firstHeading(content: string): string | undefined {
  return content.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
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
