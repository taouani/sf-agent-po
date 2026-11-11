// Feedback on what the agents produced (phase 5): the Jira diff's guess for each published
// story, people's verdicts on stories and ratings of design sections. The success measure,
// stories accepted without major edits, is read from here.

import { validateContextName } from "./contexts.js";
import type { Database } from "./db.js";

export const FEEDBACK_KINDS = ["jira_diff", "verdict", "rating"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
/** Who decided: the Product Owner, the Solution Architect or the dev team; '' for the server's own guess. */
export const FEEDBACK_ROLES = ["", "po", "sa", "dev"] as const;
export type FeedbackRole = (typeof FEEDBACK_ROLES)[number];

/** What the Jira diff finds for a story. */
export const JIRA_DIFF_VALUES = ["unchanged", "minor", "major", "deleted"] as const;
export type JiraDiffValue = (typeof JIRA_DIFF_VALUES)[number];
/** A person's verdict on a story. */
export const VERDICT_VALUES = ["accepted", "minor", "major", "rejected"] as const;
export type VerdictValue = (typeof VERDICT_VALUES)[number];

export interface FeedbackEntry {
  context: string;
  /** The artifact's document id. */
  artifact: string;
  /** The artifact's version the feedback is on: for a story, the version it was published from. */
  artifactVersion: number;
  /** A story id ("S1") or a design section. */
  item: string;
  kind: FeedbackKind;
  role: FeedbackRole;
  /** jira_diff: JIRA_DIFF_VALUES; verdict: VERDICT_VALUES; rating: "1" to "5". */
  value: string;
  /** Masked. */
  comment?: string;
  /** The context's model label when it was recorded. */
  model?: string;
  /** The guided workflow that wrote the artifact, if any. */
  workflow?: string;
  /** Numbers and keys only (an issue key, the share of words changed), never Jira's text. */
  details: Record<string, unknown>;
  recordedAt: string;
}

export type FeedbackInput = Omit<FeedbackEntry, "recordedAt" | "details" | "role"> & { role?: FeedbackRole; details?: Record<string, unknown> };

interface Row {
  context: string;
  artifact: string;
  artifact_version: number;
  item: string;
  kind: string;
  role: string;
  value: string;
  comment: string | null;
  model: string | null;
  workflow: string | null;
  details: string;
  recorded_at: string;
}

const toEntry = (r: Row): FeedbackEntry => ({
  context: r.context,
  artifact: r.artifact,
  artifactVersion: r.artifact_version,
  item: r.item,
  kind: r.kind as FeedbackKind,
  role: r.role as FeedbackRole,
  value: r.value,
  ...(r.comment !== null && { comment: r.comment }),
  ...(r.model !== null && { model: r.model }),
  ...(r.workflow !== null && { workflow: r.workflow }),
  details: JSON.parse(r.details) as Record<string, unknown>,
  recordedAt: r.recorded_at,
});

/** The values a kind takes. */
function checkValue(kind: FeedbackKind, value: string): void {
  const ok =
    kind === "jira_diff" ? (JIRA_DIFF_VALUES as readonly string[]).includes(value) : kind === "verdict" ? (VERDICT_VALUES as readonly string[]).includes(value) : /^[1-5]$/.test(value);
  if (!ok) throw new Error(`"${value}" is not a ${kind === "rating" ? "rating from 1 to 5" : `${kind} value`}.`);
}

/** A story as jira_publish last sent it, masked: what the Jira diff compares Jira with. */
export interface PublishedStory {
  context: string;
  artifact: string;
  item: string;
  /** The backlog version it was sent from. */
  artifactVersion: number;
  issueKey: string;
  summary: string;
  /** The description as plain text, cut at MAX_PUBLISHED_TEXT. */
  text: string;
  /** Whether `text` was cut. */
  truncated: boolean;
  criteria: number;
  points?: number;
  pointsField?: string;
  sentAt: string;
}

/** How much of a published story's description is kept. */
export const MAX_PUBLISHED_TEXT = 100_000;

interface StoryRow {
  context: string;
  artifact: string;
  item: string;
  artifact_version: number;
  issue_key: string;
  summary: string;
  text: string;
  truncated: number;
  criteria: number;
  points: number | null;
  points_field: string | null;
  sent_at: string;
}

const toStory = (r: StoryRow): PublishedStory => ({
  context: r.context,
  artifact: r.artifact,
  item: r.item,
  artifactVersion: r.artifact_version,
  issueKey: r.issue_key,
  summary: r.summary,
  text: r.text,
  truncated: r.truncated === 1,
  criteria: r.criteria,
  ...(r.points !== null && { points: r.points }),
  ...(r.points_field !== null && { pointsField: r.points_field }),
  sentAt: r.sent_at,
});

export class FeedbackRepository {
  constructor(private readonly database: Database) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Records feedback, in one transaction, replacing what was recorded before for the same
   * artifact version, item, kind and role. The artifact must be a document of the context.
   */
  record(entries: readonly FeedbackInput[]): FeedbackEntry[] {
    if (!entries.length) return [];
    return this.database.write(() => this.put(entries));
  }

  /**
   * Records a Jira diff run of one artifact, in one transaction: its results replace those of
   * the same versions; `stale` (stories it could not compare, at the version they were sent
   * from) lose theirs; and items no longer in `items` (stories taken out of the backlog) lose
   * every Jira diff they had.
   */
  recordJiraDiff(context: string, artifact: string, run: { results: readonly FeedbackInput[]; stale: readonly { item: string; artifactVersion: number }[]; items: readonly string[] }): FeedbackEntry[] {
    for (const r of run.results) if (r.kind !== "jira_diff" || r.context !== context || r.artifact !== artifact) throw new Error("A Jira diff run records Jira diffs of its own artifact only.");
    return this.database.write(() => {
      const drop = this.db.prepare("DELETE FROM feedback WHERE context = ? AND artifact = ? AND kind = 'jira_diff' AND item = ? AND artifact_version = ?");
      for (const s of run.stale) drop.run(context, artifact, s.item, s.artifactVersion);
      const keep = new Set(run.items);
      const items = this.db.prepare("SELECT DISTINCT item FROM feedback WHERE context = ? AND artifact = ? AND kind = 'jira_diff'").all(context, artifact) as { item: string }[];
      const gone = this.db.prepare("DELETE FROM feedback WHERE context = ? AND artifact = ? AND kind = 'jira_diff' AND item = ?");
      for (const { item } of items) if (!keep.has(item)) gone.run(context, artifact, item);
      return this.put(run.results);
    });
  }

  private put(entries: readonly FeedbackInput[]): FeedbackEntry[] {
    for (const e of entries) {
      validateContextName(e.context);
      if (!(FEEDBACK_KINDS as readonly string[]).includes(e.kind)) throw new Error(`Unknown feedback kind ${e.kind}.`);
      const role = e.role ?? "";
      if (!(FEEDBACK_ROLES as readonly string[]).includes(role)) throw new Error(`Unknown role ${role}.`);
      if ((e.kind === "jira_diff") !== (role === "")) throw new Error("The Jira diff is the server's guess, with no role; verdicts and ratings name who gave them.");
      checkValue(e.kind, e.value);
      if (!Number.isInteger(e.artifactVersion) || e.artifactVersion < 0) throw new Error(`Not an artifact version: ${e.artifactVersion}.`);
    }
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO feedback (context, artifact, artifact_version, item, kind, role, value, comment, model, workflow, details, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (context, artifact, artifact_version, item, kind, role) DO UPDATE SET
         value = excluded.value, comment = excluded.comment, model = excluded.model, workflow = excluded.workflow,
         details = excluded.details, recorded_at = excluded.recorded_at`,
    );
    for (const e of entries) {
      insert.run(e.context, e.artifact, e.artifactVersion, e.item, e.kind, e.role ?? "", e.value, e.comment ?? null, e.model ?? null, e.workflow ?? null, JSON.stringify(e.details ?? {}), now);
    }
    return entries.map((e) => ({ ...e, role: e.role ?? "", details: e.details ?? {}, recordedAt: now }));
  }

  /** A context's feedback, by artifact, item, kind and role; only one artifact's or kind's when asked. */
  list(context: string, filter: { artifact?: string; kind?: FeedbackKind } = {}): FeedbackEntry[] {
    const where = ["context = ?"];
    const params: string[] = [context];
    if (filter.artifact) {
      where.push("artifact = ?");
      params.push(filter.artifact);
    }
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    return (this.db.prepare(`SELECT * FROM feedback WHERE ${where.join(" AND ")} ORDER BY artifact, artifact_version, item, kind, role`).all(...params) as unknown as Row[]).map(toEntry);
  }

  /** Keeps stories as they were sent to Jira, replacing what was kept for them before. The artifact must be a document of the context. */
  saveSent(stories: readonly Omit<PublishedStory, "sentAt" | "truncated">[]): void {
    if (!stories.length) return;
    this.database.write(() => {
      const now = new Date().toISOString();
      const insert = this.db.prepare(
        `INSERT INTO published_story (context, artifact, item, artifact_version, issue_key, summary, text, truncated, criteria, points, points_field, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (context, artifact, item) DO UPDATE SET
           artifact_version = excluded.artifact_version, issue_key = excluded.issue_key, summary = excluded.summary, text = excluded.text,
           truncated = excluded.truncated, criteria = excluded.criteria, points = excluded.points, points_field = excluded.points_field, sent_at = excluded.sent_at`,
      );
      for (const s of stories) {
        const truncated = s.text.length > MAX_PUBLISHED_TEXT;
        // Cut on a character, not inside a surrogate pair.
        const text = truncated ? s.text.slice(0, MAX_PUBLISHED_TEXT).replace(/[\uD800-\uDBFF]$/, "") : s.text;
        insert.run(s.context, s.artifact, s.item, s.artifactVersion, s.issueKey, s.summary, text, truncated ? 1 : 0, s.criteria, s.points ?? null, s.pointsField ?? null, now);
      }
    });
  }

  /** An artifact's stories as they were last sent to Jira, by item. */
  sent(context: string, artifact: string): Map<string, PublishedStory> {
    const rows = this.db.prepare("SELECT * FROM published_story WHERE context = ? AND artifact = ?").all(context, artifact) as unknown as StoryRow[];
    return new Map(rows.map((r) => [r.item, toStory(r)]));
  }
}
