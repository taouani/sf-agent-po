// The success measure (phase 5, AR4): the share of published stories accepted without major
// edits, against the 90% target, per context, model label and workflow, plus the average
// rating of each design section. It is read from the feedback table only, where everything is
// masked, so the report holds no real value and needs no vault key. Nothing leaves the machine.

import type { FeedbackEntry } from "@sf-agent-po/core";

/** The success measure's target: stories accepted without major edits. */
export const TARGET_ACCEPTED = 0.9;

/** Whose word counts for a story: people before the Jira diff, and among people the PO first. */
const PRECEDENCE = ["po", "sa", "dev", ""] as const;

/** Outcomes that count as accepted without a major edit: a person's verdict, or the Jira diff's. */
const ACCEPTED = new Set(["accepted", "minor", "unchanged"]);

/** One published story (a story at the backlog version it was published from) and what counts for it. */
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
 * What counts for each published story: the verdict of the first role that gave one (PO, then
 * SA, then the dev team), else the Jira diff's guess. A story published again counts once per
 * version, since each version was sent to Jira and judged on its own.
 */
export function storyOutcomes(entries: readonly FeedbackEntry[]): StoryOutcome[] {
  const byStory = new Map<string, FeedbackEntry[]>();
  for (const e of entries) {
    if (e.kind !== "verdict" && e.kind !== "jira_diff") continue;
    const k = JSON.stringify([e.context, e.artifact, e.item, e.artifactVersion]);
    byStory.set(k, [...(byStory.get(k) ?? []), e]);
  }
  const out: StoryOutcome[] = [];
  for (const rows of byStory.values()) {
    const pick = PRECEDENCE.map((role) => rows.find((r) => r.role === role && (role === "" ? r.kind === "jira_diff" : r.kind === "verdict"))).find(Boolean)!;
    // The model and workflow are the story's, whichever row has them.
    const model = pick.model ?? rows.find((r) => r.model)?.model;
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
  stories: number;
  accepted: number;
  byPeople: number;
  groups: StoryGroup[];
  ratings: RatingGroup[];
}

const cmp = (a = "", b = "") => (a < b ? -1 : a > b ? 1 : 0);

/** The success measure and the design ratings, from feedback entries of one or more contexts. */
export function feedbackReport(entries: readonly FeedbackEntry[]): FeedbackReport {
  const outcomes = storyOutcomes(entries);
  const groups = new Map<string, StoryGroup>();
  for (const o of outcomes) {
    const k = JSON.stringify([o.context, o.model ?? null, o.workflow ?? null]);
    const g = groups.get(k) ?? { context: o.context, ...(o.model && { model: o.model }), ...(o.workflow && { workflow: o.workflow }), stories: 0, accepted: 0, byPeople: 0 };
    g.stories++;
    if (o.accepted) g.accepted++;
    if (o.by !== "jira") g.byPeople++;
    groups.set(k, g);
  }
  const ratings = new Map<string, RatingGroup & { sum: number }>();
  for (const e of entries) {
    if (e.kind !== "rating") continue;
    const design = typeof e.details.design === "string" ? e.details.design : "design";
    const k = JSON.stringify([e.context, design, e.item, e.model ?? null]);
    const g = ratings.get(k) ?? { context: e.context, design, section: e.item, ...(e.model && { model: e.model }), ratings: 0, average: 0, sum: 0 };
    g.ratings++;
    g.sum += Number(e.value);
    g.average = g.sum / g.ratings;
    ratings.set(k, g);
  }
  return {
    stories: outcomes.length,
    accepted: outcomes.filter((o) => o.accepted).length,
    byPeople: outcomes.filter((o) => o.by !== "jira").length,
    groups: [...groups.values()].sort((a, b) => cmp(a.context, b.context) || cmp(a.model, b.model) || cmp(a.workflow, b.workflow)),
    ratings: [...ratings.values()]
      .map(({ sum: _sum, ...g }) => g)
      .sort((a, b) => cmp(a.context, b.context) || cmp(a.design, b.design) || cmp(a.model, b.model) || cmp(a.section, b.section)),
  };
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "n/a");
const label = (m?: string) => (m ? `"${m}"` : "no model label");

/** The report as text, for the tool and the command. */
export function formatReport(r: FeedbackReport, target = TARGET_ACCEPTED): string {
  if (!r.stories && !r.ratings.length) return "No feedback recorded yet: run feedback_jira_diff once the team has worked on a published backlog, and feedback_review for people's verdicts and design ratings.";
  const lines: string[] = [];
  if (r.stories) {
    const met = r.accepted / r.stories >= target;
    lines.push(
      `Stories accepted without major edits: ${r.accepted} of ${r.stories} (${pct(r.accepted, r.stories)}), against the ${Math.round(target * 100)}% target: ${met ? "met" : "not met"}.`,
      `${r.byPeople} decided by people, ${r.stories - r.byPeople} by the Jira diff's guess only.`,
      "",
      "By context, model label and workflow:",
      ...r.groups.map((g) => `- ${g.context}, ${label(g.model)}, ${g.workflow ?? "no workflow"}: ${g.accepted} of ${g.stories} (${pct(g.accepted, g.stories)}), ${g.byPeople} by people`),
    );
  } else lines.push("No published story has feedback yet.");
  if (r.ratings.length) {
    lines.push("", "Design ratings, average of 5, by section:");
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

export const CSV_HEADER = ["measure", "context", "model", "workflow", "design", "section", "count", "accepted", "value"] as const;

/**
 * The report as CSV: one `accepted_share` row per context, model label and workflow (value:
 * the share accepted, 0 to 1), and one `rating` row per design section (value: the average).
 */
export function reportCsv(r: FeedbackReport): string {
  const rows: (string | number | undefined)[][] = [
    ...r.groups.map((g) => ["accepted_share", g.context, g.model, g.workflow, undefined, undefined, g.stories, g.accepted, Math.round((g.accepted / g.stories) * 1000) / 1000]),
    ...r.ratings.map((g) => ["rating", g.context, g.model, undefined, g.design, g.section, g.ratings, undefined, Math.round(g.average * 100) / 100]),
  ];
  return [CSV_HEADER.join(","), ...rows.map((row) => row.map(cell).join(","))].join("\r\n") + "\r\n";
}
