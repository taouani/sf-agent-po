// The traceability matrix (RM1): one row per confirmed requirement, with the inputs it comes
// from, the design parts that address it, the stories that deliver it and their Jira keys, and
// a status. It is computed from the requirement ids the designs and the backlog carry, so it
// never drifts from them. Everything in it is masked; the real values go in only on publishing.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextRepository, Requirement, RequirementRepository, SourceDocument } from "@sf-agent-po/core";
import { z } from "zod";
import type { ArtifactMeta } from "./artifacts.js";
import { allStories, type Backlog } from "./backlog.js";
import { ddTracedItems, storyItems, type DetailedDesign } from "./design/detailed-schema.js";
import { table } from "./design/render.js";
import type { CallContext } from "./review.js";
import { tracedItems, type HighLevelDesign } from "./design/schema.js";

export type TraceStatus = "covered" | "partly covered" | "not covered" | "won't have";

export interface TraceRow {
  requirement: Requirement;
  /** The input documents it comes from: id and masked title. */
  sources: { id: string; title?: string }[];
  /** The design parts that address it, such as "HLD Solution: C1 Renewal console". */
  design: string[];
  /** The stories that deliver it, with their Jira keys once published. */
  stories: { id: string; summary?: string; jiraKey?: string }[];
  /** Why a design or the backlog leaves it out, when it says so. */
  gaps: string[];
  status: TraceStatus;
}

export interface TraceMatrix {
  /** The artifacts it was computed from. */
  from: { highLevel?: SourceDocument; detailed?: SourceDocument; backlog?: SourceDocument };
  rows: TraceRow[];
}

type Gap = { requirementId: string; reason: string };

const isArtifact = (d: SourceDocument, kind: string, type?: string) => {
  const meta = d.metadata as Partial<ArtifactMeta> | undefined;
  return d.kind === kind && meta?.artifact === true && (type === undefined || meta.artifactType === type);
};
const savedAt = (d: SourceDocument) => ((d.metadata as Partial<ArtifactMeta> | undefined)?.savedAt as string | undefined) ?? d.updatedAt;
/** The newest artifact of a kind (and type) that holds its structured form under `key`. */
const newest = (docs: readonly SourceDocument[], kind: string, key: string, type?: string) =>
  docs.filter((d) => isArtifact(d, kind, type) && (d.metadata as Record<string, unknown>)[key]).sort((a, b) => savedAt(b).localeCompare(savedAt(a)))[0];

/**
 * The matrix of a context: its confirmed requirements against the newest high-level design,
 * detailed design and backlog saved by the workflows (or the ones `pick` names).
 */
export function buildTrace(
  contexts: ContextRepository,
  requirements: RequirementRepository,
  context: string,
  pick: { highLevel?: string; detailed?: string; backlog?: string } = {},
): TraceMatrix {
  // Masked documents only: an input imported from 0.x and not masked yet has its title in clear.
  const docs = contexts.documents(context).filter((d) => d.masked);
  const byId = (id: string | undefined, kind: string, key: string, type?: string) => {
    if (id === undefined) return newest(docs, kind, key, type);
    const doc = docs.find((d) => d.id === id);
    if (!doc || !isArtifact(doc, kind, type)) throw new Error(`${id} is not a ${type ? `${type} design` : kind} in context "${context}".`);
    if (!(doc.metadata as Record<string, unknown>)[key]) throw new Error(`${id} was not written by a workflow, so it carries no requirement ids to trace.`);
    return doc;
  };
  const detailed = byId(pick.detailed, "design", "design", "detailed");
  // A detailed design names the backlog and the high-level design it builds on: they are its defaults.
  const scope = (detailed?.metadata as { design?: DetailedDesign } | undefined)?.design?.scope;
  const linked = (id: string | undefined, kind: string, key: string, type?: string) => {
    const doc = id ? docs.find((d) => d.id === id) : undefined;
    return doc && isArtifact(doc, kind, type) && (doc.metadata as Record<string, unknown>)[key] ? doc.id : undefined;
  };
  const from = {
    highLevel: byId(pick.highLevel ?? linked(scope?.highLevelDesignId, "design", "design", "high-level"), "design", "design", "high-level"),
    detailed,
    backlog: byId(pick.backlog ?? linked(scope?.backlogId, "backlog", "backlog"), "backlog", "backlog"),
  };
  const hld = from.highLevel && ((from.highLevel.metadata as { design: HighLevelDesign & { gaps?: Gap[] } }).design);
  const dd = from.detailed && ((from.detailed.metadata as { design: DetailedDesign & { gaps?: { story: string; reason: string }[] } }).design);
  const backlogMeta = from.backlog?.metadata as (ArtifactMeta & { backlog: Backlog }) | undefined;
  const backlog = backlogMeta?.backlog;

  const titles = new Map(docs.map((d) => [d.id, d.title]));
  const hldItems = hld ? tracedItems(hld) : [];
  const ddItems = dd ? ddTracedItems(dd) : [];
  const ddStories = dd?.scope?.stories ?? [];
  const ddBuilt = dd ? storyItems(dd) : [];
  const everyStory = backlog ? allStories(backlog) : [];
  const published = everyStory.filter(({ epic, story }) => story.priority !== "wont" && epic.priority !== "wont");
  const jiraKey = (id: string, own?: string) => backlogMeta?.jira?.items[id]?.key ?? own;
  // The backlog's stories by id and by Jira key: a detailed design may cite either.
  const inBacklog = new Set(everyStory.flatMap(({ story }) => [story.id, jiraKey(story.id, story.jiraKey)].filter((x): x is string => Boolean(x))));
  const hasDesign = Boolean(hld || dd);
  const hasStories = Boolean(backlog || ddStories.length);

  const rows = requirements
    .list(context)
    .filter((r) => r.status === "confirmed")
    .map((r): TraceRow => {
      const design = [
        ...hldItems.filter((t) => t.requirementIds.includes(r.id)).map((t) => `HLD ${t.section}: ${t.item}`),
        ...ddItems.filter((t) => t.requirementIds.includes(r.id)).map((t) => `DD ${t.section}: ${t.item}`),
      ];
      // The detailed design builds the stories in its scope that cite the requirement.
      const ddRefs = new Set(ddStories.filter((s) => s.requirementIds.includes(r.id)).map((s) => s.ref));
      for (const b of ddBuilt) {
        const refs = b.stories.filter((s) => ddRefs.has(s));
        if (refs.length) design.push(`DD ${b.section}: ${b.item} (${refs.join(", ")})`);
      }
      const stories = new Map<string, TraceRow["stories"][number]>();
      for (const { story } of published.filter(({ story }) => story.requirementIds?.includes(r.id)))
        stories.set(story.id, { id: story.id, summary: story.summary, ...(jiraKey(story.id, story.jiraKey) ? { jiraKey: jiraKey(story.id, story.jiraKey) } : {}) });
      // A story of the detailed design the backlog does not know (the backlog decides for its own: won't have, or no longer citing it).
      for (const s of ddStories.filter((s) => s.requirementIds.includes(r.id) && !inBacklog.has(s.ref))) stories.set(s.ref, { id: s.ref, summary: s.summary });
      const gaps = [
        ...(hld?.gaps ?? []).filter((g) => g.requirementId === r.id).map((g) => `HLD: ${g.reason}`),
        ...(backlog?.gaps ?? []).filter((g) => g.requirementId === r.id).map((g) => `Backlog: ${g.reason}`),
      ];
      const traced = [hasDesign && design.length > 0, hasStories && stories.size > 0].filter(Boolean).length;
      const expected = [hasDesign, hasStories].filter(Boolean).length;
      const status: TraceStatus = r.priority === "wont" ? "won't have" : traced && traced === expected ? "covered" : traced ? "partly covered" : "not covered";
      return {
        requirement: r,
        sources: r.sourceIds.map((id) => ({ id, ...(titles.has(id) ? { title: titles.get(id) } : {}) })),
        design: [...new Set(design)],
        stories: [...stories.values()],
        gaps,
        status,
      };
    });
  return { from, rows };
}

const counts = (m: TraceMatrix) => {
  const by = (s: TraceStatus) => m.rows.filter((r) => r.status === s).length;
  const must = m.rows.filter((r) => r.requirement.priority === "must" && r.status !== "covered").map((r) => r.requirement.id);
  return { covered: by("covered"), partly: by("partly covered"), not: by("not covered"), wont: by("won't have"), must };
};

/** One line on the matrix: how many requirements are covered, and the Must ones that are not. */
export function traceSummary(m: TraceMatrix): string {
  const c = counts(m);
  if (!m.rows.length) return "No requirement is confirmed in this context, so there is nothing to trace.";
  return (
    `${m.rows.length} confirmed requirement(s): ${c.covered} covered, ${c.partly} partly covered, ${c.not} not covered${c.wont ? `, ${c.wont} won't have` : ""}.` +
    (c.must.length ? ` Must requirements not fully covered: ${c.must.join(", ")}.` : "")
  );
}

/** The matrix as Markdown: what trace_show returns, and the Confluence page. */
export function renderTrace(m: TraceMatrix, title: string): string {
  const from = [
    m.from.highLevel && `high-level design "${m.from.highLevel.title}" (${m.from.highLevel.id})`,
    m.from.detailed && `detailed design "${m.from.detailed.title}" (${m.from.detailed.id})`,
    m.from.backlog && `backlog "${m.from.backlog.title}" (${m.from.backlog.id})`,
  ].filter(Boolean);
  const head = [
    `# ${title.replace(/\s*\r?\n\s*/g, " ").trim()}`,
    from.length ? `Computed from the ${from.join(", the ")}.` : "No design or backlog written by a workflow is saved yet: every requirement is not covered.",
    traceSummary(m),
  ];
  if (!m.rows.length) return `${head.join("\n\n")}\n`;
  const rows = m.rows.map((r) => [
    r.requirement.id,
    r.requirement.priority,
    r.requirement.statement,
    r.sources.map((s) => (s.title ? `${s.title} (${s.id})` : s.id)).join("; "),
    r.design.join("; "),
    r.stories.map((s) => `${s.id}${s.jiraKey && s.jiraKey !== s.id ? ` (${s.jiraKey})` : ""}${s.summary ? ` ${s.summary}` : ""}`).join("; "),
    `${r.status}${r.gaps.length ? ` (${r.gaps.join("; ")})` : ""}`,
  ]);
  return `${head.join("\n\n")}\n\n${table(["Requirement", "Priority", "Statement", "Sources", "Design", "Stories", "Status"], rows)}\n`;
}

type Text = { content: { type: "text"; text: string }[] };

export interface TraceToolsKit {
  contexts: ContextRepository;
  requirements: RequirementRepository;
  guard: <A extends { context?: string }>(fn: (args: A, call: CallContext) => Promise<Text>) => (args: A, call: CallContext) => Promise<Text & { isError?: boolean }>;
  contextName: z.ZodType<string>;
}

const docId = z.string().regex(/^doc-[0-9a-f]{10}$/, "use a document id such as doc-1a2b3c4d5e").optional();

export function registerTraceTools(server: McpServer, kit: TraceToolsKit): void {
  server.registerTool(
    "trace_show",
    {
      title: "Show the traceability matrix",
      description:
        "Shows the traceability matrix of a context: each confirmed requirement with the inputs it comes from, the design parts that address it, " +
        "the stories that deliver it and their Jira keys, and whether it is covered. It is computed from the newest designs and backlog the workflows saved, or the ones given.",
      inputSchema: {
        context: kit.contextName,
        highLevelDesignId: docId.describe("A high-level design to trace instead of the newest one."),
        detailedDesignId: docId.describe("A detailed design to trace instead of the newest one."),
        backlogId: docId.describe("A backlog to trace instead of the newest one."),
      },
      annotations: { readOnlyHint: true },
    },
    kit.guard(async ({ context, highLevelDesignId, detailedDesignId, backlogId }: { context: string; highLevelDesignId?: string; detailedDesignId?: string; backlogId?: string }) => {
      const matrix = buildTrace(kit.contexts, kit.requirements, context, { highLevel: highLevelDesignId, detailed: detailedDesignId, backlog: backlogId });
      return { content: [{ type: "text", text: renderTrace(matrix, `Traceability matrix: ${context}`) }] };
    }),
  );
}
