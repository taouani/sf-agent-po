import { validateContextName } from "./contexts.js";
import type { Database } from "./db.js";

export const REQUIREMENT_KINDS = ["functional", "non-functional", "constraint", "compliance"] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];
export const REQUIREMENT_PRIORITIES = ["must", "should", "could", "wont"] as const;
export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];
export const REQUIREMENT_STATUSES = ["proposed", "confirmed", "dropped"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** A requirement of a context. `statement` is masked, like every document. */
export interface Requirement {
  context: string;
  /** "R1", "R2"...: never reused within a context. */
  id: string;
  kind: RequirementKind;
  statement: string;
  priority: RequirementPriority;
  status: RequirementStatus;
  /** "agent" when an agent extracted it from the inputs, "user" when the user typed it in. */
  origin: "agent" | "user";
  /** The context documents it comes from. */
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** A requirement to save: with an `id` it changes that requirement, without one it is new. */
export interface RequirementChange {
  id?: string;
  kind: RequirementKind;
  statement: string;
  priority: RequirementPriority;
  status: RequirementStatus;
  origin?: Requirement["origin"];
  sourceIds: readonly string[];
}

interface Row {
  context: string;
  id: string;
  kind: string;
  statement: string;
  priority: string;
  status: string;
  origin: string;
  source_ids: string;
  created_at: string;
  updated_at: string;
}

const toRequirement = (r: Row): Requirement => ({
  context: r.context,
  id: r.id,
  kind: r.kind as RequirementKind,
  statement: r.statement,
  priority: r.priority as RequirementPriority,
  status: r.status as RequirementStatus,
  origin: r.origin as Requirement["origin"],
  sourceIds: JSON.parse(r.source_ids) as string[],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const REQUIREMENT_ID = /^R[1-9]\d{0,5}$/;

/**
 * The requirements of each context. New requirements get the next free number, counted over
 * every requirement the context ever had, so an id is never given twice.
 */
export class RequirementRepository {
  constructor(private readonly database: Database) {}

  private get db() {
    return this.database.db;
  }

  /** In id order; dropped requirements only when asked for. */
  list(context: string, { dropped = false } = {}): Requirement[] {
    const rows = this.db
      .prepare(`SELECT * FROM requirement WHERE context = ? ${dropped ? "" : "AND status <> 'dropped'"} ORDER BY seq`)
      .all(context) as unknown as Row[];
    return rows.map(toRequirement);
  }

  get(context: string, id: string): Requirement | undefined {
    const row = this.db.prepare("SELECT * FROM requirement WHERE context = ? AND id = ?").get(context, id) as Row | undefined;
    return row && toRequirement(row);
  }

  /**
   * Saves changes in one transaction and returns the saved requirements, in the order given.
   * A change with an id that the context does not have is an error, and nothing is saved.
   */
  save(context: string, changes: readonly RequirementChange[]): Requirement[] {
    validateContextName(context);
    if (!changes.length) return [];
    return this.database.write(() => {
      const now = new Date().toISOString();
      this.db.prepare("INSERT OR IGNORE INTO context (name, created_at, updated_at) VALUES (?, ?, ?)").run(context, now, now);
      const { top } = this.db.prepare("SELECT coalesce(max(seq), 0) AS top FROM requirement WHERE context = ?").get(context) as { top: number };
      let next = top;
      const ids: string[] = [];
      for (const c of changes) {
        const sources = JSON.stringify([...new Set(c.sourceIds)]);
        if (c.id !== undefined) {
          const done = this.db
            .prepare("UPDATE requirement SET kind = ?, statement = ?, priority = ?, status = ?, source_ids = ?, updated_at = ? WHERE context = ? AND id = ?")
            .run(c.kind, c.statement, c.priority, c.status, sources, now, context, c.id);
          if (!done.changes) throw new Error(`Requirement ${c.id} is not in context "${context}".`);
          ids.push(c.id);
          continue;
        }
        next += 1;
        const id = `R${next}`;
        this.db
          .prepare(
            `INSERT INTO requirement (context, id, seq, kind, statement, priority, status, origin, source_ids, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(context, id, next, c.kind, c.statement, c.priority, c.status, c.origin ?? "agent", sources, now, now);
        ids.push(id);
      }
      if (ids.length) this.db.prepare("UPDATE context SET updated_at = ? WHERE name = ?").run(now, context);
      return ids.map((id) => this.get(context, id)!);
    });
  }
}
