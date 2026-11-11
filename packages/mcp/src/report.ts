// The success measure (phase 5, AR4): the share of published stories accepted without major
// edits, against the 90% target, per context, model label and workflow, plus the average
// rating of each design section. It is read from the feedback table and the artifacts' own
// metadata, where everything is masked, so the report holds no real value and needs no vault
// key. Nothing leaves the machine.

import type { ContextRepository, FeedbackEntry, FeedbackRepository } from "@sf-agent-po/core";
import type { ArtifactMeta } from "./artifacts.js";
import type { Backlog } from "./backlog.js";

/** The success measure's target: stories accepted without major edits. */
export const TARGET_ACCEPTED = 0.9;

/** Whose word counts for a story: people before the Jira diff, and among people the PO first. */
const PRECEDENCE = ["po", "sa", "dev", ""] as const;

/** Outcomes that count as accepted without a major edit: a person's verdict, or the Jira diff's. */
const ACCEPTED = new Set(["accepted", "minor", "unchanged"]);

/** A one-line label: a model label is free text, and one line must not pass for two. */
const flat = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();

const key = (...parts: (string | number)[]) => JSON.stringify(parts);

/** One published story at one version, and what counts for it. */
export interface StoryOutcome {
  context: string;
  artifact: string;
  item: string;
  artifactVersion: number;
  /** A verdict (accepted, minor, major, rejected) or the Jira diff's guess (unchanged, minor, major, deleted). */
  value: string;
  /** Who decided: a role, or "jira" for the diff's guess. */
  by: "po" | "sa" | "dev" | "jira";
  accepted: boolean;
  model?: string;
  workflow?: string;
}

/**
 * What counts for each story at each version it has feedback on: the verdict of the first
 * role that gave one (PO, then SA, then the dev team), else the Jira diff's guess. The model
 * label is the Jira diff's, else the verdict's: the label when the feedback was recorded.
 */
export function storyOutcomes(entries: readonly FeedbackEntry[]): StoryOutcome[] {
  const byStory = new Map<string, FeedbackEntry[]>();
  for (const e of entries) {
    if (e.kind !== "verdict" && e.kind !== "jira_diff") continue;
    const k = key(e.context, e.artifact, e.item, e.artifactVersion);
    byStory.set(k, [...(byStory.get(k) ?? []), e]);
  }
  const out: StoryOutcome[] = [];
  for (const rows of byStory.values()) {
    const pick = PRECEDENCE.map((role) => rows.find((r) => r.role === role && (role === "" ? r.kind === "jira_diff" : r.kind === "verdict"))).find(Boolean)!;
    const model = rows.find((r) => r.kind === "jira_diff")?.model ?? pick.model ?? rows.find((r) => r.model)?.model;
    const workflow = pick.workflow ?? rows.find((r) => r.workflow)?.workflow;
    out.push({
      context: pick.context,
      artifact: pick.artifact,
      item: pick.item,
      artifactVersion: pick.artifactVersion,
      value: pick.value,
      by: pick.role === "" ? "jira" : pick.role,
      accepted: ACCEPTED.has(pick.value),
      ...(model && { model }),
      ...(workflow && { workflow }),
    });
  }
  return out.sort((a, b) => cmp(a.context, b.context) || cmp(a.artifact, b.artifact) || a.artifactVersion - b.artifactVersion || cmp(a.item, b.item));
}

/**
 * What the report counts: each story still in a published backlog, once, at the version it was
 * last sent to Jira from (the one the Jira diff and the review page work on), with the model
 * label the backlog was published under; and each design at its current version.
 */
export interface ReportScope {
  stories: Map<string, { version: number; model?: string }>;
  designs: Map<string, number>;
}

/** The report's scope, from the artifacts of the given contexts. */
export function reportScope(contexts: ContextRepository, feedback: FeedbackRepository, names: readonly string[]): ReportScope {
  const stories: ReportScope["stories"] = new Map();
  const designs: ReportScope["designs"] = new Map();
  for (const context of names) {
    for (const doc of contexts.documents(context)) {
      const meta = doc.metadata as Partial<ArtifactMeta> & { backlog?: Backlog };
      if (!meta.artifact) continue;
      if (doc.kind === "design") designs.set(key(context, doc.id), meta.version ?? 1);
      const mapping = meta.jira;
      if (doc.kind !== "backlog" || !meta.backlog || !mapping) continue;
      const sent = feedback.sent(context, doc.id);
      for (const epic of meta.backlog.epics) {
        if (epic.priority === "wont") continue;
        for (const st of epic.stories) {
          if (st.priority === "wont" || !mapping.items[st.id]) continue;
          const model = typeof mapping.model === "string" && mapping.model ? mapping.model : undefined;
          stories.set(key(context, doc.id, st.id), { version: sent.get(st.id)?.artifactVersion ?? mapping.publishedVersion ?? meta.version ?? 1, ...(model && { model }) });
        }
      }
    }
  }
  return { stories, designs };
}

export interface StoryGroup {
  context: string;
  model?: string;
  workflow?: string;
  stories: number;
  accepted: number;
  /** Stories a person gave a verdict on; the rest count by the Jira diff's guess. */
  byPeople: number;
}

export interface RatingGroup {
  context: string;
  /** The design's type: "high-level", "detailed", or "design" when it has none. */
  design: string;
  /** The section's stable id, from its heading. */
  section: string;
  model?: string;
  ratings: number;
  average: number;
}

export interface FeedbackReport {
  /** Stories with feedback, and how many of them count as accepted. */
  stories: number;
  accepted: number;
  byPeople: number;
  /** Published stories in scope, with feedback or not (only with a scope). */
  published?: number;
  groups: StoryGroup[];
  ratings: RatingGroup[];
}

const cmp = (a = "", b = "") => (a < b ? -1 : a > b ? 1 : 0);

/** Keeps, for each key, the rows of its highest version. */
function latest<T extends { artifactVersion: number }>(rows: readonly T[], keyOf: (r: T) => string): T[] {
  const top = new Map<string, number>();
  for (const r of rows) top.set(keyOf(r), Math.max(top.get(keyOf(r)) ?? -1, r.artifactVersion));
  return rows.filter((r) => top.get(keyOf(r)) === r.artifactVersion);
}

/**
 * The success measure and the design ratings. With a scope, each story still published counts
 * once, at the version last sent, and each design at its current version; without one (no
 * artifacts at hand), the latest version of each with feedback counts.
 */
export function feedbackReport(entries: readonly FeedbackEntry[], scope?: ReportScope): FeedbackReport {
  const all = storyOutcomes(entries);
  const outcomes = scope
    ? all.flatMap((o) => {
        const s = scope.stories.get(key(o.context, o.artifact, o.item));
        if (!s || s.version !== o.artifactVersion) return [];
        return [s.model ? { ...o, model: s.model } : o];
      })
    : latest(all, (o) => key(o.context, o.artifact, o.item));
  const groups = new Map<string, StoryGroup>();
  for (const o of outcomes) {
    const model = o.model ? flat(o.model) : undefined;
    const k = key(o.context, model ?? "", o.workflow ?? "");
    const g = groups.get(k) ?? { context: o.context, ...(model && { model }), ...(o.workflow && { workflow: o.workflow }), stories: 0, accepted: 0, byPeople: 0 };
    g.stories++;
    if (o.accepted) g.accepted++;
    if (o.by !== "jira") g.byPeople++;
    groups.set(k, g);
  }
  const rated = entries.filter((e) => e.kind === "rating");
  const current = scope
    ? rated.filter((e) => scope.designs.get(key(e.context, e.artifact)) === e.artifactVersion)
    : latest(rated, (e) => key(e.context, e.artifact, e.item, e.role));
  const ratings = new Map<string, RatingGroup & { sum: number }>();
  for (const e of current) {
    const design = typeof e.details.design === "string" ? e.details.design : "design";
    const model = e.model ? flat(e.model) : undefined;
    const k = key(e.context, design, e.item, model ?? "");
    const g = ratings.get(k) ?? { context: e.context, design, section: e.item, ...(model && { model }), ratings: 0, average: 0, sum: 0 };
    g.ratings++;
    g.sum += Number(e.value);
    g.average = g.sum / g.ratings;
    ratings.set(k, g);
  }
  return {
    stories: outcomes.length,
    accepted: outcomes.filter((o) => o.accepted).length,
    byPeople: outcomes.filter((o) => o.by !== "jira").length,
    ...(scope && { published: scope.stories.size }),
    groups: [...groups.values()].sort((a, b) => cmp(a.context, b.context) || cmp(a.model, b.model) || cmp(a.workflow, b.workflow)),
    ratings: [...ratings.values()]
      .map(({ sum: _sum, ...g }) => g)
      .sort((a, b) => cmp(a.context, b.context) || cmp(a.design, b.design) || cmp(a.model, b.model) || cmp(a.section, b.section)),
  };
}

/** A share, rounded down to a tenth of a percent, so that 89.7% never reads as 90%. */
export function percent(n: number, of: number): string {
  if (!of) return "n/a";
  return `${Math.floor((n * 1000) / of) / 10}%`;
}

/** Whether `accepted` of `stories` reaches the target, without rounding. */
export const meets = (accepted: number, stories: number, target = TARGET_ACCEPTED) => stories > 0 && accepted >= Math.ceil(stories * target - 1e-9);

const label = (m?: string) => (m ? `"${m}"` : "no model label");

/** The report as text, for the tool and the command. */
export function formatReport(r: FeedbackReport, target = TARGET_ACCEPTED): string {
  if (!r.stories && !r.ratings.length) {
    const none = "No feedback recorded yet: run feedback_jira_diff once the team has worked on a published backlog, and feedback_review for people's verdicts and design ratings.";
    return r.published ? `${none} ${r.published} published stor${r.published === 1 ? "y has" : "ies have"} none.` : none;
  }
  const lines: string[] = [];
  if (r.stories) {
    lines.push(
      `Stories accepted without major edits: ${r.accepted} of ${r.stories} stories with feedback (${percent(r.accepted, r.stories)}), against the ${Math.round(target * 100)}% target: ${meets(r.accepted, r.stories, target) ? "met" : "not met"}.`,
      `${r.byPeople} decided by people (a guess left as it is on the review page counts as theirs), ${r.stories - r.byPeople} by the Jira diff's guess only.`,
    );
    if (r.published !== undefined && r.published > r.stories) lines.push(`${r.published - r.stories} more published stor${r.published - r.stories === 1 ? "y has" : "ies have"} no feedback yet.`);
    lines.push(
      "",
      "By context, model label (when the backlog was published) and workflow:",
      ...r.groups.map((g) => `- ${g.context}, ${label(g.model)}, ${g.workflow ?? "no workflow"}: ${g.accepted} of ${g.stories} (${percent(g.accepted, g.stories)}), ${g.byPeople} by people`),
    );
  } else lines.push(`No published story has feedback yet${r.published ? ` (${r.published} published)` : ""}.`);
  if (r.ratings.length) {
    lines.push("", "Design ratings of the current versions, average of 5, by section:");
    lines.push(...r.ratings.map((g) => `- ${g.context}, ${g.design}, ${g.section}${g.model ? `, ${label(g.model)}` : ""}: ${g.average.toFixed(1)} (${g.ratings} rating${g.ratings === 1 ? "" : "s"})`));
  }
  return lines.join("\n");
}

/** A CSV cell: quoted, and kept from being read as a formula by a spreadsheet. */
function cell(v: string | number | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "number") return String(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export const CSV_HEADER = ["measure", "context", "model", "workflow", "design", "section", "count", "accepted", "by_people", "value"] as const;

/**
 * The report as CSV: an `accepted_share_total` row, one `accepted_share` row per context,
 * model label and workflow (value: the share accepted, 0 to 1), and one `rating` row per design
 * section (value: the average).
 */
export function reportCsv(r: FeedbackReport): string {
  const share = (a: number, n: number) => Math.round((a / n) * 1000) / 1000;
  const rows: (string | number | undefined)[][] = [
    ...(r.stories ? [["accepted_share_total", undefined, undefined, undefined, undefined, undefined, r.stories, r.accepted, r.byPeople, share(r.accepted, r.stories)]] : []),
    ...r.groups.map((g) => ["accepted_share", g.context, g.model, g.workflow, undefined, undefined, g.stories, g.accepted, g.byPeople, share(g.accepted, g.stories)]),
    ...r.ratings.map((g) => ["rating", g.context, g.model, undefined, g.design, g.section, g.ratings, undefined, undefined, Math.round(g.average * 100) / 100]),
  ];
  return [CSV_HEADER.join(","), ...rows.map((row) => row.map(cell).join(","))].join("\r\n") + "\r\n";
}
