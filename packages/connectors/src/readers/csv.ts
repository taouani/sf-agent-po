// CSV and TSV files as Markdown tables.

import { markdownTable, type ReadResult } from "./office.js";

/** The delimiter of a CSV file: the one of , ; or tab that appears most in its first line, outside quotes. */
export function guessDelimiter(text: string): string {
  const nl = text.search(/\r?\n/);
  const first = (nl < 0 ? text : text.slice(0, nl)).replace(/"[^"]*"/g, "");
  let best = ",";
  let most = 0;
  for (const d of [",", ";", "\t"]) {
    const n = first.split(d).length - 1;
    if (n > most) [best, most] = [d, n];
  }
  return best;
}

/** Parses CSV (RFC 4180): quoted fields may hold the delimiter, quotes ("") and line breaks. */
export function parseCsv(text: string, delimiter = guessDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export function readCsv(text: string, delimiter?: string): ReadResult {
  const rows = parseCsv(text, delimiter);
  return { content: rows.length ? markdownTable(rows) : "_Empty._", metadata: { rows: Math.max(0, rows.length - 1) } };
}
