// How the 0.x server (removed in phase 5; tag v0-final) wrote a requirement context: one JSON
// file per context under <workspace>/contexts, pretty-printed, documents in the order added, a
// new batch replacing the documents from the same sources. Kept so the importer is tested
// against files exactly as 0.x wrote them.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { documentId } from "../../src/index.js";

export interface LegacyDocument {
  id: string;
  kind: string;
  title: string;
  source: string;
  content: string;
  metadata?: Record<string, unknown>;
  addedAt: string;
}

export interface LegacyContext {
  name: string;
  createdAt: string;
  updatedAt: string;
  documents: LegacyDocument[];
}

export class LegacyStore {
  constructor(private readonly workspaceDir: string) {}

  private fileFor(name: string): string {
    return path.join(this.workspaceDir, "contexts", `${name}.json`);
  }

  async load(name: string): Promise<LegacyContext> {
    try {
      return JSON.parse(await readFile(this.fileFor(name), "utf8")) as LegacyContext;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const now = new Date().toISOString();
      return { name, createdAt: now, updatedAt: now, documents: [] };
    }
  }

  async addDocuments(name: string, docs: Omit<LegacyDocument, "id" | "addedAt">[]): Promise<void> {
    const ctx = await this.load(name);
    const now = new Date().toISOString();
    const bySource = new Map(docs.map((d) => [d.source, { ...d, id: documentId(d.source), addedAt: now }]));
    ctx.documents = [...ctx.documents.filter((d) => !bySource.has(d.source)), ...bySource.values()];
    ctx.updatedAt = now;
    await mkdir(path.dirname(this.fileFor(name)), { recursive: true });
    await writeFile(this.fileFor(name), JSON.stringify(ctx, null, 2), "utf8");
  }
}
