// `sf-agent-po report`: the success measure and the design ratings of a workspace, from its
// feedback table. Everything there is masked, so the report needs no vault key and holds no
// real value. --csv writes the same numbers to a local file. Nothing leaves the machine.

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { feedbackReport, formatReport, reportCsv } from "./report.js";

export const REPORT_USAGE = `Usage: npx sf-agent-po@next report [--workspace <folder>] [--context <name>] [--csv <file>]

Prints the share of published stories accepted without major edits, against the
90% target, by context, model label and workflow, and the average rating of each
design section. A person's verdict counts before the Jira diff's guess. --context
keeps one requirement context; --csv also writes the numbers to a CSV file. The
workspace is SF_AGENT_WORKSPACE, else .sf-agent here. Nothing leaves your machine.`;

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

/** Prints the report, and writes the CSV file when asked. Returns the exit code. */
export async function runReport(opts: ReportArgs, deps: ReportDeps): Promise<number> {
  const { ContextRepository, Database, FeedbackRepository } = await import("@sf-agent-po/core");
  const { databaseFile } = await import("./startup.js");
  const file = databaseFile(opts.workspace);
  // A report never creates a workspace.
  if (!existsSync(file)) throw new Error(`There is no workspace at ${opts.workspace}: run the command where the server runs, or pass --workspace.`);
  const database = new Database(file);
  try {
    const contexts = new ContextRepository(database);
    const feedback = new FeedbackRepository(database);
    const names = contexts.list().map((c) => c.name);
    if (opts.context !== undefined && !names.includes(opts.context)) throw new Error(`There is no context "${opts.context}" in ${opts.workspace}. Contexts: ${names.join(", ") || "none"}.`);
    const report = feedbackReport((opts.context !== undefined ? [opts.context] : names).flatMap((n) => feedback.list(n)));
    deps.out(formatReport(report));
    if (opts.csv) {
      // Readable by this user only, like the workspace.
      writeFileSync(opts.csv, reportCsv(report), { mode: 0o600 });
      deps.out(`\nWrote ${report.groups.length + report.ratings.length} row(s) to ${opts.csv}.`);
    }
    return 0;
  } finally {
    database.close();
  }
}
