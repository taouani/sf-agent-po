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

export class FeedbackRepository {
  constructor(private readonly database: Database) {}

  private get db() {
    return this.database.db;
  }

  /** Records feedback, in one transaction, replacing what was recorded before for the same artifact, item, kind and role. */
  record(entries: readonly FeedbackInput[]): FeedbackEntry[] {
    if (!entries.length) return [];
    for (const e of entries) {
      validateContextName(e.context);
      if (!(FEEDBACK_KINDS as readonly string[]).includes(e.kind)) throw new Error(`Unknown feedback kind ${e.kind}.`);
      const role = e.role ?? "";
      if (!(FEEDBACK_ROLES as readonly string[]).includes(role)) throw new Error(`Unknown role ${role}.`);
      if ((e.kind === "jira_diff") !== (role === "")) throw new Error("The Jira diff is the server's guess, with no role; verdicts and ratings name who gave them.");
      checkValue(e.kind, e.value);
    }
    return this.database.write(() => {
      const now = new Date().toISOString();
      const insert = this.db.prepare(
        `INSERT INTO feedback (context, artifact, item, kind, role, value, comment, model, workflow, details, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (context, artifact, item, kind, role) DO UPDATE SET
           value = excluded.value, comment = excluded.comment, model = excluded.model, workflow = excluded.workflow,
           details = excluded.details, recorded_at = excluded.recorded_at`,
      );
      for (const e of entries) {
        this.db.prepare("INSERT OR IGNORE INTO context (name, created_at, updated_at) VALUES (?, ?, ?)").run(e.context, now, now);
        insert.run(e.context, e.artifact, e.item, e.kind, e.role ?? "", e.value, e.comment ?? null, e.model ?? null, e.workflow ?? null, JSON.stringify(e.details ?? {}), now);
      }
      return entries.map((e) => ({ ...e, role: e.role ?? "", details: e.details ?? {}, recordedAt: now }));
    });
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
    return (this.db.prepare(`SELECT * FROM feedback WHERE ${where.join(" AND ")} ORDER BY artifact, item, kind, role`).all(...params) as unknown as Row[]).map(toEntry);
  }
}
