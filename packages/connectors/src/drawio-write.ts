// Diagrams as draw.io files, for the draw.io app on Confluence (D3: the file is attached to the
// page with a .drawio extension and shown by the app's macro). A diagram arrives as nodes and
// edges; it is laid out in layers from left to right, so that no line crosses a box: lines run
// only in the gaps between the columns, and a line that skips a column goes through it in a
// slot of its own.

export type DiagramKind = "salesforce" | "external" | "user" | "data" | "object";

export interface DiagramGraph {
  nodes: readonly { id: string; label: string; kind?: DiagramKind }[];
  edges: readonly { from: string; to: string; label?: string }[];
}

export interface PlacedNode {
  id: string;
  label: string;
  kind: DiagramKind;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedEdge {
  from: string;
  to: string;
  label?: string;
  /** The bends, in order from `from` to `to`. */
  points: { x: number; y: number }[];
}

export interface DiagramLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

const MARGIN = 40;
const NODE_WIDTH = 160;
const COLUMN_GAP = 100;
const ROW_GAP = 40;
/** The height a line that passes through a column takes in it. */
const PASS_HEIGHT = 20;
/** About the characters a 160-pixel box holds on one line of 12-pixel text. */
const CHARS_PER_LINE = 22;

const nodeHeight = (label: string) => Math.max(60, 24 + Math.ceil(Math.max(label.length, 1) / CHARS_PER_LINE) * 16);

interface Slot {
  /** A node, or a line passing through this column. */
  node?: PlacedNode;
  pass?: { edge: number };
  order: number;
  height: number;
  y: number;
}

/**
 * Places the nodes in columns by their longest path from a node nothing points to, orders each
 * column to keep lines short, and routes each edge through the columns it skips. Edges to an
 * unknown node are left out; a cycle is drawn by turning one of its edges back.
 */
export function layoutDiagram(graph: DiagramGraph): DiagramLayout {
  const nodes: PlacedNode[] = [];
  const index = new Map<string, number>();
  for (const n of graph.nodes) {
    if (index.has(n.id)) continue;
    index.set(n.id, nodes.length);
    const label = n.label.replace(/\s+/g, " ").trim();
    nodes.push({ id: n.id, label, kind: n.kind ?? "salesforce", x: 0, y: 0, width: NODE_WIDTH, height: nodeHeight(label) });
  }
  const edges = graph.edges.flatMap((e) => {
    const from = index.get(e.from);
    const to = index.get(e.to);
    return from === undefined || to === undefined ? [] : [{ from, to, label: e.label }];
  });

  // Cycles: an edge that goes back to a node still being walked is laid out the other way.
  const out = nodes.map(() => [] as number[]);
  edges.forEach((e, i) => e.from !== e.to && out[e.from]!.push(i));
  const state = nodes.map(() => 0);
  const reversed = new Set<number>();
  const walk = (v: number) => {
    state[v] = 1;
    for (const i of out[v]!) {
      const w = edges[i]!.to;
      if (state[w] === 1) reversed.add(i);
      else if (state[w] === 0) walk(w);
    }
    state[v] = 2;
  };
  nodes.forEach((_, v) => state[v] === 0 && walk(v));
  const dir = edges.map((e, i) => (reversed.has(i) ? { from: e.to, to: e.from } : { from: e.from, to: e.to }));

  // Columns: the longest path from a source, over the acyclic edges.
  const rank = nodes.map(() => 0);
  const incoming = nodes.map(() => 0);
  dir.forEach((d, i) => edges[i]!.from !== edges[i]!.to && incoming[d.to]!++);
  const queue = nodes.map((_, v) => v).filter((v) => incoming[v] === 0);
  for (let q = 0; q < queue.length; q++) {
    const v = queue[q]!;
    dir.forEach((d, i) => {
      if (d.from !== v || edges[i]!.from === edges[i]!.to) return;
      rank[d.to] = Math.max(rank[d.to]!, rank[v]! + 1);
      if (--incoming[d.to]! === 0) queue.push(d.to);
    });
  }
  const columns: Slot[][] = Array.from({ length: Math.max(0, ...rank) + 1 }, () => []);
  nodes.forEach((n, v) => columns[rank[v]!]!.push({ node: n, order: columns[rank[v]!]!.length, height: n.height, y: 0 }));

  // A line that skips columns takes a slot in each of them.
  const passes = new Map<number, Slot[]>();
  dir.forEach((d, i) => {
    const slots: Slot[] = [];
    for (let c = rank[d.from]! + 1; c < rank[d.to]!; c++) {
      const slot: Slot = { pass: { edge: i }, order: columns[c]!.length, height: PASS_HEIGHT, y: 0 };
      columns[c]!.push(slot);
      slots.push(slot);
    }
    if (slots.length) passes.set(i, slots);
  });

  // Order each column by the mean position of what it is joined to in the column before, then
  // after: a few sweeps keep most lines from crossing each other.
  const slotOf = new Map<PlacedNode, Slot>();
  columns.flat().forEach((s) => s.node && slotOf.set(s.node, s));
  const links: [Slot, Slot][] = [];
  dir.forEach((d, i) => {
    if (edges[i]!.from === edges[i]!.to) return;
    const chain = [slotOf.get(nodes[d.from]!)!, ...(passes.get(i) ?? []), slotOf.get(nodes[d.to]!)!];
    for (let k = 1; k < chain.length; k++) links.push([chain[k - 1]!, chain[k]!]);
  });
  const sweep = (c: number, before: boolean) => {
    const column = columns[c]!;
    const mean = new Map<Slot, number>();
    for (const s of column) {
      const near = links.filter(([a, b]) => (before ? b === s : a === s)).map(([a, b]) => (before ? a : b).order);
      mean.set(s, near.length ? near.reduce((x, y) => x + y, 0) / near.length : s.order);
    }
    column.sort((a, b) => mean.get(a)! - mean.get(b)! || a.order - b.order);
    column.forEach((s, k) => (s.order = k));
  };
  for (let round = 0; round < 4; round++) {
    for (let c = 1; c < columns.length; c++) sweep(c, true);
    for (let c = columns.length - 2; c >= 0; c--) sweep(c, false);
  }

  // Coordinates: each column centred on the tallest.
  const heightOf = (column: Slot[]) => column.reduce((h, s) => h + s.height, 0) + ROW_GAP * Math.max(0, column.length - 1);
  const tallest = Math.max(0, ...columns.map(heightOf));
  columns.forEach((column, c) => {
    let y = MARGIN + (tallest - heightOf(column)) / 2;
    for (const s of column) {
      s.y = y;
      if (s.node) Object.assign(s.node, { x: MARGIN + c * (NODE_WIDTH + COLUMN_GAP), y });
      y += s.height + ROW_GAP;
    }
  });

  const placed: PlacedEdge[] = edges.map((e, i) => {
    const slots = passes.get(i) ?? [];
    // Through each skipped column on a straight line, at the height of its slot.
    const points = slots.flatMap((s) => {
      const c = columns.findIndex((col) => col.includes(s));
      const left = MARGIN + c * (NODE_WIDTH + COLUMN_GAP);
      const y = s.y + PASS_HEIGHT / 2;
      return [
        { x: left, y },
        { x: left + NODE_WIDTH, y },
      ];
    });
    if (reversed.has(i)) points.reverse();
    return { from: nodes[e.from]!.id, to: nodes[e.to]!.id, ...(e.label ? { label: e.label } : {}), points };
  });
  return {
    nodes,
    edges: placed,
    width: MARGIN * 2 + columns.length * NODE_WIDTH + Math.max(0, columns.length - 1) * COLUMN_GAP,
    height: MARGIN * 2 + tallest,
  };
}

const STYLE: Record<DiagramKind, string> = {
  salesforce: "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;",
  external: "shape=process;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;",
  user: "rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;",
  data: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=10;fillColor=#fff2cc;strokeColor=#d6b656;",
  object: "rounded=0;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;",
};

/** A line leaves a box on its right and enters the next on its left, so it stays between the columns. */
const FORWARD = "exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;";
const BACKWARD = "exitX=0;exitY=0.5;exitDx=0;exitDy=0;entryX=1;entryY=0.5;entryDx=0;entryDy=0;";
const EDGE = "edgeStyle=none;rounded=0;html=1;endArrow=block;endFill=1;fontSize=11;labelBackgroundColor=#ffffff;";

/**
 * A label as draw.io shows it with html=1: HTML-escaped, then escaped again for the XML
 * attribute. Use the same for a value put into the file afterwards, such as a pseudonym's.
 */
export const drawioText = (s: string) => attr(s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r?\n/g, "&#10;");

/** The diagram as an uncompressed draw.io file. Node ids in the file are its own (n1, e1...), never the graph's. */
export function drawioXml(graph: DiagramGraph, name = "Page-1"): string {
  const layout = layoutDiagram(graph);
  const ids = new Map(layout.nodes.map((n, i) => [n.id, `n${i + 1}`]));
  const columnOf = new Map(layout.nodes.map((n) => [n.id, n.x]));
  const cells = layout.nodes.map(
    (n) =>
      `<mxCell id="${ids.get(n.id)}" value="${drawioText(n.label)}" style="${STYLE[n.kind]}" vertex="1" parent="1">` +
      `<mxGeometry x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" as="geometry"/></mxCell>`,
  );
  layout.edges.forEach((e, i) => {
    const loop = e.from === e.to;
    const back = columnOf.get(e.to)! < columnOf.get(e.from)!;
    const style = loop ? "html=1;endArrow=block;endFill=1;fontSize=11;" : `${EDGE}${back ? BACKWARD : FORWARD}`;
    const points = e.points.length ? `<Array as="points">${e.points.map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join("")}</Array>` : "";
    cells.push(
      `<mxCell id="e${i + 1}" value="${e.label ? drawioText(e.label) : ""}" style="${style}" edge="1" parent="1" source="${ids.get(e.from)}" target="${ids.get(e.to)}">` +
        `<mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell>`,
    );
  });
  return (
    `<mxfile host="sf-agent-po" type="device"><diagram id="d1" name="${attr(name)}">` +
    `<mxGraphModel dx="${layout.width}" dy="${layout.height}" grid="1" gridSize="10" guides="1" page="1" pageWidth="${Math.max(827, layout.width)}" pageHeight="${Math.max(400, layout.height)}">` +
    `<root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join("")}</root></mxGraphModel></diagram></mxfile>`
  );
}

/** The media type the draw.io app gives its attachments. */
export const DRAWIO_MEDIA_TYPE = "application/vnd.jgraph.mxfile";

/**
 * The draw.io app's macro, showing the attachment `name` of the page at `revision` (the
 * attachment's version). `name` must be a plain file name, such as "solution.drawio".
 */
export function drawioMacro(name: string, revision: number, width = 800): string {
  const param = (k: string, v: string | number) => `<ac:parameter ac:name="${k}">${attr(String(v))}</ac:parameter>`;
  return (
    `<ac:structured-macro ac:name="drawio" ac:schema-version="1">` +
    param("diagramName", name) +
    param("diagramDisplayName", name) +
    param("revision", revision) +
    param("contentVer", 1) +
    param("simpleViewer", "false") +
    param("lbox", "true") +
    param("width", width) +
    `</ac:structured-macro>`
  );
}
