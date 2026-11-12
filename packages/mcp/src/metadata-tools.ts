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
/** Lines of Apex shown by one metadata_code call by default, and at most. */
const CODE_LINES = 200;
const MAX_CODE_LINES = 500;
/** Lines listed for a metadata_code search, and lines searched before it stops. */
const MAX_FOUND = 60;
const MAX_SEARCHED_HITS = 200;
/** A line of code is cut after this many characters, and one answer after about this many. */
const MAX_LINE_CHARS = 400;
const MAX_CODE_CHARS = 30_000;

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
      const byHost = HOST.test(real.toLowerCase()) ? index.withHost(snap.id, real, limit).filter((c) => !types?.length || types.includes(c.type)) : [];
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
          out.push(`Linked (${related.length}${related.length > shown.length ? `, first ${shown.length}` : ""}):\n${(await Promise.all(shown.map((r) => relatedLine(pieces, r, c.type)))).join("\n")}`);
        } else out.push("No links found in the index. Dynamic Apex, SOQL built from strings and long formula chains are not seen: check with the user.");
        if ((c.type === "ApexClass" || c.type === "ApexTrigger") && index.hasBody(c.id)) {
          out.push(`Its code (${String(c.attrs.lines ?? "?")} lines) can be read with metadata_code${c.attrs.dynamic ? ", which shows what the links above cannot: the queries it builds from strings and the classes it names at run time" : ""}.`);
        } else if (c.type === "Flow" && index.hasBody(c.id)) {
          out.push(`Its logic (${String(c.attrs.lines ?? "?")} lines) can be read with metadata_code: the conditions of its decisions, its record filters and what it assigns and calls, which the links above do not show.`);
        }
        return text(out.join("\n\n"));
      },
    ),
  );

  server.registerTool(
    "metadata_code",
    {
      title: "Read Apex code or flow logic",
      description:
        "Shows the code of an Apex class or trigger, or the logic of a flow, from the index, with line numbers, masked like any input: personal data in strings and comments is replaced by pseudonyms. " +
        "A flow is shown as an outline: how it starts and its entry conditions, then each element in the order the flow reaches it (decision outcomes with their conditions, record filters, assignments, actions and their inputs, where each goes next), then its variables, constants and formulas. " +
        "Use it when the links are not enough: for code the index marks as dynamic (queries built from strings, classes named at run time), or to say when and why a flow does something. Read it and say what it does. " +
        "find lists the lines that contain a text (\"Database.query\", a field name), from the line given by from, to read around them with from.",
      inputSchema: {
        context: contextName,
        source: sourceArg,
        type: z.enum(["ApexClass", "ApexTrigger", "Flow"]),
        name: z.string().describe('The class, trigger or flow API name, e.g. "Account_SM".'),
        from: z.number().int().min(1).default(1).describe("The first line to show, or to search from."),
        lines: z.number().int().min(1).max(MAX_CODE_LINES).default(CODE_LINES).describe("How many lines to show."),
        find: z.string().min(2).optional().describe("Instead of a range: the lines that contain this text, any case."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(
      async ({ context, source, type, name, from, lines, find }: { context: string; source?: string; type: "ApexClass" | "ApexTrigger" | "Flow"; name: string; from: number; lines: number; find?: string }) => {
        const snap = pick(index, source);
        const pieces = new Pieces(kit.masker, context);
        const c = index.component(snap.id, type, name);
        if (!c || c.missing) return text(`No ${type} named ${name} in ${snap.source}.`);
        const body = index.body(c.id);
        if (body === undefined) {
          return text(
            c.attrs.tooLarge
              ? `${name} is too large for the index to keep its ${type === "Flow" ? "logic" : "code"}.`
              : c.attrs.lines === undefined && type !== "Flow"
                ? `${name} could not be read when ${snap.source} was indexed, so the index has no code for it.`
                : `The index of ${snap.source} has no code for ${name}: it was built by an earlier version. Index the source again (npx sf-agent-po@next index) and ask again.`,
          );
        }
        const all = body.replace(/\r\n?/g, "\n").split("\n");
        const width = String(all.length).length;
        const numbered = (i: number) => {
          const l = all[i]!;
          const cut = l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)} ... (${l.length - MAX_LINE_CHARS} more characters)` : l;
          return `${String(i + 1).padStart(width)}  ${cut}`;
        };
        if (from > all.length) return text(`${name} has ${all.length} lines.`);
        if (find !== undefined) {
          // The model may pass a pseudonym back: look for the real text.
          const wanted = pieces.real(find).toLowerCase();
          const hits: number[] = [];
          for (let i = from - 1; i < all.length && hits.length < MAX_SEARCHED_HITS; i++) if (all[i]!.toLowerCase().includes(wanted)) hits.push(i);
          // Only lines that still show what was asked once masked: a real name the model guessed
          // must not be confirmed by the lines it finds, shown with its pseudonym.
          const masked = await Promise.all(hits.map((i) => pieces.mask(numbered(i))));
          const shown = masked.filter((l) => l.toLowerCase().includes(find.toLowerCase()));
          if (!shown.length) return text(`No line of ${name}${from > 1 ? ` from line ${from}` : ""} contains "${find}".`);
          const listed = shown.slice(0, MAX_FOUND);
          const last = hits[hits.length - 1]!;
          const more = hits.length === MAX_SEARCHED_HITS && last + 1 < all.length ? ` More may follow: search again from line ${last + 2}.` : "";
          return text(
            `${type} ${name}: ${shown.length} line(s)${from > 1 ? ` from line ${from}` : ""} contain "${find}"${shown.length > listed.length ? `, the first ${listed.length} shown` : ""}. Read around one with from.${more}\n\n${listed.join("\n")}`,
          );
        }
        let last = Math.min(all.length, from + lines - 1);
        // A window of very long lines (a test class's JSON fixtures) is cut short.
        let size = 0;
        for (let i = from - 1; i < last; i++) {
          size += numbered(i).length + 1;
          if (size > MAX_CODE_CHARS && i > from - 1) {
            last = i;
            break;
          }
        }
        const code = await pieces.mask(all.slice(from - 1, last).map((_, k) => numbered(from - 1 + k)).join("\n"));
        const more = last < all.length ? ` More from line ${last + 1}.` : "";
        return text(`${type} ${name}, lines ${from}-${last} of ${all.length}, from ${snap.source}. Personal data is masked.${more}\n\n${code}`);
      },
    ),
  );
}

/** Hosts listed in a summary's integrations, callers listed for each, and components of each kind named for one host. */
const MAX_HOSTS = 40;
const MAX_CALLERS = 8;
const MAX_PER_KIND = 5;
/** Components of each integration type read for a summary. */
const MAX_INTEGRATIONS = 5_000;
/** Shown for a named credential whose URL is set at run time (a merge field) or not kept. */
const NO_HOST = "(host not in the metadata)";

const list = (items: string[], max: number) => (items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", "));

/** What one host is reached through, and from where; components are kept as they are and rendered only if shown. */
interface HostUse {
  credentials: { c: IndexedComponent; auth: string[] }[];
  sites: IndexedComponent[];
  messages: IndexedComponent[];
  apex: boolean;
  from: { c: IndexedComponent; through: boolean }[];
}

/**
 * Where the org connects, for metadata_summary: each host, what it is reached through (a named
 * credential, a remote site setting, an outbound message, an endpoint in Apex) and from which
 * classes and flows; the connected apps that sign in from outside; the event channels. The
 * busiest hosts come first. Hosts are masked like attrs, since one can name a client; only what
 * is shown is masked.
 */
export async function integrationLines(index: MetadataIndex, snapshot: number, pieces: Pieces): Promise<string[]> {
  const hosts = new Map<string, HostUse>();
  const at = (host: string) => {
    let h = hosts.get(host);
    if (!h) hosts.set(host, (h = { credentials: [], sites: [], messages: [], apex: false, from: [] }));
    return h;
  };
  const hostOf = (c: IndexedComponent) => (typeof c.attrs.host === "string" ? c.attrs.host : undefined);
  let capped = false;
  const read = (types: ComponentType[], options: { attr?: string; missing?: boolean } = {}) => {
    const found = index.ofTypes(snapshot, types, { ...options, limit: MAX_INTEGRATIONS });
    if (found.length >= MAX_INTEGRATIONS) capped = true;
    return found;
  };

  // Named credentials, those only called (callout:Name) included.
  for (const nc of read(["NamedCredential"], { missing: true })) {
    const h = at(hostOf(nc) ?? NO_HOST);
    const auth = nc.missing ? [] : index.related(nc.id, { kinds: ["references"] }).filter((r) => r.direction === "out").map((r) => r.component.name);
    h.credentials.push({ c: nc, auth });
    // Who calls through it: Apex (callout:Name), external services, and the flows and classes that call those.
    for (const r of index.related(nc.id, { depth: 2, kinds: ["calls", "references"] })) {
      if (r.direction === "in" && !["NamedCredential", "ExternalCredential"].includes(r.component.type)) h.from.push({ c: r.component, through: r.depth > 1 });
    }
  }
  for (const rs of read(["RemoteSiteSetting"])) {
    const host = hostOf(rs);
    if (host) at(host).sites.push(rs);
  }
  for (const om of read(["WorkflowOutboundMessage"])) at(hostOf(om) ?? NO_HOST).messages.push(om);
  for (const apex of read(["ApexClass", "ApexTrigger"], { attr: "calloutHosts" })) {
    for (const host of (apex.attrs.calloutHosts as unknown[]).filter((h): h is string => typeof h === "string")) {
      const h = at(host);
      h.apex = true;
      h.from.push({ c: apex, through: false });
    }
  }

  const lines: string[] = [];
  if (hosts.size) {
    // The busiest first: what connects through it, then who calls it; then by name.
    const weight = (h: HostUse) => h.credentials.length + h.sites.length + h.messages.length + new Set(h.from.map((f) => f.c.id)).size;
    const sorted = [...hosts].sort(([a, x], [b, y]) => (a === NO_HOST ? 1 : b === NO_HOST ? -1 : weight(y) - weight(x) || (a < b ? -1 : a > b ? 1 : 0)));
    const named = async (c: IndexedComponent) => (await line(pieces, c)).slice(2);
    const rows = await Promise.all(
      sorted.slice(0, MAX_HOSTS).map(async ([host, h]) => {
        const name = host === NO_HOST ? host : await pieces.mask(host);
        const through: string[] = [];
        const kind = (one: string, many: string, items: string[]) => {
          if (items.length) through.push(`${items.length === 1 ? one : `${items.length} ${many}`} ${list(items, MAX_PER_KIND)}`);
        };
        kind("named credential", "named credentials", h.credentials.map(({ c, auth }) => `${c.name}${c.missing ? " (not in the source)" : ""}${auth.length ? ` (authenticates with ${auth.join(", ")})` : ""}`));
        kind("remote site setting", "remote site settings", h.sites.map((s) => `${s.name}${s.attrs.active === false ? " (inactive)" : ""}`));
        kind(
          "outbound message",
          "outbound messages",
          h.messages.map((m) => `${m.name} (sends ${Array.isArray(m.attrs.fields) ? m.attrs.fields.length : 0} field(s) of ${m.parent ?? "its object"})`),
        );
        if (h.apex) through.push("an endpoint written in Apex");
        const seen = new Set<number>();
        const from = h.from.filter((f) => !seen.has(f.c.id) && (seen.add(f.c.id), true));
        const callers = await Promise.all(from.slice(0, MAX_CALLERS).map(async (f) => `${await named(f.c)}${f.through ? " (through one of these)" : ""}`));
        // Apex that calls a URL written in the code needs an active remote site setting for its
        // host: a named credential allows only callout:Name endpoints.
        const allowed = h.sites.some((s) => s.attrs.active !== false);
        const warning =
          h.apex && host !== NO_HOST && !allowed
            ? ` [no active remote site setting in the source allows this host for the endpoint written in Apex${h.credentials.length ? "; a named credential exists for it, but that Apex does not call through it" : ""}]`
            : "";
        return `- ${name}: through ${through.join("; ")}${callers.length ? `; from ${callers.join(", ")}${from.length > callers.length ? ` and ${from.length - callers.length} more` : ""}` : ""}${warning}`;
      }),
    );
    lines.push(
      `Integrations (where the org connects; only hosts are kept of URLs; the busiest first):\n${rows.join("\n")}${hosts.size > MAX_HOSTS ? `\n- and ${hosts.size - MAX_HOSTS} more hosts` : ""}` +
        (capped ? `\n(Only the first ${MAX_INTEGRATIONS.toLocaleString("en")} components of each kind were read: search by host with metadata_search for the rest.)` : ""),
    );
  }
  const apps = index.ofTypes(snapshot, ["ConnectedApp"], { limit: MAX_HOSTS + 1 });
  if (apps.length) {
    const rows = await Promise.all(
      apps.slice(0, MAX_HOSTS).map(async (a) => {
        const scopes = Array.isArray(a.attrs.scopes) && a.attrs.scopes.length ? `scopes ${a.attrs.scopes.join(", ")}` : a.attrs.saml ? "SAML" : a.attrs.canvas ? "canvas" : "no OAuth scopes";
        const callbacks = Array.isArray(a.attrs.callbackHosts) ? (await Promise.all(a.attrs.callbackHosts.slice(0, MAX_PER_KIND).map((h) => pieces.mask(String(h))))).join(", ") : "";
        return `- ${(await line(pieces, a)).slice(2)}: ${scopes}${callbacks ? `; returns to ${callbacks}` : ""}`;
      }),
    );
    lines.push(`Connected apps (systems that sign in to the org):\n${rows.join("\n")}${apps.length > MAX_HOSTS ? "\n- and more: search with types [\"ConnectedApp\"]" : ""}`);
  }
  const members = index.ofTypes(snapshot, ["PlatformEventChannelMember"], { limit: MAX_INTEGRATIONS });
  if (members.length) {
    const byChannel = new Map<string, string[]>();
    for (const m of members) {
      const channel = typeof m.attrs.channel === "string" ? m.attrs.channel : "(no channel)";
      byChannel.set(channel, [...(byChannel.get(channel) ?? []), typeof m.attrs.entity === "string" ? m.attrs.entity : m.name]);
    }
    const rows = [...byChannel]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, MAX_HOSTS)
      .map(([channel, entities]) => `- ${channel === "ChangeEvents" ? "ChangeEvents (change data capture)" : channel}: ${list(entities.sort(), 20)}`);
    lines.push(`Event channels (what subscribers outside the org receive):\n${rows.join("\n")}${byChannel.size > MAX_HOSTS ? `\n- and ${byChannel.size - MAX_HOSTS} more channels` : ""}`);
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
  may_read: ["may read (a query built in strings)", "may be read by (a query built in strings)"],
};

/** A may_read from a custom metadata type: its records name the field or object. */
const NAMED_IN_RECORDS: [string, string] = ["its records name", "is named in the records of"];
const MAY_READ: [string, string] = ["may read", "may be read by"];

async function relatedLine(pieces: Pieces, r: Related, self?: string): Promise<string> {
  // The source of the link: the component shown for a link out, the other one for a link in.
  // Two links away, the source of the last link is the one between: its kind is said plainly.
  const source = r.direction === "out" ? (r.depth > 1 ? undefined : self) : r.component.type;
  const verb = (k: string) => (k !== "may_read" ? VERB[k] : source === "CustomObject" ? NAMED_IN_RECORDS : r.depth > 1 ? MAY_READ : VERB[k]);
  const verbs = r.kinds.map((k) => verb(k)?.[r.direction === "out" ? 0 : 1] ?? k).join(", ");
  const via = r.depth > 1 ? ` (${r.depth} links away)` : "";
  return `${verbs}${via}: ${(await line(pieces, r.component)).slice(2)}`;
}
