// draw.io (diagrams.net) files as text: each page's shapes and the connections between them.

import { inflateRawSync } from "node:zlib";
import { htmlToText } from "../files.js";
import type { ReadResult } from "./office.js";
import { attr, find, findAll, local, parseXml, textOf, type XmlNode } from "./xml.js";

/** The most a compressed diagram may inflate to. */
const MAX_DIAGRAM = 32 * 1024 * 1024;

/** A page's graph: inline, or compressed (deflate, base64, URI-encoded) as draw.io saves by default. */
function graphOf(diagram: XmlNode): XmlNode[] {
  const inline = find(diagram.children, "mxGraphModel");
  if (inline) return [inline];
  const packed = textOf(diagram).trim();
  if (!packed) return [];
  const xml = decodeURIComponent(inflateRawSync(Buffer.from(packed, "base64"), { maxOutputLength: MAX_DIAGRAM }).toString("utf8"));
  return parseXml(xml);
}

const label = (raw: string | undefined) => (raw ? htmlToText(raw).replace(/\s+/g, " ").trim() : "");

export function readDrawio(text: string): ReadResult {
  const doc = parseXml(text);
  const file = find(doc, "mxfile");
  const diagrams = file ? findAll(file.children, "diagram") : [];
  // A bare mxGraphModel (an exported page) is one unnamed page.
  const pages: { name: string; graph: XmlNode[] }[] = diagrams.length
    ? diagrams.map((d, i) => ({ name: attr(d, "name") ?? `Page ${i + 1}`, graph: graphOf(d) }))
    : [{ name: "Page 1", graph: doc.filter((n) => local(n.tag) === "mxGraphModel") }];
  if (!pages.some((p) => p.graph.length)) throw new Error("This file is not a draw.io diagram: it has no mxfile or mxGraphModel.");

  const sections: string[] = [];
  for (const page of pages) {
    type Cell = { label: string; vertex: boolean; edge: boolean; source?: string; target?: string; parent?: string; props?: string };
    const cells = new Map<string, Cell>();
    // A cell with custom properties is wrapped in <object> or <UserObject>, which holds its id and label.
    for (const n of findAll(page.graph, "mxCell")) {
      cells.set(attr(n, "id") ?? `cell-${cells.size}`, {
        label: label(attr(n, "value")),
        vertex: attr(n, "vertex") === "1",
        edge: attr(n, "edge") === "1",
        source: attr(n, "source"),
        target: attr(n, "target"),
        parent: attr(n, "parent"),
      });
    }
    for (const tag of ["object", "UserObject"]) {
      for (const o of findAll(page.graph, tag)) {
        const cell = find(o.children, "mxCell");
        const id = attr(o, "id");
        if (!cell || !id) continue;
        // Custom properties (an owner, a status) are part of what the diagram says.
        const props = Object.entries(o.attrs)
          .filter(([k, v]) => !["id", "label", "placeholders", "tooltip", "link"].includes(k) && v.trim())
          .map(([k, v]) => `${k}: ${label(v)}`)
          .join(", ");
        cells.set(id, {
          props: props || undefined,
          label: label(attr(o, "label")),
          vertex: attr(cell, "vertex") === "1",
          edge: attr(cell, "edge") === "1",
          source: attr(cell, "source"),
          target: attr(cell, "target"),
          parent: attr(cell, "parent"),
        });
      }
    }
    // Edge labels are often their own small cells, children of the edge.
    const edgeLabels = new Map<string, string[]>();
    for (const c of cells.values()) {
      if (c.vertex && c.parent && cells.get(c.parent)?.edge && c.label) edgeLabels.set(c.parent, [...(edgeLabels.get(c.parent) ?? []), c.label]);
    }
    const name = (id: string | undefined) => (!id ? "(not connected)" : cells.get(id)?.label || "(unnamed shape)");
    const shapes = [...cells.values()]
      .filter((c) => c.vertex && (c.label || c.props) && !(c.parent && cells.get(c.parent)?.edge))
      .map((c) => `- ${c.label || "(unnamed shape)"}${c.props ? ` (${c.props})` : ""}`);
    const links = [...cells.entries()]
      .filter(([, c]) => c.edge && (c.source || c.target))
      .map(([id, c]) => {
        const text = [c.label, ...(edgeLabels.get(id) ?? [])].filter(Boolean).join(" ");
        return `- ${name(c.source)} → ${name(c.target)}${text ? `: ${text}` : ""}`;
      });
    sections.push([`## Diagram: ${page.name}`, shapes.length ? `Shapes:\n${shapes.join("\n")}` : "_No labelled shapes._", ...(links.length ? [`Connections:\n${links.join("\n")}`] : [])].join("\n\n"));
  }
  return { content: sections.join("\n\n"), metadata: { pages: pages.length } };
}
