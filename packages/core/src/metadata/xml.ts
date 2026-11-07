import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

/**
 * Parses a metadata file. A document type declaration is refused: Salesforce never writes
 * one, and its entities could expand without limit.
 */
export function parseMetadataXml(xml: string): Record<string, unknown> {
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, "");
  if (/<!DOCTYPE|<!ENTITY/i.test(markup)) throw new Error("a document type declaration is not read");
  const parsed = parser.parse(xml) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("not XML");
  return parsed as Record<string, unknown>;
}

/** A repeated element as an array, whether the file had none, one or several. */
export const list = (v: unknown): unknown[] => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]);

/** An element's text, or undefined when it is missing or not text. */
export const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined);

export const bool = (v: unknown): boolean | undefined => (v === "true" ? true : v === "false" ? false : undefined);

export const num = (v: unknown): number | undefined => {
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
