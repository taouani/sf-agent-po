// `sf-agent-po report`: the success measure and the design ratings of a workspace, from its
// feedback table. Everything there is masked, so the report needs no vault key and holds no
// real value. --csv writes the same numbers to a local file. Nothing leaves the machine.

import { randomBytes } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { feedbackReport, formatReport, reportCsv, reportScope } from "./report.js";

export const REPORT_USAGE = `Usage: npx sf-agent-po@next report [--workspace <folder>] [--context <name>] [--csv <file>]

Prints the share of published stories accepted without major edits, against the
90% target, by context, model label and workflow, and the average rating of each
design section. A person's verdict counts before the Jira diff's guess. --context
keeps one requirement context; --csv also writes the numbers to a CSV file,
readable only by you, outside the workspace. Each story still in a published
backlog counts once, at the version last sent to Jira. The workspace is
SF_AGENT_WORKSPACE, else .sf-agent here; it is only read. Nothing leaves your
machine.`;

export interface ReportArgs {
  workspace: string;
  context?: string;
  csv?: string;
}

export function parseReportArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ReportArgs | { help: string } {
  let workspace = path.resolve(cwd, env.SF_AGENT_WORKSPACE ?? ".sf-agent");
  let context: string | undefined;
  let csv: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { help: REPORT_USAGE };
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value.\n\n${REPORT_USAGE}`);
      return v;
    };
    if (arg === "--workspace") workspace = path.resolve(cwd, value());
    else if (arg === "--context") context = value();
    else if (arg === "--csv") csv = path.resolve(cwd, value());
    else throw new Error(`Unknown option "${arg}".\n\n${REPORT_USAGE}`);
  }
  return { workspace, ...(context !== undefined && { context }), ...(csv && { csv }) };
}

export interface ReportDeps {
  out: (text: string) => void;
}

/** The schema that added the feedback table. */
const FEEDBACK_SCHEMA = 12;

/**
 * Writes the CSV file readable only by this user: to a new file next to it, then renamed over
 * the target, so an existing file's wider permissions or a link at its place are not kept.
 */
function writePrivate(file: string, text: string): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") throw new Error(`${file} cannot be written (${code}): close it if a spreadsheet has it open, or choose another file.`);
    throw err;
  }
}

/** Prints the report, and writes the CSV file when asked. Returns the exit code. */
export async function runReport(opts: ReportArgs, deps: ReportDeps): Promise<number> {
  const { ContextRepository, Database, FeedbackRepository, MIGRATIONS, schemaVersion } = await import("@sf-agent-po/core");
  const { databaseFile } = await import("./startup.js");
  const file = databaseFile(opts.workspace);
  // A report never creates a workspace.
  if (!existsSync(file)) throw new Error(`There is no workspace at ${opts.workspace}: run the command where the server runs, or pass --workspace.`);
  if (opts.csv) {
    const inside = path.relative(opts.workspace, opts.csv);
    if (!inside.startsWith("..") && !path.isAbsolute(inside)) throw new Error(`Write the CSV file outside the workspace folder ${opts.workspace}.`);
  }
  // Read-only: a newer report must not migrate a workspace its server has not upgraded yet.
  const database = new Database(file, MIGRATIONS, { readOnly: true });
  try {
    const schema = schemaVersion(database);
    const known = Math.max(...MIGRATIONS.map((m) => m.version));
    if (schema > known) throw new Error(`${opts.workspace} was written by a newer sf-agent-po (schema ${schema}; this one knows ${known}). Run the newest version: npx -y sf-agent-po@next report`);
    if (schema < FEEDBACK_SCHEMA) {
      deps.out("No feedback recorded yet: this workspace predates feedback, and the server upgrades it when a newer version next starts.");
      return 0;
    }
    const contexts = new ContextRepository(database);
    const feedback = new FeedbackRepository(database);
    const names = contexts.list().map((c) => c.name);
    if (opts.context !== undefined && !names.includes(opts.context)) throw new Error(`There is no context "${opts.context}" in ${opts.workspace}. Contexts: ${names.join(", ") || "none"}.`);
    const chosen = opts.context !== undefined ? [opts.context] : names;
    const report = feedbackReport(
      chosen.flatMap((n) => feedback.list(n)),
      reportScope(contexts, feedback, chosen),
    );
    deps.out(formatReport(report));
    if (opts.csv) {
      // With a byte order mark, so that Excel reads accented labels right.
      writePrivate(opts.csv, `\uFEFF${reportCsv(report)}`);
      deps.out(`\nWrote ${report.groups.length + report.ratings.length + (report.stories ? 1 : 0)} row(s) to ${opts.csv}.`);
    }
    return 0;
  } finally {
    database.close();
  }
}
