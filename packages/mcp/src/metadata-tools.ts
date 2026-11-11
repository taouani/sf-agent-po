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
export const NAMED_LIKE_TEXT = new Set<string>([
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

/** A host name, as a query: two labels or more, ending in letters (not Account.Name, which has capitals and no TLD shape). */
const HOST = /^(?=[a-z0-9.-]+$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** How much of a component's text (a description, help text, a formula) is shown. */
const MAX_TEXT = 2_000;
/** Related components listed for one component. */
const MAX_RELATED = 150;
/** Children (fields, rules...) listed for one component. */
const MAX_CHILDREN = 300;
/** Entries kept of each list or map in a component's details (a profile's field permissions). */
const MAX_DETAIL_ENTRIES = 40;
/** How much of a component's details is shown, as JSON. */
const MAX_DETAILS = 6_000;

/**
 * A component's details with long lists and maps cut to their first entries, and a count of
 * the rest: a profile lists every field of the org.
 */
export function trimDetails(value: unknown): unknown {
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_DETAIL_ENTRIES).map(trimDetails);
    return value.length > kept.length ? [...kept, `and ${value.length - kept.length} more`] : kept;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const kept = entries.slice(0, MAX_DETAIL_ENTRIES).map(([k, v]) => [k, trimDetails(v)] as const);
    return Object.fromEntries(entries.length > kept.length ? [...kept, ["(more)", `${entries.length - kept.length} more entries`]] : kept);
  }
  return value;
}

/** Masks pieces of text for a context, each distinct piece once. */
export class Pieces {
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

  /** What the model wrote (a masked report name, a query), with the real values put back, to look it up. */
  real(value: string): string {
    return this.masker.unmask(this.context, value).text;
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
export function readySources(index: MetadataIndex): SnapshotInfo[] {
  const seen = new Set<string>();
  return index.snapshots().filter((s) => s.status === "ready" && !seen.has(s.source) && (seen.add(s.source), true));
}

/** The snapshot a call works on: the named source, or the newest one. */
export function pick(index: MetadataIndex, source: string | undefined): SnapshotInfo {
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

/** A run, with its progress line or error masked: an error can quote a report's name or the CLI's output. */
async function describeJob(pieces: Pieces, j: IndexJob): Promise<string> {
  const when = j.finishedAt ? `finished ${j.finishedAt}` : `started ${j.startedAt}`;
  return `${j.target}: ${j.state}, ${when}${j.message ? `: ${await pieces.mask(j.message)}` : ""}`;
}

export const sourceArg = z.string().optional().describe('An indexed source, as metadata_sources lists it ("org:00D...", "repo:name#hash"); the newest one when omitted.');

export function registerMetadataTools(server: McpServer, kit: MetadataKit): void {
  const { index, indexer, guard, contextName } = kit;

  server.registerTool(
    "metadata_index",
    {
      title: "Index an org or a project",
      description:
        "Starts indexing a Salesforce org (its metadata is retrieved read-only with the user's sf CLI, which must be logged in to it), a Salesforce project folder, or a remote repository (cloned with the user's own gh, glab or git), in the background. " +
        "A large org takes several minutes, up to half an hour: call metadata_sources to follow it. Indexing again replaces the previous index of that source when it finishes.",
      inputSchema: {
        org: z.string().optional().describe("The org's alias or username, as sf org login saved it."),
        project: z.string().optional().describe("A Salesforce project folder (source or metadata format)."),
        repo: z.string().optional().describe("A remote repository: github:owner/repo, gitlab:group/repo, azure-devops:<clone URL> or git:<clone URL>, with #<branch or tag> to pick one."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(async ({ org, project, repo }: { org?: string; project?: string; repo?: string; context?: string }) => {
      if ([org, project, repo].filter(Boolean).length !== 1) throw new Error("Give one of org, project or repo.");
      const { job } = indexer.start(org ? { kind: "org", targetOrg: org } : repo ? { kind: "remote", repo } : { kind: "project", dir: project! });
      return text(`Indexing ${job.target} in the background (${job.state}). Call metadata_sources to follow it.`);
    }),
  );

  server.registerTool(
    "metadata_sources",
    {
      title: "List indexed orgs and projects",
      description: "Lists the orgs and project folders in the metadata index, and the indexing runs since the server started.",
      inputSchema: { context: contextName },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ context }: { context: string }) => {
      const ready = readySources(index);
      const jobs = indexer.list();
      const pieces = new Pieces(kit.masker, context);
      const lines = [ready.length ? `Indexed:\n${ready.map((s) => `- ${describeSource(s)}`).join("\n")}` : "Nothing is indexed yet."];
      if (jobs.length) lines.push(`Runs since the server started:\n${(await Promise.all(jobs.map(async (j) => `- ${await describeJob(pieces, j)}`))).join("\n")}`);
      return text(lines.join("\n\n"));
    }),
  );

  server.registerTool(
    "metadata_summary",
    {
      title: "Summarize an org or a project",
      description:
        "Gives an overview of an indexed org or project: how many components of each type, the busiest objects (fields, validation rules, and the flows and Apex triggers that run on their records), " +
        "and its integrations: the hosts it calls, through which named credentials, remote site settings, outbound messages or Apex endpoints, from which classes and flows; the connected apps that sign in; the event channels. " +
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
          return `- ${o.name}${label}: ${o.fields} fields, ${o.rules} validation rules, ${o.flows} flows run on its records, ${o.triggers} Apex triggers, ${o.linked} components link to it`;
        }),
      );
      const lines = [
        `Source: ${describeSource(snap)}`,
        `${snap.stats.referenced ?? 0} standard objects and fields are referenced without being in the source; ${snap.stats.edges ?? 0} links in all.`,
        `Components by type:\n${counts.map(([t, n]) => `- ${t}: ${n}`).join("\n")}`,
        busiest.length ? `Busiest objects:\n${rows.join("\n")}` : "No objects in this source.",
        ...(await integrationLines(index, snap.id, pieces)),
      ];
      return text(lines.join("\n\n"));
    }),
  );

  server.registerTool(
    "metadata_search",
    {
      title: "Search the metadata",
      description:
        "Finds components (objects, fields, flows, Apex, permission sets, layouts, pages, reports, named credentials...) whose API name, label or description contains every word of the query, best first. " +
        "A host (erp.example.com) finds what calls or allows it. Use API names or words from labels; then open one with metadata_component.",
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
      const pieces = new Pieces(kit.masker, context);
      const real = pieces.real(query).trim();
      // A host (erp.example.com) is found in what calls or allows it: named credentials, remote
      // sites, outbound messages, connected apps and Apex endpoints.
      const byHost = HOST.test(real) ? index.withHost(snap.id, real, limit).filter((c) => !types?.length || types.includes(c.type)) : [];
      const seen = new Set(byHost.map((c) => c.id));
      const found = [...byHost, ...index.search(snap.id, real, { types: types as ComponentType[] | undefined, limit }).filter((c) => !seen.has(c.id))].slice(0, limit);
      if (!found.length) return text(`Nothing in ${snap.source} matches "${query}".`);
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
        const pieces = new Pieces(kit.masker, context);
        // A report's name was masked when it was listed: the model passes the masked one back.
        const real = pieces.real(name);
        const c = index.component(snap.id, type as ComponentType, real);
        if (!c) {
          const near = index.search(snap.id, real.split(/[./]/).pop() || real, { limit: 5 });
          const hint = near.length ? ` Close matches:\n${(await Promise.all(near.map((n) => line(pieces, n)))).join("\n")}` : "";
          return text(`No ${type} named ${name} in ${snap.source}.${hint}`);
        }
        const out: string[] = [`${await line(pieces, c)}`, `Source: ${snap.source}`];
        if (c.missing) out.push("Not in the source: it is only referenced (a standard object or field).");
        if (Object.keys(c.attrs).length) {
          const details = JSON.stringify(await pieces.deep(trimDetails(c.attrs)));
          out.push(details.length > MAX_DETAILS ? `Details (first ${MAX_DETAILS} characters): ${details.slice(0, MAX_DETAILS)}` : `Details: ${details}`);
        }
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

/** Hosts listed in a summary's integrations, and callers listed for each. */
const MAX_HOSTS = 40;
const MAX_CALLERS = 8;
/** Shown for a named credential whose URL is set at run time (a merge field) or not kept. */
const NO_HOST = "(host not in the metadata)";

const list = (items: string[], max: number) => (items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", "));

/**
 * Where the org connects, for metadata_summary: each host, what it is reached through (a named
 * credential, a remote site setting, an outbound message, an endpoint in Apex) and from which
 * classes and flows; the connected apps that sign in from outside; the event channels.
 * Hosts are masked like attrs, since one can name a client.
 */
export async function integrationLines(index: MetadataIndex, snapshot: number, pieces: Pieces): Promise<string[]> {
  const hosts = new Map<string, { through: string[]; from: string[] }>();
  const at = (host: string) => {
    let h = hosts.get(host);
    if (!h) hosts.set(host, (h = { through: [], from: [] }));
    return h;
  };
  const shown = async (c: IndexedComponent) => (await line(pieces, c)).slice(2);
  const hostOf = (c: IndexedComponent) => (typeof c.attrs.host === "string" ? c.attrs.host : undefined);

  for (const nc of index.ofTypes(snapshot, ["NamedCredential"])) {
    const h = at(hostOf(nc) ?? NO_HOST);
    const auth = index.related(nc.id, { kinds: ["references"] }).filter((r) => r.direction === "out").map((r) => r.component.name);
    h.through.push(`named credential ${nc.name}${auth.length ? ` (authenticates with ${auth.join(", ")})` : ""}`);
    // Who calls through it: Apex (callout:Name), external services, and the flows and classes that call those.
    const callers = index
      .related(nc.id, { depth: 2, kinds: ["calls", "references"] })
      .filter((r) => r.direction === "in" && !["NamedCredential", "ExternalCredential"].includes(r.component.type));
    for (const r of callers) h.from.push(`${await shown(r.component)}${r.depth > 1 ? " (through one of these)" : ""}`);
  }
  const sites = index.ofTypes(snapshot, ["RemoteSiteSetting"]);
  for (const rs of sites) {
    const host = hostOf(rs);
    if (host) at(host).through.push(`remote site setting ${rs.name}${rs.attrs.active === false ? " (inactive)" : ""}`);
  }
  for (const om of index.ofTypes(snapshot, ["WorkflowOutboundMessage"])) {
    const fields = Array.isArray(om.attrs.fields) ? om.attrs.fields.length : 0;
    at(hostOf(om) ?? NO_HOST).through.push(`outbound message ${om.name} (sends ${fields} field(s) of ${om.parent ?? "its object"})`);
  }
  for (const apex of index.ofTypes(snapshot, ["ApexClass", "ApexTrigger"], { attr: "calloutHosts" })) {
    for (const host of (apex.attrs.calloutHosts as unknown[]).filter((h): h is string => typeof h === "string")) {
      const h = at(host);
      if (!h.through.includes("an endpoint written in Apex")) h.through.push("an endpoint written in Apex");
      h.from.push(await shown(apex));
    }
  }
  const lines: string[] = [];
  if (hosts.size) {
    const sorted = [...hosts].sort(([a], [b]) => (a === NO_HOST ? 1 : b === NO_HOST ? -1 : a < b ? -1 : a > b ? 1 : 0));
    const rows = await Promise.all(
      sorted.slice(0, MAX_HOSTS).map(async ([host, h]) => {
        const name = host === NO_HOST ? host : await pieces.mask(host);
        const from = [...new Set(h.from)];
        // Apex calling a host directly needs a remote site setting (or a named credential) to be allowed.
        const unallowed = h.through.includes("an endpoint written in Apex") && host !== NO_HOST && !h.through.some((t) => t.startsWith("remote site setting") || t.startsWith("named credential"));
        return `- ${name}: through ${h.through.join("; ")}${from.length ? `; from ${list(from, MAX_CALLERS)}` : ""}${unallowed ? " [no remote site setting or named credential in the source allows this host]" : ""}`;
      }),
    );
    lines.push(`Integrations (where the org connects; only hosts are kept of URLs):\n${rows.join("\n")}${hosts.size > MAX_HOSTS ? `\n- and ${hosts.size - MAX_HOSTS} more hosts` : ""}`);
  }
  const apps = index.ofTypes(snapshot, ["ConnectedApp"]);
  if (apps.length) {
    const rows = await Promise.all(
      apps.slice(0, MAX_HOSTS).map(async (a) => {
        const scopes = Array.isArray(a.attrs.scopes) && a.attrs.scopes.length ? `scopes ${a.attrs.scopes.join(", ")}` : a.attrs.saml ? "SAML" : a.attrs.canvas ? "canvas" : "no OAuth scopes";
        const callbacks = Array.isArray(a.attrs.callbackHosts) ? (await Promise.all(a.attrs.callbackHosts.map((h) => pieces.mask(String(h))))).join(", ") : "";
        return `- ${await shown(a)}: ${scopes}${callbacks ? `; returns to ${callbacks}` : ""}`;
      }),
    );
    lines.push(`Connected apps (systems that sign in to the org):\n${rows.join("\n")}${apps.length > MAX_HOSTS ? `\n- and ${apps.length - MAX_HOSTS} more` : ""}`);
  }
  const members = index.ofTypes(snapshot, ["PlatformEventChannelMember"]);
  if (members.length) {
    const byChannel = new Map<string, string[]>();
    for (const m of members) {
      const channel = typeof m.attrs.channel === "string" ? m.attrs.channel : "(no channel)";
      byChannel.set(channel, [...(byChannel.get(channel) ?? []), typeof m.attrs.entity === "string" ? m.attrs.entity : m.name]);
    }
    const rows = [...byChannel].sort(([a], [b]) => (a < b ? -1 : 1)).map(([channel, entities]) => `- ${channel === "ChangeEvents" ? "ChangeEvents (change data capture)" : channel}: ${list(entities.sort(), 20)}`);
    lines.push(`Event channels (what subscribers outside the org receive):\n${rows.join("\n")}`);
  }
  return lines;
}

/** One component on one line: type, API name, label, and its kind (a field's type). */
export async function line(pieces: Pieces, c: IndexedComponent): Promise<string> {
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
