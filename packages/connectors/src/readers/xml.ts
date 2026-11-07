// A small layer over fast-xml-parser's ordered output, for the Office and draw.io readers.

import { XMLParser } from "fast-xml-parser";

/** An element in document order: its tag, attributes and children (text nodes have tag "#text"). */
export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text?: string;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  // Numeric references (&#8217; &#xa;) are common in Office and draw.io files.
  htmlEntities: true,
});

type Ordered = Record<string, unknown> & { ":@"?: Record<string, string> };

function convert(items: Ordered[]): XmlNode[] {
  const out: XmlNode[] = [];
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (key === ":@") continue;
      if (key === "#text") out.push({ tag: "#text", attrs: {}, children: [], text: String(value) });
      else out.push({ tag: key, attrs: item[":@"] ?? {}, children: convert(value as Ordered[]) });
    }
  }
  return out;
}

/**
 * Parses XML from an Office file or a diagram. A document type declaration is refused:
 * these formats never use one, and its entities could expand without limit.
 */
export function parseXml(xml: string): XmlNode[] {
  // CDATA and comments may mention a declaration as text; anywhere else, refuse it.
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, "");
  if (/<!DOCTYPE|<!ENTITY/i.test(markup)) throw new Error("XML with a document type declaration is not read.");
  return convert(parser.parse(xml) as Ordered[]);
}

/** The local name of a tag ("w:p" gives "p"). */
export const local = (tag: string) => tag.slice(tag.indexOf(":") + 1);

/** Every descendant (and the node itself) with this local name, in document order. */
export function findAll(nodes: readonly XmlNode[], name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (list: readonly XmlNode[]) => {
    for (const n of list) {
      if (local(n.tag) === name) out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** The first descendant with this local name. */
export function find(nodes: readonly XmlNode[], name: string): XmlNode | undefined {
  for (const n of nodes) {
    if (local(n.tag) === name) return n;
    const inner = find(n.children, name);
    if (inner) return inner;
  }
  return undefined;
}

/** An attribute by its local name ("r:id" or "id"). */
export function attr(node: XmlNode | undefined, name: string): string | undefined {
  if (!node) return undefined;
  for (const [k, v] of Object.entries(node.attrs)) if (local(k) === name) return v;
  return undefined;
}

/** All text below a node. */
export function textOf(node: XmlNode): string {
  if (node.tag === "#text") return node.text ?? "";
  return node.children.map(textOf).join("");
}

/** A relationship id ("r:id"), which a slide or sheet entry may hold next to a plain "id". */
export function relId(node: XmlNode): string | undefined {
  for (const [k, v] of Object.entries(node.attrs)) if (k.includes(":") && local(k) === "id") return v;
  return undefined;
}

/** Decodes the XML entities and character references in text scanned without a parser. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return (
    s
      .replace(/&#x([0-9a-f]+);|&#(\d+);/gi, (m, hex: string | undefined, dec: string | undefined) => {
        const code = hex ? parseInt(hex, 16) : Number(dec);
        return code <= 0x10ffff ? String.fromCodePoint(code) : m;
      })
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // Last, so "&amp;lt;" becomes "&lt;", not "<".
      .replace(/&amp;/g, "&")
  );
}
