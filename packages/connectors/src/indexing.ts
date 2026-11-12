// Fills the metadata index from a project folder or an org, in the foreground (the index
// command) or in the background (the server), one run per source at a time.

import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { MAX_SKIPPED_LISTED, scanProject, type MetadataIndex, type ParseCache, type SnapshotInfo, type SnapshotTarget } from "@sf-agent-po/core";
import { run } from "./exec.js";
import { parseRepoSpec, redactLocation, repoSource, resolveMetadataSource, type MetadataSourceSpec } from "./metadata-source.js";
import { checkOrgArg, orgIdOf, retrieveOrgMetadata, type RetrieveOptions } from "./org-metadata.js";
import { defaultSfRunner } from "./salesforce.js";

/** A named set of a repository's package folders, indexed as its own source, and the org it is deployed to. */
export interface FolderSet {
  name: string;
  /** Package names or folder paths, as in sfdx-project.json. */
  packages: string[];
  /** The org's alias or username, or its source ("org:00D..."). */
  forOrg?: string;
}

export type IndexTarget =
  | { kind: "project"; dir: string; set?: FolderSet }
  | { kind: "org"; targetOrg: string }
  | { kind: "remote"; repo: string | MetadataSourceSpec; set?: FolderSet };

/** A folder set's name: short, and safe in a source name and a file name. */
export const SET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

/** Checks a folder set before a run, so that a typo fails at once. */
export function checkFolderSet(set: FolderSet): void {
  if (!SET_NAME.test(set.name)) throw new Error(`A folder set's name has letters, digits, ".", "_" or "-", up to 40 (not "${set.name}").`);
  if (!set.packages.length || set.packages.some((p) => !p.trim())) throw new Error("Name at least one package folder.");
  if (set.forOrg && !/^org:00D[0-9A-Za-z]{12,15}$/.test(set.forOrg)) checkOrgArg(set.forOrg);
}

/**
 * The source of a folder set: the repository's source with the set's name, and a hash of both,
 * so that two sets of one repository, or one set name in two repositories, stay apart.
 */
export function setSource(repo: string, name: string): string {
  const [, base, hash] = /^(repo:.*)#([0-9a-f]{8})$/.exec(repo) ?? [];
  if (!base || !hash) throw new Error(`Not a repository source: ${repo}`);
  return `${base}:${name}#${createHash("sha256").update(`${hash}\0${name}`).digest("hex").slice(0, 8)}`;
}

export interface IndexOptions {
  /** The workspace: retrieved org metadata is kept under `<workspace>/orgs`. */
  workspace: string;
  progress?: (message: string) => void;
  sf?: RetrieveOptions["sf"];
  /** Start even if another run of the same source looks alive (its lease has not run out). */
  force?: boolean;
  /** Parse every file again, reusing nothing from the last run. */
  full?: boolean;
  /** Parts of an org retrieved at the same time (2 by default, at most 3). */
  parallelRetrieves?: number;
  /** Let git and gh ask for credentials: a run in a terminal, not the server's. */
  interactive?: boolean;
}

/**
 * A project's source name: its folder's name and a short hash of its full path, so that two
 * projects of one name stay apart and the path (which holds the user's name) is not stored.
 */
export function projectSource(dir: string): string {
  const full = path.resolve(dir);
  // Windows paths do not care about case: C:\Repo and c:\repo are one project.
  const key = process.platform === "win32" ? full.toLowerCase() : full;
  return `repo:${path.basename(full)}#${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

/** The commit a git checkout is at, or undefined. */
async function gitRevision(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"], { timeoutMs: 10_000 });
    const sha = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** An error's message with the workspace and home folder taken out: they hold the user's name. */
function scrubbed(err: unknown, workspace?: string): Error {
  let message = (err as Error)?.message ?? String(err);
  for (const [p, as] of [[workspace, "<workspace>"], [os.homedir(), "~"]] as const) {
    if (p && p.length > 1) message = message.split(path.resolve(p)).join(as);
  }
  const out = new Error(message);
  if (err instanceof Error && err.stack) out.stack = err.stack.replace((err as Error).message, message);
  return out;
}

/** Runs a step and scrubs what it throws. */
async function scrubbing<T>(workspace: string | undefined, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    throw scrubbed(err, workspace);
  }
}

/** Retrieve problems kept as lines: well under the index's cap on listed problems. */
const MAX_WARNING_LINES = 50;

/**
 * The CLI's retrieve warnings, with the many "cannot be found" ones (components the org lists
 * but does not return, such as list views of some standard objects) counted by type.
 */
export function summarizeWarnings(warnings: readonly string[]): string[] {
  const missing = new Map<string, string[]>();
  const other: string[] = [];
  for (const w of warnings) {
    const m = /^Entity of type '([^']+)' named '([^']+)' cannot be found/.exec(w);
    if (m) missing.set(m[1]!, [...(missing.get(m[1]!) ?? []), m[2]!]);
    else other.push(w);
  }
  const counted = [...missing].sort(([, a], [, b]) => b.length - a.length).map(([type, names]) =>
    names.length === 1 ? `${type} ${names[0]} was listed but not returned` : `${names.length} ${type} components were listed but not returned, such as ${names.slice(0, 3).join(", ")}`,
  );
  // The same problem comes back once per part; and the lines stay well under the index's cap
  // on listed problems, so that they are all counted apart from unreadable files.
  const lines = [...counted, ...new Set(other)];
  return lines.length > MAX_WARNING_LINES ? [...lines.slice(0, MAX_WARNING_LINES - 1), `and ${lines.length - MAX_WARNING_LINES + 1} more problems`] : lines;
}

/** "1h 05m", "4m 12s", "38s", or "under a second". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "under a second";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** Progress lines that say what was done ("Retrieved 14 parts, ..."), not what starts: notes. */
const NOTE = /^Retrieved /;
/** The step a progress line starts: the parts of a retrieval, retrieved a few at a time, are one step. */
const RETRIEVING = "Retrieving the metadata";
const stepOf = (message: string) =>
  /^Retrieving (?:part \d+ of \d+|part \d+(?:\.\d+)+|\d+ .*components)$|^Part [\d.]+ (?:is too large|failed)/.test(message) ? RETRIEVING : message;

/**
 * Times a run from its progress lines: each line starts a step, which ends with the next line
 * (or `stop`). The same step met again (the parts of a retrieval) adds up. A line that says
 * what was done is kept as a note, under the retrieval when there is one.
 */
export class StepTimer {
  private readonly steps = new Map<string, { ms: number; notes: string[] }>();
  private current?: { step: string; at: number };
  private readonly startedAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  /** Starts the step this progress line names, or notes what it says was done. */
  mark(message: string): void {
    if (NOTE.test(message)) {
      const step = this.steps.has(RETRIEVING) || this.current?.step === RETRIEVING ? RETRIEVING : this.current?.step;
      if (step) this.entry(step).notes.push(message);
      return;
    }
    const step = stepOf(message);
    // Parts retrieved together: the step goes on.
    if (this.current?.step === step && step === RETRIEVING) return;
    this.stop();
    this.entry(step);
    this.current = { step, at: this.now() };
  }

  /** Ends the step in progress. */
  stop(): void {
    if (!this.current) return;
    this.entry(this.current.step).ms += this.now() - this.current.at;
    this.current = undefined;
  }

  /** "Time per step:", a line per step in the order they started, its notes, and the run's total. */
  lines(): string[] {
    this.stop();
    if (!this.steps.size) return [];
    return [
      "Time per step:",
      ...[...this.steps].flatMap(([step, s]) => [`  ${step}: ${formatDuration(s.ms)}`, ...s.notes.map((n) => `    ${n}`)]),
      `  In all: ${formatDuration(this.now() - this.startedAt)}`,
    ];
  }

  private entry(step: string) {
    let s = this.steps.get(step);
    if (!s) this.steps.set(step, (s = { ms: 0, notes: [] }));
    return s;
  }
}

/** What a folder set's snapshot records: its packages, and its org by id (never the alias or username). */
async function setTarget(set: FolderSet, sf: RetrieveOptions["sf"] = defaultSfRunner): Promise<SnapshotTarget> {
  let org: string | undefined;
  if (set.forOrg?.startsWith("org:")) org = set.forOrg;
  else if (set.forOrg) {
    const id = orgIdOf(await sf(["org", "display", "--target-org", set.forOrg]));
    if (!id) throw new Error(`sf org display gave no org id for ${set.forOrg}.`);
    org = `org:${id}`;
  }
  return { name: set.name, packages: [...set.packages], ...(org ? { org } : {}) };
}

/** Indexes a Salesforce project folder (a checkout, or a folder on a shared drive), or a set of its package folders. */
export async function indexProject(
  index: MetadataIndex,
  dir: string,
  options: Pick<IndexOptions, "progress" | "force" | "full" | "sf"> & { workspace?: string; set?: FolderSet } = {},
): Promise<SnapshotInfo> {
  const set = options.set;
  if (set) checkFolderSet(set);
  const revision = await gitRevision(dir);
  try {
    const target = set ? await setTarget(set, options.sf) : undefined;
    options.progress?.(`Reading ${path.basename(path.resolve(dir))}${set ? ` (${set.name}: ${set.packages.join(", ")})` : ""}`);
    const read = (_lease: unknown, cache: ParseCache) =>
      scrubbing(options.workspace, async () => {
        const parsed = await scanProject(dir, { exclude: options.workspace ? [options.workspace] : [], cache, ...(set ? { packages: set.packages } : {}) });
        options.progress?.("Writing the index");
        return parsed;
      });
    const source = set ? setSource(projectSource(dir), set.name) : projectSource(dir);
    return await index.build({ source, kind: "repo", ...(revision ? { revision } : {}), ...(target ? { target } : {}) }, read, {
      force: options.force,
      full: options.full,
    });
  } catch (err) {
    throw scrubbed(err, options.workspace);
  }
}

/**
 * Indexes a remote repository: cloned with the user's own gh, glab or git into
 * `<workspace>/repos` the first time, brought up to date on later runs, so that the parse
 * cache finds the files that did not change.
 */
export async function indexRemote(index: MetadataIndex, spec: string | MetadataSourceSpec, options: IndexOptions & { set?: FolderSet }): Promise<SnapshotInfo> {
  const repo = typeof spec === "string" ? parseRepoSpec(spec) : spec;
  if (repo.provider === "local") return indexProject(index, repo.location, options);
  const set = options.set;
  if (set) checkFolderSet(set);
  try {
    const target = set ? await setTarget(set, options.sf) : undefined;
    return await index.build(
      { source: set ? setSource(repoSource(repo), set.name) : repoSource(repo), kind: "repo", ...(target ? { target } : {}) },
      // Fetched under the lease, so that two runs of one repository never share a checkout.
      (lease, cache) => scrubbing(options.workspace, async () => {
        const dir = await resolveMetadataSource(repo, options.workspace, { progress: options.progress, interactive: options.interactive });
        lease.renew();
        const revision = await gitRevision(dir);
        if (revision) lease.setRevision(revision);
        options.progress?.(`Reading ${redactLocation(repo.location)}${repo.ref ? ` at ${repo.ref}` : ""}${set ? ` (${set.name}: ${set.packages.join(", ")})` : ""}`);
        const parsed = await scanProject(dir, { cache, ...(set ? { packages: set.packages } : {}) });
        options.progress?.("Writing the index");
        return parsed;
      }),
      { force: options.force, full: options.full },
    );
  } catch (err) {
    throw scrubbed(err, options.workspace);
  }
}

/** Retrieves an org's metadata with the user's sf CLI and indexes it. */
export async function indexOrg(index: MetadataIndex, targetOrg: string, options: IndexOptions): Promise<SnapshotInfo> {
  checkOrgArg(targetOrg);
  const sf = options.sf ?? defaultSfRunner;
  try {
    // The org id names the source, so that two aliases of one org share its index.
    const shown: unknown = await sf(["org", "display", "--target-org", targetOrg]);
    const id = orgIdOf(shown);
    if (!id) throw new Error(`sf org display gave no org id for ${targetOrg}.`);
    const alias = (shown as { alias?: unknown }).alias;
    return await index.build(
      { source: `org:${id}`, kind: "org", revision: new Date().toISOString() },
      // Errors are scrubbed inside the read too, because the index stores what it throws.
      (lease, cache) => scrubbing(options.workspace, async () => {
        const retrieved = await retrieveOrgMetadata({
          targetOrg,
          org: { id, ...(typeof alias === "string" ? { alias } : {}) },
          dir: path.join(options.workspace, "orgs"),
          sf,
          progress: options.progress,
          heartbeat: () => lease.renew(),
          full: options.full,
          ...(options.parallelRetrieves ? { parallelRetrieves: options.parallelRetrieves } : {}),
        });
        if (retrieved.incremental) options.progress?.(`Retrieved ${retrieved.incremental.retrieved} changed or always retrieved components; ${retrieved.incremental.deleted} deleted since the last run`);
        options.progress?.("Reading the retrieved metadata");
        const parsed = await scanProject(retrieved.dir, { cache });
        // Files came back, but nothing the index reads: the retrieval went wrong somewhere.
        if (!parsed.components.some((c) => !c.missing)) throw new Error(`Nothing could be read from what ${targetOrg} returned.`);
        // What the org could not return is reported with what could not be read.
        const warnings = summarizeWarnings(retrieved.warnings).map((reason) => ({ file: "(retrieve)", reason }));
        const skipped = [...warnings, ...parsed.skipped].slice(0, MAX_SKIPPED_LISTED);
        const total = warnings.length + (parsed.skippedCount ?? parsed.skipped.length);
        options.progress?.("Writing the index");
        return { ...parsed, skipped, ...(total > skipped.length ? { skippedCount: total } : {}) };
      }),
      { force: options.force, full: options.full },
    );
  } catch (err) {
    throw scrubbed(err, options.workspace);
  }
}

export function indexTarget(index: MetadataIndex, target: IndexTarget, options: IndexOptions): Promise<SnapshotInfo> {
  if (target.kind === "project") return indexProject(index, target.dir, { ...options, ...(target.set ? { set: target.set } : {}) });
  if (target.kind === "remote") return indexRemote(index, target.repo, { ...options, ...(target.set ? { set: target.set } : {}) });
  return indexOrg(index, target.targetOrg, options);
}

export interface IndexJob {
  /** What is indexed, without the folder's path: "repo:<name>#<hash>" or "org:<alias>". */
  target: string;
  state: "running" | "ready" | "failed";
  startedAt: string;
  finishedAt?: string;
  /** The last progress line, or the error. */
  message?: string;
  snapshot?: SnapshotInfo;
  /** Once the run is over: how long each step took (StepTimer.lines). */
  steps?: string[];
}

/**
 * Runs indexing in the background, one run per target at a time: asking again while one runs
 * returns that run. Jobs are kept until the server stops; the index keeps the snapshots.
 */
export class BackgroundIndexer {
  private readonly jobs = new Map<string, { job: IndexJob; done: Promise<IndexJob> }>();

  constructor(
    private readonly index: MetadataIndex,
    private readonly options: Omit<IndexOptions, "progress">,
  ) {}

  /** Starts indexing a target, or returns the run already going for it. */
  start(target: IndexTarget): { job: IndexJob; done: Promise<IndexJob> } {
    const repo = target.kind === "remote" ? (typeof target.repo === "string" ? parseRepoSpec(target.repo) : target.repo) : undefined;
    const base = target.kind === "project" ? projectSource(target.dir) : target.kind === "org" ? `org:${target.targetOrg}` : repoSource(repo!);
    const set = target.kind === "org" ? undefined : target.set;
    if (set) checkFolderSet(set);
    const name = set ? setSource(base, set.name) : base;
    const key = target.kind === "project" ? `project:${path.resolve(target.dir)}${set ? `:${set.name}` : ""}` : name;
    const running = this.jobs.get(key);
    if (running?.job.state === "running") return running;
    const job: IndexJob = { target: name, state: "running", startedAt: new Date().toISOString() };
    const timer = new StepTimer();
    const progress = (m: string) => {
      timer.mark(m);
      job.message = m;
    };
    const done = indexTarget(this.index, target, { ...this.options, progress }).then(
      (snapshot) => Object.assign(job, { state: "ready" as const, snapshot, finishedAt: new Date().toISOString(), message: undefined, steps: timer.lines() }),
      (err: unknown) => Object.assign(job, { state: "failed" as const, finishedAt: new Date().toISOString(), message: (err as Error)?.message ?? String(err), steps: timer.lines() }),
    );
    const entry = { job, done };
    this.jobs.set(key, entry);
    return entry;
  }

  /** Every run since the server started, newest first. */
  list(): IndexJob[] {
    return [...this.jobs.values()].map((j) => j.job).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  /** Waits for every run in progress (at shutdown, or in tests). */
  async settle(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((j) => j.done));
  }
}
