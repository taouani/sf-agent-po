// Word, PowerPoint and Excel files as Markdown text: headings, lists and tables keep their
// shape, slides keep their numbers and notes, sheets keep their names.

import { attr, find, findAll, local, parseXml, relId, textOf, type XmlNode } from "./xml.js";
import { openZip, relationships, type ZipParts } from "./zip.js";

/** What a reader gives back: the text, and a title and metadata when the file has them. */
export interface ReadResult {
  content: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

/** Limits on how much of a table is kept, so one huge sheet does not drown everything else. */
export const TABLE_LIMITS = { rows: 2000, columns: 50, cell: 500 };

const rels = (zip: ZipParts, part: string) =>
  relationships(zip, part, (xml) =>
    findAll(parseXml(xml), "Relationship")
      .filter((r) => attr(r, "TargetMode") !== "External")
      .map((r) => ({ id: attr(r, "Id") ?? "", target: attr(r, "Target") ?? "", type: attr(r, "Type") ?? "" })),
  );

const xmlPart = (zip: ZipParts, part: string): XmlNode[] | undefined => {
  const xml = zip.text(part);
  return xml === undefined ? undefined : parseXml(xml);
};

/** A Markdown table; the first row is the header. Cells are cut to a sensible length. */
export function markdownTable(rows: readonly (readonly string[])[], note?: string): string {
  if (!rows.length) return "";
  const width = Math.min(TABLE_LIMITS.columns, Math.max(...rows.map((r) => r.length)));
  const cell = (s: string | undefined) => {
    const flat = (s ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
    return flat.length > TABLE_LIMITS.cell ? `${flat.slice(0, TABLE_LIMITS.cell)}…` : flat;
  };
  const line = (r: readonly string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(" | ")} |`;
  const kept = rows.slice(0, TABLE_LIMITS.rows + 1);
  const out = [line(kept[0]!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...kept.slice(1).map(line)];
  const cut: string[] = [];
  if (rows.length > kept.length) cut.push(`${rows.length - kept.length} more rows`);
  if (Math.max(...rows.map((r) => r.length)) > width) cut.push("more columns");
  if (cut.length || note) out.push("", `_${[...cut.map((c) => `${c} not shown`), note].filter(Boolean).join("; ")}._`);
  return out.join("\n");
}

/** Core document properties (docProps/core.xml): title and people. */
function coreProperties(zip: ZipParts): { title?: string; metadata: Record<string, unknown> } {
  const core = xmlPart(zip, "docProps/core.xml");
  if (!core) return { metadata: {} };
  const get = (name: string) => {
    const n = find(core, name);
    const t = n ? textOf(n).trim() : "";
    return t || undefined;
  };
  const metadata: Record<string, unknown> = {};
  for (const [key, name] of [["author", "creator"], ["lastModifiedBy", "lastModifiedBy"], ["created", "created"], ["modified", "modified"]] as const) {
    const v = get(name);
    if (v) metadata[key] = v;
  }
  return { title: get("title"), metadata };
}

// ---------------------------------------------------------------- Word

/** A paragraph's text: runs, tabs and breaks; deleted revisions and field codes are left out. */
function wordText(node: XmlNode): string {
  const name = local(node.tag);
  if (node.tag === "#text") return "";
  if (name === "t") return textOf(node);
  if (name === "tab") return "\t";
  if (name === "br" || name === "cr") return "\n";
  if (["del", "delText", "instrText", "rPr", "pPr"].includes(name)) return "";
  return node.children.map(wordText).join("");
}

function headingLevel(p: XmlNode): number | undefined {
  const pPr = p.children.find((c) => local(c.tag) === "pPr");
  const style = attr(pPr?.children.find((c) => local(c.tag) === "pStyle"), "val") ?? "";
  // Style ids by language: Heading1, Titre1, berschrift1 (Überschrift), Ttulo1 (Título), Titolo1.
  const m = /(?:heading|titre|berschrift|t[ií]?tulo|titolo)\s*(\d)$/i.exec(style);
  if (m) return Math.min(6, Number(m[1]));
  if (/^title$/i.test(style)) return 1;
  const outline = attr(pPr?.children.find((c) => local(c.tag) === "outlineLvl"), "val");
  return outline !== undefined && Number(outline) < 6 ? Number(outline) + 1 : undefined;
}

const isListItem = (p: XmlNode) => Boolean(find(p.children.filter((c) => local(c.tag) === "pPr"), "numPr"));

function wordBlocks(nodes: readonly XmlNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const name = local(n.tag);
    if (name === "p") {
      const text = wordText(n).trim();
      if (!text) continue;
      const level = headingLevel(n);
      out.push(level ? `${"#".repeat(level)} ${text}` : isListItem(n) ? `- ${text}` : text);
    } else if (name === "tbl") {
      const rows = n.children
        .filter((c) => local(c.tag) === "tr")
        .map((tr) => tr.children.filter((c) => local(c.tag) === "tc").map((tc) => wordBlocks(tc.children).join(" ")));
      out.push(markdownTable(rows));
    } else if (name === "sdt" || name === "sdtContent" || name === "customXml" || name === "ins" || name === "smartTag") {
      out.push(...wordBlocks(n.children));
    }
  }
  return out;
}

/** Joins blocks: list items stay together, everything else is a paragraph. */
const joinBlocks = (blocks: readonly string[]) =>
  blocks.reduce((acc, b, i) => (i === 0 ? b : acc + (b.startsWith("- ") && blocks[i - 1]!.startsWith("- ") ? "\n" : "\n\n") + b), "");

export function readDocx(raw: Uint8Array): ReadResult {
  const zip = openZip(raw, (n) => n.endsWith(".xml") || n.endsWith(".rels"));
  const doc = xmlPart(zip, "word/document.xml");
  if (!doc) throw new Error("This file is not a Word document: it has no word/document.xml.");
  const body = find(doc, "body");
  const blocks = wordBlocks(body?.children ?? []);
  const comments = xmlPart(zip, "word/comments.xml");
  const notes = comments ? findAll(comments, "comment").map((c) => `- ${attr(c, "author") ?? "Someone"}: ${wordBlocks(c.children).join(" ")}`) : [];
  const { title, metadata } = coreProperties(zip);
  const content = joinBlocks(blocks) + (notes.length ? `\n\n## Comments\n\n${notes.join("\n")}` : "");
  return { content, title: title ?? blocks.find((b) => b.startsWith("#"))?.replace(/^#+\s*/, ""), metadata };
}

// ---------------------------------------------------------------- PowerPoint

const SKIPPED_PLACEHOLDERS = new Set(["sldNum", "dt", "ftr", "hdr", "sldImg"]);

/** The paragraphs of a text body. */
const drawingParagraphs = (txBody: XmlNode) =>
  findAll([txBody], "p")
    .map((p) => p.children.map((c) => (local(c.tag) === "br" ? "\n" : findAll([c], "t").map(textOf).join(""))).join("").trim())
    .filter(Boolean);

function placeholder(shape: XmlNode): string | undefined {
  const ph = find(shape.children.filter((c) => local(c.tag).startsWith("nv")), "ph");
  return ph ? (attr(ph, "type") ?? "body") : undefined;
}

/** A slide's title and blocks, in the order shapes appear. */
function slideContent(tree: XmlNode[]): { title?: string; blocks: string[] } {
  let title: string | undefined;
  const blocks: string[] = [];
  const spTree = find(tree, "spTree");
  const walk = (nodes: readonly XmlNode[]) => {
    for (const n of nodes) {
      const name = local(n.tag);
      if (name === "grpSp") walk(n.children);
      else if (name === "sp") {
        const ph = placeholder(n);
        if (ph && SKIPPED_PLACEHOLDERS.has(ph)) continue;
        const txBody = n.children.find((c) => local(c.tag) === "txBody");
        if (!txBody) continue;
        const paras = drawingParagraphs(txBody);
        if (!paras.length) continue;
        if ((ph === "title" || ph === "ctrTitle") && !title) title = paras.join(" ");
        else blocks.push(paras.map((p) => (paras.length > 1 ? `- ${p}` : p)).join("\n"));
      } else if (name === "graphicFrame") {
        const tbl = find(n.children, "tbl");
        if (!tbl) continue;
        const rows = findAll([tbl], "tr").map((tr) => findAll([tr], "tc").map((tc) => drawingParagraphs(tc).join(" ")));
        blocks.push(markdownTable(rows));
      }
    }
  };
  walk(spTree?.children ?? []);
  return { title, blocks };
}

export function readPptx(raw: Uint8Array): ReadResult {
  const zip = openZip(raw, (n) => n.endsWith(".xml") || n.endsWith(".rels"));
  const presentation = xmlPart(zip, "ppt/presentation.xml");
  if (!presentation) throw new Error("This file is not a PowerPoint presentation: it has no ppt/presentation.xml.");
  const presRels = rels(zip, "ppt/presentation.xml");
  const slideParts = findAll(presentation, "sldId").flatMap((s) => presRels.get(relId(s) ?? "")?.target ?? []);
  const sections: string[] = [];
  let firstTitle: string | undefined;
  for (const [i, part] of slideParts.entries()) {
    const slide = xmlPart(zip, part);
    if (!slide) continue;
    const { title, blocks } = slideContent(slide);
    firstTitle ??= title;
    const hidden = attr(find(slide, "sld"), "show") === "0" ? " (hidden)" : "";
    const notesPart = [...rels(zip, part).values()].find((r) => r.type.endsWith("/notesSlide"))?.target;
    const notes = notesPart ? xmlPart(zip, notesPart) : undefined;
    const noteText = notes ? slideContent(notes).blocks.join("\n") : "";
    sections.push(
      [`## Slide ${i + 1}${title ? `: ${title}` : ""}${hidden}`, ...blocks, ...(noteText ? [`Notes: ${noteText}`] : [])].join("\n\n"),
    );
  }
  const { title, metadata } = coreProperties(zip);
  return { content: sections.join("\n\n"), title: title ?? firstTitle, metadata: { ...metadata, slides: slideParts.length } };
}

// ---------------------------------------------------------------- Excel

/** "BC12" gives column 54 (0-based: 54 = B*26 + C - 1). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsx(raw: Uint8Array): ReadResult {
  const zip = openZip(raw, (n) => n.endsWith(".xml") || n.endsWith(".rels"));
  const workbook = xmlPart(zip, "xl/workbook.xml");
  if (!workbook) throw new Error("This file is not an Excel workbook: it has no xl/workbook.xml.");
  const bookRels = rels(zip, "xl/workbook.xml");
  const sharedPart = [...bookRels.values()].find((r) => r.type.endsWith("/sharedStrings"))?.target ?? "xl/sharedStrings.xml";
  const shared = (xmlPart(zip, sharedPart) ?? []).flatMap((n) =>
    findAll([n], "si").map((si) => si.children.filter((c) => local(c.tag) !== "rPh").map((c) => findAll([c], "t").map(textOf).join("")).join("")),
  );
  const sections: string[] = [];
  const sheets = findAll(workbook, "sheet");
  for (const sheet of sheets) {
    const name = attr(sheet, "name") ?? "Sheet";
    const part = bookRels.get(relId(sheet) ?? "")?.target;
    const tree = part ? xmlPart(zip, part) : undefined;
    if (!tree) continue;
    const rows: string[][] = [];
    for (const row of findAll(tree, "row")) {
      const cells: string[] = [];
      for (const [i, c] of row.children.filter((x) => local(x.tag) === "c").entries()) {
        const ref = attr(c, "r");
        const col = ref ? columnIndex(ref) : i;
        if (col >= TABLE_LIMITS.columns * 4) continue;
        const v = c.children.find((x) => local(x.tag) === "v");
        const raw = v ? textOf(v) : "";
        const t = attr(c, "t");
        cells[col] =
          t === "s" ? (shared[Number(raw)] ?? "") : t === "inlineStr" ? findAll(c.children, "t").map(textOf).join("") : t === "b" ? (raw === "1" ? "TRUE" : "FALSE") : raw;
      }
      if (cells.some((x) => x?.trim())) rows.push(Array.from(cells, (x) => x ?? ""));
    }
    const hidden = attr(sheet, "state") && attr(sheet, "state") !== "visible" ? " (hidden)" : "";
    sections.push(`## Sheet: ${name}${hidden}\n\n${rows.length ? markdownTable(rows) : "_Empty._"}`);
  }
  const { title, metadata } = coreProperties(zip);
  return { content: sections.join("\n\n"), title, metadata: { ...metadata, sheets: sheets.map((s) => attr(s, "name")) } };
}
