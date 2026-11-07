import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import {
  guessDelimiter,
  loadLocalDocuments,
  markdownTable,
  parseCsv,
  READABLE_EXTENSIONS,
  readCsv,
  readDocx,
  readDrawio,
  readPdf,
  readPptx,
  readXlsx,
  TABLE_LIMITS,
} from "../src/index.js";
import { decodeText } from "../src/files.js";
import { excelDate } from "../src/readers/office.js";
import * as fixtures from "./fixtures/build.js";

const tmp = mkdtempSync(join(tmpdir(), "sf-agent-po-readers-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("Word", () => {
  it("keeps headings, lists, tables and comments, and leaves out deleted text and field codes", () => {
    const doc = readDocx(fixtures.docx());
    expect(doc.content).toBe(
      [
        "# VIP clienteling",
        "Sarah Whitfield wants the VIP flag & a private sale.",
        "Kept\tafter tab",
        "- Clienteling book\n- Private appointments",
        "## Besoins",
        "| Field | Owner |\n| --- | --- |\n| VIP__c | Tom \\| Baker |",
        "## Comments",
        "- Tom Baker: Check with legal",
      ].join("\n\n"),
    );
    expect(doc.title).toBe("VIP spec");
    expect(doc.metadata).toEqual({ author: "Sarah Whitfield" });
  });

  it("finds headings and lists through styles, keeps merged cells in place and reads text boxes and footnotes once", () => {
    expect(readDocx(fixtures.docxFeatures()).content).toBe(
      [
        "## Exigences",
        "Not a heading",
        "Numbering removed",
        "- Bullet from style",
        "Client\u2019s \u2014 arrived",
        "Box text",
        "| A | B | C |\n| --- | --- | --- |\n| Merged |  | Last |",
        "## Footnotes\n\n1. See the 2025 audit.",
      ].join("\n\n"),
    );
  });

  it("refuses a file that is not a Word document, or that declares entities", () => {
    expect(() => readDocx(Buffer.from("not a zip"))).toThrow(/cannot be read as an Office document/);
    // A declaration mentioned in a comment or CDATA is only text.
    const mention = `<?xml version="1.0"?><w:document><!-- no <!ENTITY here --><w:body><w:p><w:r><w:t><![CDATA[<!DOCTYPE x>]]></w:t></w:r></w:p></w:body></w:document>`;
    expect(readDocx(Buffer.from(zipSync({ "word/document.xml": strToU8(mention) }))).content).toBe("<!DOCTYPE x>");
    expect(() => readDocx(Buffer.from(zipSync({ "a.txt": strToU8("x") })))).toThrow(/no word\/document.xml/);
    const bomb = '<?xml version="1.0"?><!DOCTYPE w [<!ENTITY a "aaaa">]><w:document><w:body/></w:document>';
    expect(() => readDocx(Buffer.from(zipSync({ "word/document.xml": strToU8(bomb) })))).toThrow(/document type declaration/);
  });
});

describe("PowerPoint", () => {
  it("reads slides in the deck's order, with titles, bullets, tables, notes and hidden slides", () => {
    const deck = readPptx(fixtures.pptx());
    expect(deck.content).toBe(
      [
        "## Slide 1: Programme VIP",
        "Owner: Sarah Whitfield",
        "Notes: Mention the budget",
        "## Slide 2: Goals (hidden)",
        "- Grow retention\n- Know every client",
        "| KPI | Target |\n| --- | --- |\n| NPS | 70 |",
      ].join("\n\n"),
    );
    expect(deck.title).toBe("Programme VIP");
    expect(deck.metadata).toEqual({ author: "Tom Baker", slides: 2 });
  });
});

describe("PowerPoint graphics", () => {
  it("reads AlternateContent shapes once, SmartArt items and chart titles, series and categories", () => {
    expect(readPptx(fixtures.pptxGraphics()).content).toBe(
      ["## Slide 1: Roadmap", "New shape", "- Discover\n- Build", "Chart: Sales\nSeries: Paris, Lyon\nCategories: Q1, Q2"].join("\n\n"),
    );
  });
});

describe("Excel", () => {
  it("reads each sheet as a table, with shared and inline strings, booleans and gaps", () => {
    const book = readXlsx(fixtures.xlsx());
    expect(book.content).toBe(
      [
        "## Sheet: Clients",
        "| Name | Phone |  | VIP |\n| --- | --- | --- | --- |\n| Sarah Whitfield | 33612345678 |  | TRUE |",
        "## Sheet: Old (hidden)",
        "_Empty._",
      ].join("\n\n"),
    );
    expect(book.metadata).toEqual({ sheets: ["Clients", "Old"] });
  });

  it("shows dates as dates, places cells without a reference and says when columns are cut", () => {
    const book = readXlsx(fixtures.xlsxDates(TABLE_LIMITS.columns + 5));
    const lines = book.content.split("\n");
    expect(lines[2]).toBe("| Due & owner \u2019 | When |" + "  |".repeat(TABLE_LIMITS.columns - 2));
    expect(lines[4]).toBe("| 1 | 2025-12-09 | 2025-12-09 12:00 | 46000 |" + "  |".repeat(TABLE_LIMITS.columns - 4));
    expect(book.content).toMatch(/_more columns not shown\._$/);
    expect(excelDate(0.75)).toBe("18:00:00");
    expect(excelDate(0, true)).toBe("1904-01-01");
  });

  it("cuts very large tables and says so", () => {
    const rows = Array.from({ length: TABLE_LIMITS.rows + 10 }, (_, i) => [`r${i}`, ...Array.from({ length: TABLE_LIMITS.columns + 5 }, () => "x")]);
    const table = markdownTable(rows);
    expect(table.split("\n").filter((l) => l.startsWith("| r"))).toHaveLength(TABLE_LIMITS.rows + 1);
    expect(table).toMatch(/_9 more rows not shown; more columns not shown\._$/);
    const long = "a".repeat(TABLE_LIMITS.cell + 10);
    expect(markdownTable([[long]], { cell: TABLE_LIMITS.cell })).toContain(`| ${"a".repeat(TABLE_LIMITS.cell)}… |`);
    // Prose tables (Word, slides) are never cut.
    expect(markdownTable([[long]])).toContain(long);
    // A very wide row does not overflow the stack.
    expect(markdownTable([Array.from({ length: 200_000 }, () => "x")])).toMatch(/more columns not shown/);
  });
});

describe("PDF", () => {
  it("reads text page by page, with the title and author", async () => {
    const doc = await readPdf(fixtures.pdf());
    expect(doc.content).toBe("## Page 1\n\nHello Sarah Whitfield\n\n## Page 2\n\nSecond page");
    expect(doc.title).toBe("Clienteling spec");
    expect(doc.metadata).toEqual({ pages: 2, author: "Tom Baker" });
  });

  it("says when a PDF has no text to read", async () => {
    expect((await readPdf(fixtures.pdf([""]))).content).toMatch(/no text layer/);
    await expect(readPdf(Buffer.from("%PDF-1.4 junk"))).rejects.toThrow();
  });
});

describe("CSV", () => {
  it("guesses the delimiter and handles quotes and line breaks in fields", () => {
    expect(guessDelimiter("a;b;c\n1,2;3")).toBe(";");
    expect(guessDelimiter('"x,y"\tb\n')).toBe("\t");
    expect(guessDelimiter("single")).toBe(",");
    expect(parseCsv('﻿name,note\r\n"Whitfield, Sarah","said ""yes""\nthen left"\r\n\r\n')).toEqual([
      ["name", "note"],
      ["Whitfield, Sarah", 'said "yes"\nthen left'],
    ]);
    expect(readCsv("a,b\n1,2\n").content).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("takes an unclosed quote as a plain character, and honours Excel's sep= line", () => {
    expect(parseCsv('name,size\n"Sarah,12\nTom,3\n')).toEqual([
      ["name", "size"],
      ['"Sarah', "12"],
      ["Tom", "3"],
    ]);
    expect(parseCsv('a,"b""c",d\n"x')).toEqual([["a", 'b"c', "d"], ['"x']]);
    expect(readCsv("sep=;\r\na;b,c\n1;2\n").content).toBe("| a | b,c |\n| --- | --- |\n| 1 | 2 |");
  });

  it("decodes UTF-8, UTF-16 and Windows-1252 files", () => {
    expect(decodeText(Buffer.from("\uFEFFcafé", "utf8"))).toBe("café");
    expect(decodeText(Buffer.from("café", "utf8"))).toBe("café");
    expect(decodeText(Buffer.from([0xff, 0xfe, ...Buffer.from("café", "utf16le")]))).toBe("café");
    expect(decodeText(Buffer.from([0xfe, 0xff, 0x00, 0x63, 0x00, 0xe9]))).toBe("cé");
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]))).toBe("café €");
  });
});

describe("draw.io", () => {
  it("lists shapes and connections of inline and compressed pages, with custom properties", () => {
    const page = (name: string) =>
      [
        `## Diagram: ${name}`,
        "Shapes:\n- Store associate\n- Client book (owner: Sarah Whitfield)",
        "Connections:\n- Store associate → Client book: updates\n- Client book → (not connected): notifies",
      ].join("\n\n");
    const diagram = readDrawio(fixtures.drawio());
    expect(diagram.content).toBe(`${page("Flow")}\n\n${page("Packed")}`);
    expect(diagram.metadata).toEqual({ pages: 2 });
    expect(() => readDrawio("<html/>")).toThrow(/not a draw.io diagram/);
  });

  it("keeps plain labels as written, fills placeholders and lists a wrapped edge once", () => {
    expect(readDrawio(fixtures.drawioFeatures()).content).toBe(
      ["## Diagram: Plain", "Shapes:\n- a < b & <i>c</i>\n- Owner: Tom Baker (role: Owner, name: Tom Baker)", "Connections:\n- a < b & <i>c</i> → Owner: Tom Baker: approves"].join("\n\n"),
    );
  });

  it("reads a compressed page that was not URI-encoded", async () => {
    const { deflateRawSync } = await import("node:zlib");
    const graph = '<mxGraphModel><root><mxCell id="a" value="100% done" vertex="1"/></root></mxGraphModel>';
    const packed = deflateRawSync(Buffer.from(graph)).toString("base64");
    expect(readDrawio(`<mxfile><diagram name="P">${packed}</diagram></mxfile>`).content).toContain("- 100% done");
  });
});

describe("loading local files", () => {
  it("reads every supported format in a folder, with its format in the metadata", async () => {
    const dir = join(tmp, "inputs");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir);
    writeFileSync(join(dir, "spec.docx"), fixtures.docx());
    writeFileSync(join(dir, "deck.pptx"), fixtures.pptx());
    writeFileSync(join(dir, "clients.xlsx"), fixtures.xlsx());
    writeFileSync(join(dir, "spec.pdf"), fixtures.pdf());
    writeFileSync(join(dir, "flow.drawio.xml"), fixtures.drawio());
    writeFileSync(join(dir, "list.tsv"), "a\tb\n1\t2\n");
    writeFileSync(join(dir, "image.png"), "ignored");
    const docs = await loadLocalDocuments(dir);
    expect(docs.map((d) => [d.title, d.metadata?.format])).toEqual([
      ["clients.xlsx", "xlsx"],
      ["Programme VIP", "pptx"],
      ["flow.drawio.xml", "drawio"],
      ["list.tsv", "tsv"],
      ["VIP spec", "docx"],
      ["Clienteling spec", "pdf"],
    ]);
    expect(READABLE_EXTENSIONS).toEqual(expect.arrayContaining([".pdf", ".docx", ".pptx", ".xlsx", ".csv", ".drawio", ".drawio.xml"]));
  });

  it("names the file it could not read", async () => {
    const file = join(tmp, "broken.docx");
    writeFileSync(file, "not a zip");
    await expect(loadLocalDocuments(file)).rejects.toThrow(/Could not read broken.docx/);
    await expect(loadLocalDocuments(file, undefined, { errors: [] })).rejects.toThrow(/Could not read broken.docx/);
  });

  it("loads the rest of a folder when asked to collect failures", async () => {
    const { mkdirSync } = await import("node:fs");
    const dir = join(tmp, "mixed");
    mkdirSync(dir);
    writeFileSync(join(dir, "bad.xlsx"), "not a zip");
    writeFileSync(join(dir, "good.csv"), "a,b\n1,2\n");
    await expect(loadLocalDocuments(dir)).rejects.toThrow(/Could not read bad.xlsx/);
    const errors: { file: string; message: string }[] = [];
    expect((await loadLocalDocuments(dir, undefined, { errors })).map((d) => d.title)).toEqual(["good.csv"]);
    expect(errors).toEqual([{ file: join(dir, "bad.xlsx"), message: expect.stringMatching(/Could not read bad.xlsx/) }]);
  });
});
