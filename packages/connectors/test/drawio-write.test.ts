import { XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { AtlassianClient } from "../src/atlassian.js";
import { diagramNames, markdownToStorage } from "../src/confluence-storage.js";
import { drawioMacro, drawioXml, layoutDiagram, type DiagramGraph, type DiagramLayout } from "../src/drawio-write.js";
import { readDrawio } from "../src/readers/drawio.js";

type Point = { x: number; y: number };

/** The lines of a laid-out diagram as draw.io draws them: from the side of one box, through the bends, to the side of the next. */
function segments(layout: DiagramLayout): { edge: number; a: Point; b: Point }[] {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  return layout.edges.flatMap((e, edge) => {
    if (e.from === e.to) return [];
    const from = byId.get(e.from)!;
    const to = byId.get(e.to)!;
    const back = to.x < from.x;
    const start = { x: back ? from.x : from.x + from.width, y: from.y + from.height * e.exitY };
    const end = { x: back ? to.x + to.width : to.x, y: to.y + to.height * e.entryY };
    const path = [start, ...e.points, end];
    return path.slice(1).map((b, i) => ({ edge, a: path[i]!, b }));
  });
}

/** Whether the segment a-b goes through the inside of the box (its border excluded). */
function crosses(a: Point, b: Point, box: { x: number; y: number; width: number; height: number }): boolean {
  const [x0, x1, y0, y1] = [box.x + 0.5, box.x + box.width - 0.5, box.y + 0.5, box.y + box.height - 0.5];
  // Liang-Barsky clipping.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dy, a.y - y0],
    [dy, y1 - a.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

function expectNoLineThroughABox(graph: DiagramGraph) {
  const layout = layoutDiagram(graph);
  for (const s of segments(layout)) {
    const e = layout.edges[s.edge]!;
    for (const n of layout.nodes) {
      if (n.id === e.from || n.id === e.to) continue;
      expect(crosses(s.a, s.b, n), `${e.from} -> ${e.to} crosses ${n.id}`).toBe(false);
    }
  }
  // No two boxes overlap.
  for (const [i, a] of layout.nodes.entries())
    for (const b of layout.nodes.slice(i + 1)) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id} overlaps ${b.id}`).toBe(true);
  return layout;
}

describe("draw.io diagrams", () => {
  it("lays out the spike's diagram without the line through Contact", () => {
    // In the Confluence check, Opportunity -> Account was drawn through Contact.
    const layout = expectNoLineThroughABox({
      nodes: [
        { id: "a", label: "Account" },
        { id: "c", label: "Contact" },
        { id: "o", label: "Opportunity" },
      ],
      edges: [
        { from: "c", to: "a" },
        { from: "o", to: "a" },
      ],
    });
    const x = Object.fromEntries(layout.nodes.map((n) => [n.id, n.x]));
    expect(x.c).toBe(x.o);
    expect(x.a).toBeGreaterThan(x.c!);
  });

  it("routes lines that skip columns through slots of their own, turns a cycle back, and leaves out unknown ends", () => {
    const graph: DiagramGraph = {
      nodes: ["user", "site", "sf", "flow", "erp", "dw", "mail"].map((id) => ({ id, label: `${id} component with a rather long label to wrap` })),
      edges: [
        { from: "user", to: "site" },
        { from: "site", to: "sf" },
        { from: "sf", to: "flow" },
        { from: "flow", to: "erp" },
        { from: "user", to: "erp", label: "phones" },
        { from: "site", to: "dw" },
        { from: "erp", to: "sf", label: "sync back" },
        { from: "dw", to: "dw" },
        { from: "mail", to: "nowhere" },
        { from: "user", to: "flow" },
      ],
    };
    const layout = expectNoLineThroughABox(graph);
    expect(layout.edges).toHaveLength(9);
    const long = layout.edges.find((e) => e.from === "user" && e.to === "erp")!;
    expect(long.points.length).toBeGreaterThan(0);
    const back = layout.edges.find((e) => e.from === "erp")!;
    expect(back.points.length).toBeGreaterThan(0);
    // Each bend pair is level: a skipped column is crossed on a straight line.
    for (let i = 0; i < long.points.length; i += 2) expect(long.points[i]!.y).toBe(long.points[i + 1]!.y);
  });

  it("keeps lines clear of boxes in random diagrams", () => {
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let round = 0; round < 40; round++) {
      const count = 2 + rand(12);
      const nodes = Array.from({ length: count }, (_, i) => ({ id: `n${i}`, label: "x".repeat(1 + rand(90)) }));
      const edges = Array.from({ length: rand(count * 2) }, () => ({ from: `n${rand(count)}`, to: `n${rand(count)}` }));
      expectNoLineThroughABox({ nodes, edges });
    }
  });

  it("writes a file the draw.io reader reads back, with labels escaped and ids of its own", () => {
    const xml = drawioXml({
      nodes: [
        { id: "sf", label: 'Sales <Cloud> & "Service"', kind: "salesforce" },
        { id: "erp", label: "ERP\nline two", kind: "external" },
        { id: "u", label: "Advisor", kind: "user" },
        { id: "db", label: "Archive", kind: "data" },
      ],
      edges: [
        { from: "u", to: "sf", label: "works <cases>" },
        { from: "sf", to: "erp" },
        { from: "erp", to: "db" },
      ],
    });
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain('value="Sales &amp;lt;Cloud&amp;gt; &amp;amp; &amp;quot;Service&amp;quot;"');
    expect(xml).not.toMatch(/id="(sf|erp|u|db)"/);
    expect(xml).toContain("shape=cylinder3");
    const read = readDrawio(xml).content;
    expect(read).toContain("Sales <Cloud> & \"Service\"");
    expect(read).toContain("Advisor");
    expect(read).toContain("works");
  });

  it("draws two lines between the same boxes apart, and widens the gap for long labels", () => {
    const layout = expectNoLineThroughABox({
      nodes: [
        { id: "case", label: "Case" },
        { id: "contact", label: "Contact" },
      ],
      edges: [
        { from: "case", to: "contact", label: "ContactId" },
        { from: "case", to: "contact", label: "Other_Contact_With_A_Long_Name__c" },
        { from: "contact", to: "case", label: "Last_Case__c" },
      ],
    });
    const exits = layout.edges.map((e) => `${e.exitY}/${e.entryY}`);
    expect(new Set(exits).size).toBe(3);
    const [a, b] = layout.nodes;
    expect(Math.abs(b!.x - a!.x) - 160).toBeGreaterThan("Other_Contact_With_A_Long_Name__c".length * 6);
  });

  it("names the attachment and its version in the macro", () => {
    const macro = drawioMacro("solution.drawio", 3, 640);
    expect(macro).toContain('<ac:structured-macro ac:name="drawio"');
    expect(macro).toContain('<ac:parameter ac:name="diagramName">solution.drawio</ac:parameter>');
    expect(macro).toContain('<ac:parameter ac:name="revision">3</ac:parameter>');
    expect(macro).toContain('<ac:parameter ac:name="width">640</ac:parameter>');
  });

  it("shows a named Mermaid block as the storage given for it, and the others as code", () => {
    const md = "# D\n\n```mermaid diagram=solution\nflowchart LR\n```\n\n```mermaid diagram=data-model\nerDiagram\n```\n\n```mermaid\nflowchart TB\n```";
    const storage = markdownToStorage(md, { diagrams: { solution: drawioMacro("solution.drawio", 1) } });
    expect(storage).toContain('<ac:parameter ac:name="diagramName">solution.drawio</ac:parameter>');
    expect(storage).not.toContain("flowchart LR");
    expect(storage).toContain("erDiagram");
    expect(storage).toContain("flowchart TB");
    expect(XMLValidator.validate(`<r>${storage.replace(/ac:|ri:/g, "")}</r>`)).toBe(true);
    // Not kept for the next conversion.
    expect(markdownToStorage(md)).toContain("flowchart LR");
    // A name such as "constructor" is not taken from the object's prototype.
    expect(markdownToStorage("```mermaid diagram=constructor\nx\n```", { diagrams: {} })).toContain("<ac:plain-text-body>");
  });

  it("finds the named Mermaid blocks as the conversion reads them", () => {
    expect(diagramNames("```mermaid diagram=solution\nx\n```\n\n````md\n```mermaid diagram=inside\n```\n````\n\n- item\n\n  ```mermaid diagram=data-model\n  y\n  ```\n\n```mermaid diagram=solution\nz\n```")).toEqual([
      "solution",
      "data-model",
    ]);
  });

  it("refuses an attachment answer without the file's version", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ results: [{ title: "other.drawio", version: { number: 2 } }] }), { status: 200 })) as unknown as typeof fetch;
    const client = new AtlassianClient({ siteUrl: "https://x.atlassian.net", email: "me@example.com", apiToken: "tok" }, fakeFetch);
    await expect(client.attachFile({ pageId: "1", name: "solution.drawio", mediaType: "application/vnd.jgraph.mxfile", content: "x" })).rejects.toThrow(
      "Confluence did not return the version of the attached file solution.drawio.",
    );
  });

  it("attaches a file to a page as a form, and returns its version", async () => {
    const calls: { method: string; url: string; headers: Headers; body: unknown }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? "GET", url, headers: new Headers(init.headers), body: init.body });
      return new Response(JSON.stringify({ results: [{ id: "att1", title: "solution.drawio", version: { number: 4 } }] }), { status: 200 });
    }) as typeof fetch;
    const client = new AtlassianClient({ siteUrl: "https://x.atlassian.net", email: "me@example.com", apiToken: "tok" }, fakeFetch);
    await expect(client.attachFile({ pageId: "42", name: "solution.drawio", mediaType: "application/vnd.jgraph.mxfile", content: "<mxfile/>" })).resolves.toEqual({ version: 4 });
    const [call] = calls;
    expect(call!.method).toBe("PUT");
    expect(call!.url).toBe("https://x.atlassian.net/wiki/rest/api/content/42/child/attachment");
    expect(call!.headers.get("X-Atlassian-Token")).toBe("no-check");
    expect(call!.headers.get("Content-Type")).toBeNull();
    const form = call!.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("solution.drawio");
    expect(file.type).toBe("application/vnd.jgraph.mxfile");
    expect(await file.text()).toBe("<mxfile/>");
    expect(form.get("minorEdit")).toBe("true");
  });
});
