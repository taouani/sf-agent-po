import { randomBytes } from "node:crypto";
import { validateContextName } from "./contexts.js";
import type { Database } from "./db.js";

export const WORKFLOW_STEP_STATUSES = ["pending", "passed", "warned", "failed"] as const;
/**
 * - `pending`: not done yet (it may have failed attempts).
 * - `passed`: checked with no warning; `warned`: checked, with warnings that stay visible.
 * - `failed`: still had errors after the last attempt allowed; saved with its findings for
 *   the user to look at, and the run went on.
 */
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];
export type WorkflowRunStatus = "open" | "done" | "closed";

export interface StepFinding {
  level: "error" | "warning" | "info";
  where: string;
  message: string;
}

export interface WorkflowStep {
  step: string;
  status: WorkflowStepStatus;
  attempts: number;
  /** What the step saved, masked. */
  answer?: unknown;
  /** The last check's findings, masked. */
  findings: StepFinding[];
  /** One line on what the step produced, masked. */
  summary?: string;
  updatedAt: string;
}

export interface WorkflowRun {
  id: string;
  context: string;
  workflow: string;
  /** `closed` when a new run replaced it before it was done. */
  status: WorkflowRunStatus;
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  steps: WorkflowStep[];
}

/** A step's new state; fields left out keep their value. */
export interface StepUpdate {
  status: WorkflowStepStatus;
  attempts?: number;
  answer?: unknown;
  findings: readonly StepFinding[];
  summary?: string;
}

interface RunRow {
  id: string;
  context: string;
  workflow: string;
  status: string;
  options: string;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  step: string;
  status: string;
  attempts: number;
  answer: string | null;
  findings: string;
  summary: string | null;
  updated_at: string;
}

const RUN_ID = /^run-[0-9a-f]{12}$/;

/** A step changed since the state a record was based on: another chat or process submitted it. */
export class WorkflowRunChangedError extends Error {
  constructor(runId: string, step: string) {
    super(`Step "${step}" of run ${runId} changed while this answer was checked (from another chat?). Read the current step with workflow_step.`);
  }
}

/** The workflow runs of each context and their steps, in order. */
export class WorkflowRepository {
  constructor(private readonly database: Database) {}

  private get db() {
    return this.database.db;
  }

  private load(row: RunRow | undefined): WorkflowRun | undefined {
    if (!row) return undefined;
    const steps = (this.db.prepare("SELECT * FROM workflow_step WHERE run = ? ORDER BY seq").all(row.id) as unknown as StepRow[]).map(
      (s): WorkflowStep => ({
        step: s.step,
        status: s.status as WorkflowStepStatus,
        attempts: s.attempts,
        ...(s.answer !== null ? { answer: JSON.parse(s.answer) as unknown } : {}),
        findings: JSON.parse(s.findings) as StepFinding[],
        ...(s.summary !== null ? { summary: s.summary } : {}),
        updatedAt: s.updated_at,
      }),
    );
    return {
      id: row.id,
      context: row.context,
      workflow: row.workflow,
      status: row.status as WorkflowRunStatus,
      options: JSON.parse(row.options) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      steps,
    };
  }

  get(id: string): WorkflowRun | undefined {
    if (!RUN_ID.test(id)) return undefined;
    return this.load(this.db.prepare("SELECT * FROM workflow_run WHERE id = ?").get(id) as RunRow | undefined);
  }

  /** The open run of a workflow in a context, if there is one. */
  open(context: string, workflow: string): WorkflowRun | undefined {
    return this.load(this.db.prepare("SELECT * FROM workflow_run WHERE context = ? AND workflow = ? AND status = 'open'").get(context, workflow) as RunRow | undefined);
  }

  /** The runs of a context, the newest first. */
  list(context: string, { limit = 20 } = {}): WorkflowRun[] {
    const rows = this.db.prepare("SELECT * FROM workflow_run WHERE context = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(context, limit) as unknown as RunRow[];
    return rows.map((r) => this.load(r)!);
  }

  /** Starts a run with its steps, all pending. An open run of the same workflow is closed first. */
  start(context: string, workflow: string, steps: readonly string[], options: Record<string, unknown> = {}): WorkflowRun {
    validateContextName(context);
    if (!steps.length) throw new Error("A workflow run needs at least one step.");
    if (new Set(steps).size !== steps.length) throw new Error("A workflow's steps must have different names.");
    const id = `run-${randomBytes(6).toString("hex")}`;
    this.database.write(() => {
      const now = new Date().toISOString();
      this.db.prepare("INSERT OR IGNORE INTO context (name, created_at, updated_at) VALUES (?, ?, ?)").run(context, now, now);
      this.db.prepare("UPDATE workflow_run SET status = 'closed', updated_at = ? WHERE context = ? AND workflow = ? AND status = 'open'").run(now, context, workflow);
      this.db
        .prepare("INSERT INTO workflow_run (id, context, workflow, status, options, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)")
        .run(id, context, workflow, JSON.stringify(options), now, now);
      const add = this.db.prepare("INSERT INTO workflow_step (run, seq, step, status, updated_at) VALUES (?, ?, ?, 'pending', ?)");
      steps.forEach((s, i) => add.run(id, i + 1, s, now));
    });
    return this.get(id)!;
  }

  /**
   * Records a step's new state in an open run, and ends the run (`done`) once no step is
   * pending. With `expected`, the step must still be in that state (WorkflowRunChangedError).
   */
  record(runId: string, step: string, update: StepUpdate, expected?: { status: WorkflowStepStatus; attempts: number }): WorkflowRun {
    this.database.write(() => {
      const run = this.db.prepare("SELECT status FROM workflow_run WHERE id = ?").get(runId) as { status: string } | undefined;
      if (!run) throw new Error(`No workflow run ${runId}.`);
      if (run.status !== "open") throw new Error(`Run ${runId} is ${run.status}; start a new one with workflow_start.`);
      const now = new Date().toISOString();
      const sets = ["status = ?", "findings = ?", "updated_at = ?"];
      const values: (string | number | null)[] = [update.status, JSON.stringify(update.findings), now];
      if (update.attempts !== undefined) (sets.push("attempts = ?"), values.push(update.attempts));
      if (update.answer !== undefined) (sets.push("answer = ?"), values.push(JSON.stringify(update.answer)));
      if (update.summary !== undefined) (sets.push("summary = ?"), values.push(update.summary));
      const where = expected ? " AND status = ? AND attempts = ?" : "";
      const done = this.db
        .prepare(`UPDATE workflow_step SET ${sets.join(", ")} WHERE run = ? AND step = ?${where}`)
        .run(...values, runId, step, ...(expected ? [expected.status, expected.attempts] : []));
      if (!done.changes) {
        const exists = this.db.prepare("SELECT 1 FROM workflow_step WHERE run = ? AND step = ?").get(runId, step);
        throw exists ? new WorkflowRunChangedError(runId, step) : new Error(`Run ${runId} has no step "${step}".`);
      }
      const pending = this.db.prepare("SELECT count(*) AS n FROM workflow_step WHERE run = ? AND status = 'pending'").get(runId) as { n: number };
      this.db.prepare(`UPDATE workflow_run SET updated_at = ?${pending.n ? "" : ", status = 'done'"} WHERE id = ?`).run(now, runId);
    });
    return this.get(runId)!;
  }

  /** Ends an open run: `done` once every step is passed, warned or failed, `closed` otherwise. */
  finish(runId: string, status: Exclude<WorkflowRunStatus, "open">): WorkflowRun {
    this.database.write(() => {
      const done = this.db.prepare("UPDATE workflow_run SET status = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(status, new Date().toISOString(), runId);
      if (!done.changes) throw new Error(`Run ${runId} is not open.`);
    });
    return this.get(runId)!;
  }
}
