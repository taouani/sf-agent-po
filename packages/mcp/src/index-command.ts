// `sf-agent-po index`: fills the metadata index of the workspace from a project folder, a
// remote repository or an org, in the foreground, and says what it found.

import path from "node:path";
import type { IndexTarget } from "@sf-agent-po/connectors";
import type { SnapshotInfo } from "@sf-agent-po/core";

export const INDEX_USAGE = `Usage: npx sf-agent-po@next index (--org <alias or username> | --project <folder> | --repo <repository>) [--workspace <folder>] [--full] [--force] [--parallel 1|2|3]

Reads a Salesforce project folder (source or metadata format), a repository, or
retrieves an org's metadata with your Salesforce CLI (sf, logged in with sf org
login), into the metadata index of the workspace (SF_AGENT_WORKSPACE, else .sf-agent
here). An org is only read, never changed. A repository is github:owner/repo,
gitlab:group/repo, azure-devops:<clone URL> or git:<clone URL>, with #<branch> to
pick a branch or tag: it is cloned with your own gh, glab or git into the workspace,
and fetched again on the next run. An org run retrieves only what changed since the
last run (profiles and permission sets every time), and all of it once a week; files
that did not change are not parsed again, unless they were last parsed more than 7
days ago or sf-agent-po's readers changed. --full retrieves and parses everything.
An org is retrieved in parts of up to 9,000 files, 2 at a time; --parallel 1 retrieves
them one after another (lighter on the org), --parallel 3 three at a time. The run
ends with the time each step took.
--force starts even if another run of the same source seems to be going (two runs of
one repository then share its checkout).`;

export interface IndexArgs {
  target: IndexTarget;
  workspace: string;
  force: boolean;
  full: boolean;
  /** Parts of an org retrieved at the same time. */
  parallel?: number;
}

export function parseIndexArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): IndexArgs | { help: string } {
  let target: IndexTarget | undefined;
  let workspace = path.resolve(env.SF_AGENT_WORKSPACE ?? path.join(cwd, ".sf-agent"));
  let force = false;
  let full = false;
  let parallel: number | undefined;
  const value = (i: number, flag: string) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value.\n\n${INDEX_USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: INDEX_USAGE };
    if (arg === "--force") force = true;
    else if (arg === "--full") full = true;
    else if (arg === "--parallel") {
      const v = value(++i, arg);
      if (!/^[123]$/.test(v)) throw new Error(`--parallel takes 1, 2 or 3.\n\n${INDEX_USAGE}`);
      parallel = Number(v);
    }
    else if (arg === "--workspace") workspace = path.resolve(cwd, value(++i, arg));
    else if (arg === "--org" || arg === "--project" || arg === "--repo") {
      if (target) throw new Error(`Give one of --org, --project or --repo.\n\n${INDEX_USAGE}`);
      const v = value(++i, arg);
      target = arg === "--org" ? { kind: "org", targetOrg: v } : arg === "--repo" ? { kind: "remote", repo: v } : { kind: "project", dir: path.resolve(cwd, v) };
    } else throw new Error(`Unknown option "${arg}".\n\n${INDEX_USAGE}`);
  }
  if (!target) throw new Error(`Give --org, --project or --repo.\n\n${INDEX_USAGE}`);
  if (parallel !== undefined && target.kind !== "org") throw new Error(`--parallel only goes with --org.\n\n${INDEX_USAGE}`);
  return { target, workspace, force, full, ...(parallel ? { parallel } : {}) };
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
    ...(s.stats.files ? [s.stats.full ? `Parsed all ${s.stats.files.read} files (a full run).` : `Parsed ${s.stats.files.read} changed files; ${s.stats.files.reused} unchanged ones came from the last run.`] : []),
    ...counts.slice(0, 12).map(([type, n]) => `  ${type}: ${n}`),
    ...(counts.length > 12 ? [`  and ${counts.length - 12} more types`] : []),
    ...(retrieve.length
      ? ["The org did not return everything it listed:", ...retrieve.slice(0, 10).map((f) => `  ${f.reason}`), ...(retrieve.length > 10 ? [`  and ${retrieve.length - 10} more`] : [])]
      : []),
    ...(unread > 0 ? [`${unread} ${unread === 1 ? "file" : "files"} could not be read:`, ...files.slice(0, 10).map((f) => `  ${f.file}: ${f.reason}`)] : []),
  ];
}
