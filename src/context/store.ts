import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { RequirementContext, SourceDocument } from "./types.js";

export type NewDocument = Omit<SourceDocument, "id" | "addedAt">;

/**
 * Persists requirement contexts as JSON files under the workspace directory so
 * a context survives across sessions and across hosts (Claude Code, Cursor,
 * Copilot) pointing at the same workspace.
 */
export class ContextStore {
  /** Serialises read-modify-write operations per context, since hosts may run tool calls in parallel. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly workspaceDir: string) {}

  private exclusive<T>(name: string, op: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(name) ?? Promise.resolve();
    const next = prev.then(op, op);
    const settled = next.catch(() => undefined);
    this.queues.set(name, settled);
    void settled.then(() => {
      if (this.queues.get(name) === settled) this.queues.delete(name);
    });
    return next;
  }

  private fileFor(name: string): string {
    if (!/^[\w.-]+$/.test(name)) {
      throw new Error(`Invalid context name "${name}": use letters, digits, '.', '-' or '_'.`);
    }
    return path.join(this.workspaceDir, "contexts", `${name}.json`);
  }

  async load(name: string): Promise<RequirementContext> {
    try {
      return JSON.parse(await readFile(this.fileFor(name), "utf8")) as RequirementContext;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const now = new Date().toISOString();
      return { name, createdAt: now, updatedAt: now, documents: [] };
    }
  }

  /** Writes to a temp file and renames it, so a crash or a concurrent reader never sees a half-written file. */
  async save(ctx: RequirementContext): Promise<void> {
    const file = this.fileFor(ctx.name);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(ctx, null, 2), "utf8");
    await rename(tmp, file);
  }

  /** Adds documents, replacing any existing document from the same source. */
  addDocuments(name: string, docs: NewDocument[]): Promise<SourceDocument[]> {
    return this.exclusive(name, async () => {
      const ctx = await this.load(name);
      const now = new Date().toISOString();
      // The same source can appear twice in one batch (e.g. a Jira key that the JQL also returns); keep the last.
      const bySource = new Map(docs.map((d) => [d.source, { ...d, id: documentId(d.source), addedAt: now }]));
      const added = [...bySource.values()];
      ctx.documents = [...ctx.documents.filter((d) => !bySource.has(d.source)), ...added];
      ctx.updatedAt = now;
      await this.save(ctx);
      return added;
    });
  }

  async getDocument(name: string, id: string): Promise<SourceDocument | undefined> {
    return (await this.load(name)).documents.find((d) => d.id === id);
  }

  /**
   * Atomically creates or replaces the document from `source`. The updater sees
   * the current document (if any), so callers can carry over metadata such as
   * an artifact's version or where it was published.
   */
  upsertDocument(name: string, source: string, update: (existing: SourceDocument | undefined) => NewDocument): Promise<SourceDocument> {
    return this.exclusive(name, async () => {
      const ctx = await this.load(name);
      const existing = ctx.documents.find((d) => d.source === source);
      const next = update(existing);
      if (next.source !== source) throw new Error("upsertDocument cannot change a document's source.");
      const now = new Date().toISOString();
      const doc = { ...next, id: documentId(source), addedAt: existing?.addedAt ?? now };
      ctx.documents = existing ? ctx.documents.map((d) => (d === existing ? doc : d)) : [...ctx.documents, doc];
      ctx.updatedAt = now;
      await this.save(ctx);
      return doc;
    });
  }

  removeDocument(name: string, id: string): Promise<boolean> {
    return this.exclusive(name, async () => {
      const ctx = await this.load(name);
      const before = ctx.documents.length;
      ctx.documents = ctx.documents.filter((d) => d.id !== id);
      if (ctx.documents.length === before) return false;
      ctx.updatedAt = new Date().toISOString();
      await this.save(ctx);
      return true;
    });
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(path.join(this.workspaceDir, "contexts"));
      return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }

  delete(name: string): Promise<void> {
    return this.exclusive(name, () => rm(this.fileFor(name), { force: true }));
  }
}

/** Ids depend only on the source, so re-adding a source (even as a different kind) keeps its id. */
export function documentId(source: string): string {
  return `doc-${createHash("sha1").update(source).digest("hex").slice(0, 10)}`;
}
