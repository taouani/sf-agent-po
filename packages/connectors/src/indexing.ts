// Fills the metadata index from a project folder or an org, in the foreground (the index
// command) or in the background (the server), one run per source at a time.

import { createHash } from "node:crypto";
import path from "node:path";
import { scanProject, type MetadataIndex, type SnapshotInfo } from "@sf-agent-po/core";
import { run } from "./exec.js";
import { checkOrgArg, retrieveOrgMetadata, type RetrieveOptions } from "./org-metadata.js";
import { defaultSfRunner } from "./salesforce.js";

export type IndexTarget = { kind: "project"; dir: string } | { kind: "org"; targetOrg: string };

export interface IndexOptions {
  /** The workspace: retrieved org metadata is kept under `<workspace>/orgs`. */
  workspace: string;
  progress?: (message: string) => void;
  sf?: RetrieveOptions["sf"];
  /** Start even if another run of the same source looks alive (its lease has not run out). */
  force?: boolean;
}

/**
 * A project's source name: its folder's name and a short hash of its full path, so that two
 * projects of one name stay apart and the path (which holds the user's name) is not stored.
 */
export function projectSource(dir: string): string {
  const full = path.resolve(dir);
  return `repo:${path.basename(full)}#${createHash("sha256").update(full).digest("hex").slice(0, 8)}`;
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

/** Indexes a Salesforce project folder (a checkout, or a folder on a shared drive). */
export async function indexProject(index: MetadataIndex, dir: string, options: Pick<IndexOptions, "progress" | "force"> = {}): Promise<SnapshotInfo> {
  const revision = await gitRevision(dir);
  options.progress?.(`Reading ${path.basename(path.resolve(dir))}`);
  return index.build({ source: projectSource(dir), kind: "repo", ...(revision ? { revision } : {}) }, () => scanProject(dir), { force: options.force });
}

/** Retrieves an org's metadata with the user's sf CLI and indexes it. */
export async function indexOrg(index: MetadataIndex, targetOrg: string, options: IndexOptions): Promise<SnapshotInfo> {
  checkOrgArg(targetOrg);
  const sf = options.sf ?? defaultSfRunner;
  // The org id names the source, so that two aliases of one org share its index.
  const info = (await sf(["org", "display", "--target-org", targetOrg])) as { id?: string };
  if (typeof info?.id !== "string" || !/^[A-Za-z0-9]{15,18}$/.test(info.id)) throw new Error(`sf org display gave no org id for ${targetOrg}.`);
  return index.build(
    { source: `org:${info.id}`, kind: "org", revision: new Date().toISOString() },
    async () => {
      const retrieved = await retrieveOrgMetadata({ targetOrg, dir: path.join(options.workspace, "orgs"), sf, progress: options.progress });
      options.progress?.("Reading the retrieved metadata");
      return scanProject(retrieved.dir);
    },
    { force: options.force },
  );
}

export function indexTarget(index: MetadataIndex, target: IndexTarget, options: IndexOptions): Promise<SnapshotInfo> {
  return target.kind === "project" ? indexProject(index, target.dir, options) : indexOrg(index, target.targetOrg, options);
}

export interface IndexJob {
  /** "project:<folder>" or "org:<alias>", as it was asked for. */
  target: string;
  state: "running" | "ready" | "failed";
  startedAt: string;
  finishedAt?: string;
  /** The last progress line, or the error. */
  message?: string;
  snapshot?: SnapshotInfo;
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
    const key = target.kind === "project" ? `project:${path.resolve(target.dir)}` : `org:${target.targetOrg}`;
    const running = this.jobs.get(key);
    if (running?.job.state === "running") return running;
    const job: IndexJob = { target: key, state: "running", startedAt: new Date().toISOString() };
    const done = indexTarget(this.index, target, { ...this.options, progress: (m) => (job.message = m) }).then(
      (snapshot) => Object.assign(job, { state: "ready" as const, snapshot, finishedAt: new Date().toISOString(), message: undefined }),
      (err: unknown) => Object.assign(job, { state: "failed" as const, finishedAt: new Date().toISOString(), message: (err as Error)?.message ?? String(err) }),
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
