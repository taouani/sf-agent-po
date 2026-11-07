// `sf-agent-po index`: fills the metadata index of the workspace from a project folder or an
// org, in the foreground, and says what it found.

import path from "node:path";
import type { IndexTarget } from "@sf-agent-po/connectors";
import type { SnapshotInfo } from "@sf-agent-po/core";

export const INDEX_USAGE = `Usage: npx sf-agent-po@next index (--org <alias or username> | --project <folder>) [--workspace <folder>] [--force]

Reads a Salesforce project folder (source or metadata format), or retrieves an org's
metadata with your Salesforce CLI (sf, logged in with sf org login), into the
metadata index of the workspace (SF_AGENT_WORKSPACE, else .sf-agent here). An org is
only read, never changed. --force starts even if another run of the same source
seems to be going.`;

export interface IndexArgs {
  target: IndexTarget;
  workspace: string;
  force: boolean;
}

export function parseIndexArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): IndexArgs | { help: string } {
  let target: IndexTarget | undefined;
  let workspace = path.resolve(env.SF_AGENT_WORKSPACE ?? path.join(cwd, ".sf-agent"));
  let force = false;
  const value = (i: number, flag: string) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value.\n\n${INDEX_USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: INDEX_USAGE };
    if (arg === "--force") force = true;
    else if (arg === "--workspace") workspace = path.resolve(cwd, value(++i, arg));
    else if (arg === "--org" || arg === "--project") {
      if (target) throw new Error(`Give one of --org or --project.\n\n${INDEX_USAGE}`);
      const v = value(++i, arg);
      target = arg === "--org" ? { kind: "org", targetOrg: v } : { kind: "project", dir: path.resolve(cwd, v) };
    } else throw new Error(`Unknown option "${arg}".\n\n${INDEX_USAGE}`);
  }
  if (!target) throw new Error(`Give --org or --project.\n\n${INDEX_USAGE}`);
  return { target, workspace, force };
}

/** The lines the command prints once a run is done. */
export function describeSnapshot(s: SnapshotInfo): string[] {
  const counts = Object.entries(s.stats.counts ?? {}).sort(([, a], [, b]) => (b ?? 0) - (a ?? 0));
  const total = counts.reduce((n, [, c]) => n + (c ?? 0), 0);
  const skipped = s.stats.skippedCount ?? s.stats.skipped?.length ?? 0;
  // What the org did not return comes first, as "(retrieve)" entries; then unreadable files.
  const listed = s.stats.skipped ?? [];
  const retrieve = listed.filter((f) => f.file === "(retrieve)");
  const files = listed.filter((f) => f.file !== "(retrieve)");
  const unread = skipped - retrieve.length;
  return [
    `Indexed ${total} components, ${s.stats.edges ?? 0} links, ${s.stats.referenced ?? 0} referenced from outside the project.`,
    ...counts.slice(0, 12).map(([type, n]) => `  ${type}: ${n}`),
    ...(counts.length > 12 ? [`  and ${counts.length - 12} more types`] : []),
    ...(retrieve.length
      ? ["The org did not return everything it listed:", ...retrieve.slice(0, 10).map((f) => `  ${f.reason}`), ...(retrieve.length > 10 ? [`  and ${retrieve.length - 10} more`] : [])]
      : []),
    ...(unread > 0 ? [`${unread} ${unread === 1 ? "file" : "files"} could not be read:`, ...files.slice(0, 10).map((f) => `  ${f.file}: ${f.reason}`)] : []),
  ];
}
