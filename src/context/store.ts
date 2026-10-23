import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  constructor(private readonly workspaceDir: string) {}

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

  async save(ctx: RequirementContext): Promise<void> {
    const file = this.fileFor(ctx.name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(ctx, null, 2), "utf8");
  }

  /** Adds documents, replacing any existing document from the same source. */
  async addDocuments(name: string, docs: NewDocument[]): Promise<SourceDocument[]> {
    const ctx = await this.load(name);
    const now = new Date().toISOString();
    const added = docs.map((d) => ({ ...d, id: documentId(d.source), addedAt: now }));
    const sources = new Set(added.map((d) => d.source));
    ctx.documents = [...ctx.documents.filter((d) => !sources.has(d.source)), ...added];
    ctx.updatedAt = now;
    await this.save(ctx);
    return added;
  }

  async removeDocument(name: string, id: string): Promise<boolean> {
    const ctx = await this.load(name);
    const before = ctx.documents.length;
    ctx.documents = ctx.documents.filter((d) => d.id !== id);
    if (ctx.documents.length === before) return false;
    ctx.updatedAt = new Date().toISOString();
    await this.save(ctx);
    return true;
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(path.join(this.workspaceDir, "contexts"));
      return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }

  async delete(name: string): Promise<void> {
    await rm(this.fileFor(name), { force: true });
  }
}

/** Ids depend only on the source, so re-adding a source (even as a different kind) keeps its id. */
export function documentId(source: string): string {
  return `doc-${createHash("sha1").update(source).digest("hex").slice(0, 10)}`;
}
