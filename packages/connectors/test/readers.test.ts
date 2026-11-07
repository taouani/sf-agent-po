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

  it("refuses a file that is not a Word document, or that declares entities", () => {
    expect(() => readDocx(Buffer.from("not a zip"))).toThrow(/cannot be read as an Office document/);
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

  it("cuts very large tables and says so", () => {
    const rows = Array.from({ length: TABLE_LIMITS.rows + 10 }, (_, i) => [`r${i}`, ...Array.from({ length: TABLE_LIMITS.columns + 5 }, () => "x")]);
    const table = markdownTable(rows);
    expect(table.split("\n").filter((l) => l.startsWith("| r"))).toHaveLength(TABLE_LIMITS.rows + 1);
    expect(table).toMatch(/_9 more rows not shown; more columns not shown\._$/);
    expect(markdownTable([["a".repeat(TABLE_LIMITS.cell + 10)]])).toContain(`${"a".repeat(TABLE_LIMITS.cell)}…`);
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
  });
});
