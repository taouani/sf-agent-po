// CSV and TSV files as Markdown tables.

import { markdownTable, TABLE_LIMITS, type ReadResult } from "./office.js";

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

/**
 * Parses CSV (RFC 4180): quoted fields may hold the delimiter, quotes ("") and line breaks.
 * A quote that is never closed is taken as a plain character, so one stray quote does not
 * swallow the rest of the file.
 */
export function parseCsv(text: string, delimiter = guessDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // Where the open quote started, and the state to go back to if it is never closed.
  let open = { at: -1, rows: 0, row, cells: 0 };
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i <= src.length; i++) {
    if (i === src.length) {
      if (!quoted) break;
      rows.length = open.rows;
      row = open.row;
      row.length = open.cells;
      field = '"';
      quoted = false;
      i = open.at;
      continue;
    }
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") {
      quoted = true;
      open = { at: i, rows: rows.length, row, cells: row.length };
    } else if (ch === delimiter) {
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

/** Reads a CSV file. A first line such as "sep=;" (written by Excel) sets the delimiter. */
export function readCsv(text: string, delimiter?: string): ReadResult {
  const src = text.replace(/^\uFEFF/, "");
  const sep = /^sep=(.)\r?(?:\n|$)/i.exec(src);
  const rows = sep ? parseCsv(src.slice(sep[0].length), sep[1]) : parseCsv(src, delimiter);
  return { content: rows.length ? markdownTable(rows, { cell: TABLE_LIMITS.cell }) : "_Empty._", metadata: { rows: Math.max(0, rows.length - 1) } };
}
