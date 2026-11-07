// Word, PowerPoint and Excel files as Markdown text: headings, lists and tables keep their
// shape, slides keep their numbers and notes, sheets keep their names.

import { attr, decodeEntities, find, findAll, local, parseXml, relId, textOf, type XmlNode } from "./xml.js";
import { openZip, relationships, ZIP_LIMITS, type ZipParts } from "./zip.js";

/** What a reader gives back: the text, and a title and metadata when the file has them. */
export interface ReadResult {
  content: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Limits on how much of a table is kept, so one huge sheet does not drown everything else.
 * `cell` applies to data tables (Excel, CSV) only: a Word or slide table holds prose, such as
 * acceptance criteria, and is never cut.
 */
export const TABLE_LIMITS = { rows: 2000, columns: 50, cell: 5000 };

export interface TableOptions {
  /** The longest cell kept; unlimited when not given. */
  cell?: number;
  /** Rows not passed in, to mention ("1,200 more rows not shown"). */
  moreRows?: number;
  /** Columns not passed in. */
  moreColumns?: boolean;
}

/** A Markdown table; the first row is the header. */
export function markdownTable(rows: readonly (readonly string[])[], opts: TableOptions = {}): string {
  if (!rows.length) return "";
  let widest = 0;
  for (const r of rows) if (r.length > widest) widest = r.length;
  const width = Math.min(TABLE_LIMITS.columns, widest);
  const cell = (s: string | undefined) => {
    const flat = (s ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
    return opts.cell !== undefined && flat.length > opts.cell ? `${flat.slice(0, opts.cell)}…` : flat;
  };
  const line = (r: readonly string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(" | ")} |`;
  const kept = rows.slice(0, TABLE_LIMITS.rows + 1);
  const out = [line(kept[0]!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...kept.slice(1).map(line)];
  const more = rows.length - kept.length + (opts.moreRows ?? 0);
  const cut: string[] = [];
  if (more > 0) cut.push(`${more} more rows`);
  if (widest > width || opts.moreColumns) cut.push("more columns");
  if (cut.length) out.push("", `_${cut.map((c) => `${c} not shown`).join("; ")}._`);
  return out.join("\n");
}

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

/** Opens an Office file: XML parts read into a tree stay small; `streamed` parts may be larger. */
const openOffice = (raw: Uint8Array, streamed: (name: string) => boolean = () => false) =>
  openZip(
    raw,
    (n) => n.endsWith(".xml") || n.endsWith(".rels"),
    (n) => (streamed(n) ? ZIP_LIMITS.part : ZIP_LIMITS.xml),
  );

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

/** The children of a node, with wrappers that only mark revisions or controls opened up. */
function unwrap(nodes: readonly XmlNode[]): XmlNode[] {
  const out: XmlNode[] = [];
  for (const n of nodes) {
    const name = local(n.tag);
    if (["sdt", "sdtContent", "customXml", "ins", "moveTo", "smartTag", "hyperlink", "fldSimple"].includes(name)) out.push(...unwrap(n.children));
    else if (name === "AlternateContent") out.push(...unwrap(alternative(n)));
    else out.push(n);
  }
  return out;
}

/** One branch of mc:AlternateContent: both hold the same content, so reading both doubles it. */
function alternative(node: XmlNode): XmlNode[] {
  const branch = node.children.find((c) => local(c.tag) === "Choice") ?? node.children.find((c) => local(c.tag) === "Fallback");
  return branch?.children ?? [];
}

// ---------------------------------------------------------------- Word

interface WordStyle {
  name: string;
  basedOn?: string;
  outline?: number;
  numId?: string;
}

/** Paragraph styles by id, from word/styles.xml. */
function wordStyles(zip: ZipParts): Map<string, WordStyle> {
  const styles = new Map<string, WordStyle>();
  for (const s of findAll(xmlPart(zip, "word/styles.xml") ?? [], "style")) {
    if (attr(s, "type") !== "paragraph") continue;
    const child = (name: string) => s.children.find((c) => local(c.tag) === name);
    const pPr = child("pPr");
    const outline = attr(pPr && find(pPr.children, "outlineLvl"), "val");
    styles.set(attr(s, "styleId") ?? "", {
      name: attr(child("name"), "val") ?? "",
      basedOn: attr(child("basedOn"), "val"),
      outline: outline === undefined ? undefined : Number(outline),
      numId: attr(pPr && find(pPr.children, "numId"), "val"),
    });
  }
  return styles;
}

/** A style and the ones it is based on, nearest first. */
function styleChain(styles: Map<string, WordStyle>, id: string | undefined): WordStyle[] {
  const chain: WordStyle[] = [];
  for (let s = id && styles.get(id); s && chain.length < 10; s = s.basedOn ? styles.get(s.basedOn) : undefined) chain.push(s);
  return chain;
}

/** Heading style ids when a file has no styles part: Heading1, Titre1, berschrift1 (Überschrift), Ttulo1, Titolo1, Kop1, Rubrik1, Overskrift1. */
const HEADING_ID = /^(?:heading|titre|berschrift|t[ií]?tulo|titolo|kop|rubrik|overskrift)\s*(\d)$/i;

class WordReader {
  constructor(private readonly styles: Map<string, WordStyle>) {}

  /** A paragraph's text: runs, tabs and breaks; deleted or moved-away text and field codes are left out. */
  text(node: XmlNode): string {
    const name = local(node.tag);
    if (node.tag === "#text") return "";
    if (name === "t") return textOf(node);
    if (name === "tab") return "\t";
    if (name === "br" || name === "cr") return "\n";
    if (["del", "moveFrom", "delText", "instrText", "rPr", "pPr"].includes(name)) return "";
    if (name === "AlternateContent") return alternative(node).map((c) => this.text(c)).join("");
    // A text box holds its own paragraphs.
    if (name === "txbxContent") return `\n${joinBlocks(this.blocks(node.children))}\n`;
    return node.children.map((c) => this.text(c)).join("");
  }

  private paragraphProps(p: XmlNode) {
    const pPr = p.children.find((c) => local(c.tag) === "pPr");
    const prop = (name: string) => pPr?.children.find((c) => local(c.tag) === name);
    const chain = styleChain(this.styles, attr(prop("pStyle"), "val"));
    return { pPr, prop, chain, styleId: attr(prop("pStyle"), "val") ?? "" };
  }

  headingLevel(p: XmlNode): number | undefined {
    const { prop, chain, styleId } = this.paragraphProps(p);
    const own = attr(prop("outlineLvl"), "val");
    if (own !== undefined) return Number(own) < 6 ? Number(own) + 1 : undefined;
    for (const s of chain) {
      // Built-in styles keep their English name ("heading 1") whatever the document's language.
      const m = /^heading\s*(\d)$/i.exec(s.name);
      if (m) return Math.min(6, Number(m[1]));
      if (/^title$/i.test(s.name)) return 1;
      if (s.outline !== undefined) return s.outline < 6 ? s.outline + 1 : undefined;
    }
    if (!this.styles.size) {
      const m = HEADING_ID.exec(styleId);
      if (m) return Math.min(6, Number(m[1]));
      if (/^title$/i.test(styleId)) return 1;
    }
    return undefined;
  }

  isListItem(p: XmlNode): boolean {
    const { prop, chain } = this.paragraphProps(p);
    const numPr = prop("numPr");
    // numId 0 means numbering was removed from the paragraph.
    if (numPr) return attr(find(numPr.children, "numId"), "val") !== "0";
    const fromStyle = chain.find((s) => s.numId !== undefined)?.numId;
    return fromStyle !== undefined && fromStyle !== "0";
  }

  /** A table's rows; a merged cell (gridSpan) keeps the columns after it in place. */
  table(tbl: XmlNode): string[][] {
    return unwrap(tbl.children)
      .filter((c) => local(c.tag) === "tr")
      .map((tr) =>
        unwrap(tr.children)
          .filter((c) => local(c.tag) === "tc")
          .flatMap((tc) => {
            const span = Number(attr(find(tc.children.filter((c) => local(c.tag) === "tcPr"), "gridSpan"), "val") ?? 1);
            const text = this.blocks(tc.children).join(" ");
            return [text, ...Array.from({ length: Math.max(0, span - 1) }, () => "")];
          }),
      );
  }

  blocks(nodes: readonly XmlNode[]): string[] {
    const out: string[] = [];
    for (const n of unwrap(nodes)) {
      const name = local(n.tag);
      if (name === "p") {
        const text = this.text(n).trim();
        if (!text) continue;
        const level = this.headingLevel(n);
        out.push(level ? `${"#".repeat(level)} ${text}` : this.isListItem(n) ? `- ${text}` : text);
      } else if (name === "tbl") {
        out.push(markdownTable(this.table(n)));
      }
    }
    return out;
  }
}

/** Joins blocks: list items stay together, everything else is a paragraph. */
const joinBlocks = (blocks: readonly string[]) =>
  blocks.reduce((acc, b, i) => (i === 0 ? b : acc + (b.startsWith("- ") && blocks[i - 1]!.startsWith("- ") ? "\n" : "\n\n") + b), "");

export function readDocx(raw: Uint8Array): ReadResult {
  const zip = openOffice(raw);
  const doc = xmlPart(zip, "word/document.xml");
  if (!doc) throw new Error("This file is not a Word document: it has no word/document.xml.");
  const word = new WordReader(wordStyles(zip));
  const blocks = word.blocks(find(doc, "body")?.children ?? []);
  const sections = [joinBlocks(blocks)];
  const footnotes = findAll(xmlPart(zip, "word/footnotes.xml") ?? [], "footnote")
    .filter((f) => !attr(f, "type") || attr(f, "type") === "normal")
    .map((f) => word.blocks(f.children).join(" "))
    .filter(Boolean);
  if (footnotes.length) sections.push(`## Footnotes\n\n${footnotes.map((f, i) => `${i + 1}. ${f}`).join("\n")}`);
  const comments = findAll(xmlPart(zip, "word/comments.xml") ?? [], "comment").map((c) => `- ${attr(c, "author") ?? "Someone"}: ${word.blocks(c.children).join(" ")}`);
  if (comments.length) sections.push(`## Comments\n\n${comments.join("\n")}`);
  const { title, metadata } = coreProperties(zip);
  return { content: sections.filter(Boolean).join("\n\n"), title: title ?? blocks.find((b) => b.startsWith("#"))?.replace(/^#+\s*/, ""), metadata };
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

/** A part a slide refers to by relationship id, parsed, with its relationship type. */
type PartResolver = (id: string) => { type: string; tree: XmlNode[] } | undefined;

/** The text of a SmartArt diagram or a chart in a graphic frame. */
function graphicText(frame: XmlNode, resolve: PartResolver): string | undefined {
  const relIds = find(frame.children, "relIds");
  const data = relIds && attr(relIds, "dm") ? resolve(attr(relIds, "dm")!) : undefined;
  if (data) {
    const items = findAll(data.tree, "pt")
      .filter((pt) => !["parTrans", "sibTrans", "pres"].includes(attr(pt, "type") ?? ""))
      // dgm:t holds the paragraphs; the runs inside hold a:t. Only the innermost text counts.
      .map((pt) => findAll(pt.children, "t").filter((t) => t.children.every((c) => c.tag === "#text")).map(textOf).join("").trim())
      .filter(Boolean);
    return items.length ? items.map((t) => `- ${t}`).join("\n") : undefined;
  }
  const chartRef = find(frame.children, "chart");
  const chart = chartRef && relId(chartRef) ? resolve(relId(chartRef)!) : undefined;
  if (!chart) return undefined;
  const texts = (nodes: XmlNode[]) => nodes.map((n) => [...findAll([n], "t"), ...findAll([n], "v")].map(textOf).join("").trim()).filter(Boolean);
  const title = texts(findAll(chart.tree, "title").slice(0, 1)).join(" ");
  const series = findAll(chart.tree, "ser");
  const names = series.flatMap((s) => texts(s.children.filter((c) => local(c.tag) === "tx")));
  const categories = series[0] ? findAll(series[0].children.filter((c) => local(c.tag) === "cat"), "pt").map((p) => textOf(p).trim()) : [];
  const lines = [`Chart${title ? `: ${title}` : ""}`];
  if (names.length) lines.push(`Series: ${names.join(", ")}`);
  if (categories.length) lines.push(`Categories: ${categories.join(", ")}`);
  return lines.join("\n");
}

/** A slide's title and blocks, in the order shapes appear. */
function slideContent(tree: XmlNode[], resolve: PartResolver): { title?: string; blocks: string[] } {
  let title: string | undefined;
  const blocks: string[] = [];
  const spTree = find(tree, "spTree");
  const walk = (nodes: readonly XmlNode[]) => {
    for (const n of nodes) {
      const name = local(n.tag);
      if (name === "grpSp") walk(n.children);
      else if (name === "AlternateContent") walk(alternative(n));
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
        if (tbl) blocks.push(markdownTable(findAll([tbl], "tr").map((tr) => findAll([tr], "tc").map((tc) => drawingParagraphs(tc).join(" ")))));
        else {
          const text = graphicText(n, resolve);
          if (text) blocks.push(text);
        }
      }
    }
  };
  walk(spTree?.children ?? []);
  return { title, blocks };
}

export function readPptx(raw: Uint8Array): ReadResult {
  const zip = openOffice(raw);
  const presentation = xmlPart(zip, "ppt/presentation.xml");
  if (!presentation) throw new Error("This file is not a PowerPoint presentation: it has no ppt/presentation.xml.");
  const presRels = rels(zip, "ppt/presentation.xml");
  const slideParts = findAll(presentation, "sldId").flatMap((s) => presRels.get(relId(s) ?? "")?.target ?? []);
  const resolverFor = (part: string): PartResolver => {
    const r = rels(zip, part);
    return (id) => {
      const rel = r.get(id);
      const tree = rel ? xmlPart(zip, rel.target) : undefined;
      return rel && tree ? { type: rel.type, tree } : undefined;
    };
  };
  const sections: string[] = [];
  let firstTitle: string | undefined;
  for (const [i, part] of slideParts.entries()) {
    const slide = xmlPart(zip, part);
    if (!slide) continue;
    const { title, blocks } = slideContent(slide, resolverFor(part));
    firstTitle ??= title;
    const hidden = attr(find(slide, "sld"), "show") === "0" ? " (hidden)" : "";
    const notesPart = [...rels(zip, part).values()].find((r) => r.type.endsWith("/notesSlide"))?.target;
    const notes = notesPart ? xmlPart(zip, notesPart) : undefined;
    const noteText = notes && notesPart ? slideContent(notes, resolverFor(notesPart)).blocks.join("\n") : "";
    sections.push([`## Slide ${i + 1}${title ? `: ${title}` : ""}${hidden}`, ...blocks, ...(noteText ? [`Notes: ${noteText}`] : [])].join("\n\n"));
  }
  const { title, metadata } = coreProperties(zip);
  return { content: sections.join("\n\n"), title: title ?? firstTitle, metadata: { ...metadata, slides: slideParts.length } };
}

// ---------------------------------------------------------------- Excel

/** "BC12" gives column 54 (0-based). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const attrsOf = (s: string) => Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1]!.replace(/^\w+:/, ""), decodeEntities(m[2]!)]));
/** The text of every <t> in a piece of XML (a shared or inline string), leaving out phonetic runs. */
const stringText = (xml: string) =>
  [...xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "").matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decodeEntities(m[1]!)).join("");

/** Built-in number formats that show dates or times. */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(code: string): boolean {
  // Quoted text, escaped characters and [colour] or [$-locale] sections are not date parts.
  const bare = code.replace(/"[^"]*"|\\.|\[(?!h\]|m\]|s\])[^\]]*\]/gi, "");
  return /[dmyhs]/i.test(bare) && !/^general$/i.test(bare.trim());
}

/** Which cell styles (index in cellXfs) show dates, from xl/styles.xml. */
function dateStyles(zip: ZipParts): Set<number> {
  const styles = xmlPart(zip, "xl/styles.xml");
  const out = new Set<number>();
  if (!styles) return out;
  const custom = new Map(findAll(styles, "numFmt").map((f) => [Number(attr(f, "numFmtId")), attr(f, "formatCode") ?? ""]));
  const xfs = find(styles, "cellXfs");
  for (const [i, xf] of (xfs?.children.filter((c) => local(c.tag) === "xf") ?? []).entries()) {
    const id = Number(attr(xf, "numFmtId") ?? 0);
    if (custom.has(id) ? isDateFormat(custom.get(id)!) : DATE_FORMAT_IDS.has(id)) out.add(i);
  }
  return out;
}

/** An Excel date serial as ISO text (the 1900 system counts from 1899-12-30, the 1904 one from 1904-01-01). */
export function excelDate(serial: number, date1904 = false): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + Math.round(serial * 86400) * 1000);
  const iso = d.toISOString();
  if (serial < 1 && !date1904) return iso.slice(11, 19);
  return serial % 1 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

export function readXlsx(raw: Uint8Array): ReadResult {
  const zip = openOffice(raw, (n) => /^xl\/(worksheets\/[^/]+\.xml|sharedStrings\.xml)$/.test(n));
  const workbook = xmlPart(zip, "xl/workbook.xml");
  if (!workbook) throw new Error("This file is not an Excel workbook: it has no xl/workbook.xml.");
  const bookRels = rels(zip, "xl/workbook.xml");
  const date1904 = ["1", "true"].includes(attr(find(workbook, "workbookPr"), "date1904") ?? "");
  const dates = dateStyles(zip);
  // Shared strings and sheets can be large: they are scanned, not parsed into a tree.
  const sharedPart = [...bookRels.values()].find((r) => r.type.endsWith("/sharedStrings"))?.target ?? "xl/sharedStrings.xml";
  const shared = [...(zip.text(sharedPart) ?? "").matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)].map((m) => stringText(m[1] ?? ""));
  const sections: string[] = [];
  const sheets = findAll(workbook, "sheet");
  for (const sheet of sheets) {
    const name = attr(sheet, "name") ?? "Sheet";
    const part = bookRels.get(relId(sheet) ?? "")?.target;
    const xml = part ? zip.text(part) : undefined;
    if (xml === undefined) continue;
    const rows: string[][] = [];
    let moreRows = 0;
    let moreColumns = false;
    for (const row of xml.matchAll(/<(?:\w+:)?row\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
      if (!row[1]) continue;
      if (rows.length > TABLE_LIMITS.rows) {
        moreRows++;
        continue;
      }
      const cells: string[] = [];
      let col = -1;
      for (const c of row[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const a = attrsOf(c[1]!);
        col = a.r ? columnIndex(a.r) : col + 1;
        if (col >= TABLE_LIMITS.columns) {
          moreColumns = true;
          continue;
        }
        const inner = c[2] ?? "";
        const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
        const value = v === undefined ? "" : decodeEntities(v);
        const t = a.t;
        cells[col] =
          t === "s"
            ? (shared[Number(value)] ?? "")
            : t === "inlineStr"
              ? stringText(inner)
              : t === "b"
                ? value === "1" ? "TRUE" : "FALSE"
                : !t && value !== "" && dates.has(Number(a.s ?? -1)) && Number.isFinite(Number(value))
                  ? excelDate(Number(value), date1904)
                  : value;
      }
      if (cells.some((x) => x?.trim())) rows.push(Array.from(cells, (x) => x ?? ""));
    }
    const hidden = attr(sheet, "state") && attr(sheet, "state") !== "visible" ? " (hidden)" : "";
    sections.push(`## Sheet: ${name}${hidden}\n\n${rows.length ? markdownTable(rows, { cell: TABLE_LIMITS.cell, moreRows, moreColumns }) : "_Empty._"}`);
  }
  const { title, metadata } = coreProperties(zip);
  return { content: sections.join("\n\n"), title, metadata: { ...metadata, sheets: sheets.map((s) => attr(s, "name")) } };
}
