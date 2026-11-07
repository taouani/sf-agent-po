// The metadata tools: index an org or a project in the background, and let the model look at
// what the index holds (a summary, a search, one component and what links to it). Names of
// components are API names and stay as they are; labels, descriptions, formulas, picklist
// values and the names of reports, dashboards, documents and email templates are free text,
// which can name people or clients, so they are masked before they are returned.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EDGE_KINDS, type ComponentType, type IndexedComponent, type Masker, type MetadataIndex, type Related, type SnapshotInfo } from "@sf-agent-po/core";
import type { BackgroundIndexer, IndexJob } from "@sf-agent-po/connectors";
import { z } from "zod";
import type { CallContext } from "./review.js";

type Text = { content: { type: "text"; text: string }[] };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });

export interface MetadataKit {
  masker: Masker;
  index: MetadataIndex;
  indexer: BackgroundIndexer;
  guard: <A extends { context?: string }>(fn: (args: A, call: CallContext) => Promise<Text>) => (args: A, call: CallContext) => Promise<Text & { isError?: boolean }>;
  contextName: z.ZodDefault<z.ZodString>;
}

/** Types whose names are chosen by users for their content (a report on a client): masked like text. */
const NAMED_LIKE_TEXT = new Set<string>([
  "Report",
  "Dashboard",
  "Document",
  "EmailTemplate",
  "ReportFolder",
  "DashboardFolder",
  "DocumentFolder",
  "EmailFolder",
  "EmailTemplateFolder",
]);

/** How much of a component's text (a description, help text, a formula) is shown. */
const MAX_TEXT = 2_000;
/** Related components listed for one component. */
const MAX_RELATED = 150;
/** Children (fields, rules...) listed for one component. */
const MAX_CHILDREN = 300;

/** Masks pieces of text for a context, each distinct piece once. */
class Pieces {
  private readonly pending = new Map<string, Promise<string>>();
  constructor(
    private readonly masker: Masker,
    private readonly context: string,
  ) {}

  mask(value: string): Promise<string> {
    if (!value.trim()) return Promise.resolve(value);
    let p = this.pending.get(value);
    if (!p) {
      p = this.masker.mask(this.context, value).then((r) => r.text);
      this.pending.set(value, p);
    }
    return p;
  }

  /** A component's name: masked for types named like text. */
  name(type: string, name: string): Promise<string> {
    return NAMED_LIKE_TEXT.has(type) ? this.mask(name) : Promise.resolve(name);
  }

  /** Every string in a value (attrs hold formulas, picklist values, help text), masked. */
  async deep(value: unknown): Promise<unknown> {
    if (typeof value === "string") return this.mask(value);
    if (Array.isArray(value)) return Promise.all(value.map((v) => this.deep(v)));
    if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await this.deep(v)] as const)));
    return value;
  }
}

/** The ready snapshot of each source, newest first. */
function readySources(index: MetadataIndex): SnapshotInfo[] {
  const seen = new Set<string>();
  return index.snapshots().filter((s) => s.status === "ready" && !seen.has(s.source) && (seen.add(s.source), true));
}

/** The snapshot a call works on: the named source, or the newest one. */
function pick(index: MetadataIndex, source: string | undefined): SnapshotInfo {
  const ready = readySources(index);
  if (!ready.length) throw new Error("Nothing is indexed yet. Index an org or a project folder with metadata_index first.");
  if (!source) return ready.sort((a, b) => ((a.finishedAt ?? "") < (b.finishedAt ?? "") ? 1 : -1))[0]!;
  const found = ready.find((s) => s.source === source || s.source === `org:${source}`);
  if (!found) throw new Error(`No indexed source "${source}". Indexed: ${ready.map((s) => s.source).join(", ")}.`);
  return found;
}

const total = (s: SnapshotInfo) => Object.values(s.stats.counts ?? {}).reduce<number>((n, c) => n + (c ?? 0), 0);

function describeSource(s: SnapshotInfo): string {
  return `${s.source} (${s.kind}, ${total(s)} components, indexed ${s.finishedAt ?? s.startedAt}${s.kind === "repo" && s.revision ? `, commit ${s.revision.slice(0, 12)}` : ""})`;
}

function describeJob(j: IndexJob): string {
  const when = j.finishedAt ? `finished ${j.finishedAt}` : `started ${j.startedAt}`;
  return `${j.target}: ${j.state}, ${when}${j.message ? `: ${j.message}` : ""}`;
}

const sourceArg = z.string().optional().describe('An indexed source, as metadata_sources lists it ("org:00D...", "repo:name#hash"); the newest one when omitted.');

export function registerMetadataTools(server: McpServer, kit: MetadataKit): void {
  const { index, indexer, guard, contextName } = kit;

  server.registerTool(
    "metadata_index",
    {
      title: "Index an org or a project",
      description:
        "Starts indexing a Salesforce org (its metadata is retrieved read-only with the user's sf CLI, which must be logged in to it) or a Salesforce project folder, in the background. " +
        "A large org takes several minutes, up to half an hour: call metadata_sources to follow it. Indexing again replaces the previous index of that source when it finishes.",
      inputSchema: {
        org: z.string().optional().describe("The org's alias or username, as sf org login saved it."),
        project: z.string().optional().describe("A Salesforce project folder (source or metadata format)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(async ({ org, project }: { org?: string; project?: string; context?: string }) => {
      if (Boolean(org) === Boolean(project)) throw new Error("Give either org or project.");
      const { job } = indexer.start(org ? { kind: "org", targetOrg: org } : { kind: "project", dir: project! });
      return text(`Indexing ${job.target} in the background (${job.state}). Call metadata_sources to follow it.`);
    }),
  );

  server.registerTool(
    "metadata_sources",
    {
      title: "List indexed orgs and projects",
      description: "Lists the orgs and project folders in the metadata index, and the indexing runs since the server started.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => {
      const ready = readySources(index);
      const jobs = indexer.list();
      const lines = [ready.length ? `Indexed:\n${ready.map((s) => `- ${describeSource(s)}`).join("\n")}` : "Nothing is indexed yet."];
      if (jobs.length) lines.push(`Runs since the server started:\n${jobs.map((j) => `- ${describeJob(j)}`).join("\n")}`);
      return text(lines.join("\n\n"));
    }),
  );

  server.registerTool(
    "metadata_summary",
    {
      title: "Summarize an org or a project",
      description:
        "Gives an overview of an indexed org or project: how many components of each type, and the busiest objects (fields, validation rules, record-triggered flows and Apex triggers on them). " +
        "Start here before a design, then look closer with metadata_search and metadata_component. Labels are masked like any input.",
      inputSchema: { context: contextName, source: sourceArg, objects: z.number().int().min(1).max(200).default(30).describe("How many objects to list.") },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ context, source, objects }: { context: string; source?: string; objects: number }) => {
      const snap = pick(index, source);
      const pieces = new Pieces(kit.masker, context);
      const counts = Object.entries(snap.stats.counts ?? {}).sort(([, a], [, b]) => (b ?? 0) - (a ?? 0));
      const busiest = index.objectSummary(snap.id, objects);
      const rows = await Promise.all(
        busiest.map(async (o) => {
          const label = o.label ? ` "${await pieces.mask(o.label)}"` : "";
          return `- ${o.name}${label}: ${o.fields} fields, ${o.rules} validation rules, ${o.flows} record-triggered flows, ${o.triggers} Apex triggers, ${o.linked} components link to it`;
        }),
      );
      const lines = [
        `Source: ${describeSource(snap)}`,
        `${snap.stats.referenced ?? 0} standard objects and fields are referenced without being in the source; ${snap.stats.edges ?? 0} links in all.`,
        `Components by type:\n${counts.map(([t, n]) => `- ${t}: ${n}`).join("\n")}`,
        busiest.length ? `Busiest objects:\n${rows.join("\n")}` : "No objects in this source.",
      ];
      return text(lines.join("\n\n"));
    }),
  );

  server.registerTool(
    "metadata_search",
    {
      title: "Search the metadata",
      description:
        "Finds components (objects, fields, flows, Apex, permission sets, layouts, pages...) whose API name, label or description contains every word of the query, best first. " +
        "Use API names or words from labels; then open one with metadata_component.",
      inputSchema: {
        context: contextName,
        source: sourceArg,
        query: z.string().min(1),
        types: z.array(z.string()).optional().describe('Only these types, e.g. ["CustomField", "Flow"].'),
        limit: z.number().int().min(1).max(200).default(30),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ context, source, query, types, limit }: { context: string; source?: string; query: string; types?: string[]; limit: number }) => {
      const snap = pick(index, source);
      const found = index.search(snap.id, query, { types: types as ComponentType[] | undefined, limit });
      if (!found.length) return text(`Nothing in ${snap.source} matches "${query}".`);
      const pieces = new Pieces(kit.masker, context);
      const lines = await Promise.all(found.map((c) => line(pieces, c)));
      return text(`${found.length} match(es) in ${snap.source}:\n${lines.join("\n")}`);
    }),
  );

  server.registerTool(
    "metadata_component",
    {
      title: "Open a component",
      description:
        "Shows one component: its details (field type, formula, flow trigger, Apex access...), its children (an object's fields, rules, record types) and what it is linked to: " +
        "what it reads, writes, calls or shows, and what reads, writes, calls or grants it. depth 2 also follows the links of those. Free text is masked like any input.",
      inputSchema: {
        context: contextName,
        source: sourceArg,
        type: z.string().describe('The component type, e.g. "CustomObject", "CustomField", "Flow", "ApexClass".'),
        name: z.string().describe('The API name: "Account", "Account.Tier__c", "Renewal_Flow".'),
        depth: z.number().int().min(1).max(2).default(1),
        kinds: z.array(z.enum(EDGE_KINDS)).optional().describe("Only these kinds of links."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(
      async ({ context, source, type, name, depth, kinds }: { context: string; source?: string; type: string; name: string; depth: number; kinds?: (typeof EDGE_KINDS)[number][] }) => {
        const snap = pick(index, source);
        const c = index.component(snap.id, type as ComponentType, name);
        if (!c) {
          const near = index.search(snap.id, name.split(".").pop() ?? name, { limit: 5 });
          const pieces = new Pieces(kit.masker, context);
          const hint = near.length ? ` Close matches:\n${(await Promise.all(near.map((n) => line(pieces, n)))).join("\n")}` : "";
          return text(`No ${type} named ${name} in ${snap.source}.${hint}`);
        }
        const pieces = new Pieces(kit.masker, context);
        const out: string[] = [`${await line(pieces, c)}`, `Source: ${snap.source}`];
        if (c.missing) out.push("Not in the source: it is only referenced (a standard object or field).");
        if (Object.keys(c.attrs).length) out.push(`Details: ${JSON.stringify(await pieces.deep(c.attrs))}`);
        if (c.text.trim()) {
          const t = await pieces.mask(c.text.length > MAX_TEXT ? c.text.slice(0, MAX_TEXT) : c.text);
          out.push(`Text${c.text.length > MAX_TEXT ? ` (first ${MAX_TEXT} characters)` : ""}:\n${t}`);
        }
        const children = index.children(snap.id, c.name, c.type);
        if (children.length) {
          const shown = children.slice(0, MAX_CHILDREN);
          out.push(`Children (${children.length}${children.length > shown.length ? `, first ${shown.length}` : ""}):\n${(await Promise.all(shown.map((ch) => line(pieces, ch)))).join("\n")}`);
        }
        const related = index.related(c.id, { depth, kinds }).filter((r) => !(r.kind === "part_of" && r.direction === "in" && r.depth === 1 && r.component.parent));
        if (related.length) {
          const shown = related.slice(0, MAX_RELATED);
          out.push(`Linked (${related.length}${related.length > shown.length ? `, first ${shown.length}` : ""}):\n${(await Promise.all(shown.map((r) => relatedLine(pieces, r)))).join("\n")}`);
        } else out.push("No links found in the index. Dynamic Apex, SOQL built from strings and long formula chains are not seen: check with the user.");
        return text(out.join("\n\n"));
      },
    ),
  );
}

/** One component on one line: type, API name, label and parent. */
async function line(pieces: Pieces, c: IndexedComponent): Promise<string> {
  const name = await pieces.name(c.type, c.name);
  const label = c.label ? ` "${await pieces.mask(c.label)}"` : "";
  const missing = c.missing ? " (referenced only)" : "";
  const kind = typeof c.attrs.type === "string" ? ` [${await pieces.mask(c.attrs.type)}]` : "";
  return `- ${c.type} ${name}${label}${kind}${missing}`;
}

const VERB: Record<string, [string, string]> = {
  part_of: ["is part of", "has part"],
  references: ["references", "is referenced by"],
  reads: ["reads", "is read by"],
  writes: ["writes", "is written by"],
  triggers_on: ["runs on records of", "has automation"],
  calls: ["calls", "is called by"],
  grants: ["grants access to", "is granted by"],
  includes: ["includes", "is included in"],
  shows: ["shows", "is shown by"],
};

async function relatedLine(pieces: Pieces, r: Related): Promise<string> {
  const verbs = r.kinds.map((k) => VERB[k]?.[r.direction === "out" ? 0 : 1] ?? k).join(", ");
  const via = r.depth > 1 ? ` (${r.depth} links away)` : "";
  return `${verbs}${via}: ${(await line(pieces, r.component)).slice(2)}`;
}
