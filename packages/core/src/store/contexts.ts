import { createHash } from "node:crypto";
import type { Database } from "./db.js";

export const DOCUMENT_KINDS = [
  "meeting-notes",
  "email",
  "pi-planning",
  "jira",
  "confluence",
  "metadata",
  "org",
  "design",
  "backlog",
  "other",
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface SourceDocument {
  id: string;
  kind: DocumentKind;
  title: string;
  /** Where the document came from: a file path, URL, issue key, org alias, etc. */
  source: string;
  content: string;
  metadata: Record<string, unknown>;
  masked: boolean;
  addedAt: string;
  updatedAt: string;
}

export type NewDocument = Pick<SourceDocument, "kind" | "title" | "source" | "content"> & {
  metadata?: Record<string, unknown>;
  masked?: boolean;
};

/** A whole context as the importer hands it over, with its original dates. */
export interface ImportedContext {
  name: string;
  createdAt: string;
  updatedAt: string;
  settings?: Record<string, unknown>;
  documents: (NewDocument & { addedAt: string })[];
}

export interface ContextInfo {
  name: string;
  createdAt: string;
  updatedAt: string;
  settings: Record<string, unknown>;
  documentCount: number;
}

interface DocumentRow {
  id: string;
  kind: string;
  title: string;
  source: string;
  content: string;
  metadata: string;
  masked: number;
  added_at: string;
  updated_at: string;
}

const toDocument = (r: DocumentRow): SourceDocument => ({
  id: r.id,
  kind: r.kind as DocumentKind,
  title: r.title,
  source: r.source,
  content: r.content,
  metadata: JSON.parse(r.metadata) as Record<string, unknown>,
  masked: r.masked === 1,
  addedAt: r.added_at,
  updatedAt: r.updated_at,
});

/** Ids depend only on the source, so re-adding a source keeps its id (same rule as the 0.x JSON store). */
export function documentId(source: string): string {
  return `doc-${createHash("sha1").update(source).digest("hex").slice(0, 10)}`;
}

export function validateContextName(name: string): string {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`Invalid context name "${name}": use letters, digits, '.', '-' or '_'.`);
  return name;
}

/**
 * Requirement contexts and their documents. Every change runs in one write
 * transaction, so parallel tool calls and several host processes cannot lose
 * each other's writes (a known problem of the 0.x JSON files).
 */
export class ContextRepository {
  constructor(private readonly database: Database) {}

  private get db() {
    return this.database.db;
  }

  list(): ContextInfo[] {
    const rows = this.db
      .prepare(
        `SELECT c.name, c.created_at, c.updated_at, c.settings, count(d.id) AS n
         FROM context c LEFT JOIN document d ON d.context = c.name GROUP BY c.name ORDER BY c.name`,
      )
      .all() as { name: string; created_at: string; updated_at: string; settings: string; n: number }[];
    return rows.map((r) => ({
      name: r.name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      settings: JSON.parse(r.settings) as Record<string, unknown>,
      documentCount: r.n,
    }));
  }

  get(name: string): ContextInfo | undefined {
    return this.list().find((c) => c.name === name);
  }

  /** Creates the context if it does not exist yet. */
  ensure(name: string, at = new Date().toISOString()): void {
    validateContextName(name);
    this.db.prepare("INSERT OR IGNORE INTO context (name, created_at, updated_at) VALUES (?, ?, ?)").run(name, at, at);
  }

  updateSettings(name: string, patch: Record<string, unknown>): Record<string, unknown> {
    return this.database.write(() => {
      this.ensure(name);
      const row = this.db.prepare("SELECT settings FROM context WHERE name = ?").get(name) as { settings: string };
      const settings = { ...(JSON.parse(row.settings) as Record<string, unknown>), ...patch };
      this.db.prepare("UPDATE context SET settings = ?, updated_at = ? WHERE name = ?").run(JSON.stringify(settings), new Date().toISOString(), name);
      return settings;
    });
  }

  documents(name: string): SourceDocument[] {
    const rows = this.db.prepare("SELECT * FROM document WHERE context = ? ORDER BY seq, id").all(name) as unknown as DocumentRow[];
    return rows.map(toDocument);
  }

  getDocument(name: string, id: string): SourceDocument | undefined {
    const row = this.db.prepare("SELECT * FROM document WHERE context = ? AND id = ?").get(name, id) as DocumentRow | undefined;
    return row && toDocument(row);
  }

  /** Adds documents, replacing any existing document from the same source (the last one wins within a batch). */
  addDocuments(name: string, docs: NewDocument[]): SourceDocument[] {
    return this.database.write(() => {
      const now = new Date().toISOString();
      this.ensure(name, now);
      const bySource = new Map(docs.map((d) => [d.source, d]));
      for (const d of bySource.values()) this.put(name, d, now);
      this.touch(name, now);
      return [...bySource.keys()].map((source) => this.getDocument(name, documentId(source))!);
    });
  }

  /**
   * Creates or replaces the document from `source`. The updater sees the
   * current document, so callers can carry over metadata such as an artifact's
   * version or where it was published.
   */
  upsertDocument(name: string, source: string, update: (existing: SourceDocument | undefined) => NewDocument): SourceDocument {
    return this.database.write(() => {
      const now = new Date().toISOString();
      this.ensure(name, now);
      const next = update(this.getDocument(name, documentId(source)));
      if (next.source !== source) throw new Error("upsertDocument cannot change a document's source.");
      this.put(name, next, now);
      this.touch(name, now);
      return this.getDocument(name, documentId(source))!;
    });
  }

  removeDocument(name: string, id: string): boolean {
    return this.database.write(() => {
      const { changes } = this.db.prepare("DELETE FROM document WHERE context = ? AND id = ?").run(name, id);
      if (changes > 0) this.touch(name, new Date().toISOString());
      return changes > 0;
    });
  }

  /**
   * Imports a whole context with its own dates, in one transaction, for the
   * 0.x JSON importer. Documents keep their id, which depends only on the
   * source. An existing context is left alone unless `replace` is set, in
   * which case it is deleted first. Returns false when it was left alone.
   */
  importContext(ctx: ImportedContext, { replace = false } = {}): boolean {
    validateContextName(ctx.name);
    return this.database.write(() => {
      if (this.get(ctx.name)) {
        if (!replace) return false;
        this.db.prepare("DELETE FROM context WHERE name = ?").run(ctx.name);
      }
      this.db
        .prepare("INSERT INTO context (name, created_at, updated_at, settings) VALUES (?, ?, ?, ?)")
        .run(ctx.name, ctx.createdAt, ctx.updatedAt, JSON.stringify(ctx.settings ?? {}));
      for (const d of ctx.documents) this.put(ctx.name, d, d.addedAt, d.addedAt);
      return true;
    });
  }

  delete(name: string): boolean {
    return this.database.write(() => this.db.prepare("DELETE FROM context WHERE name = ?").run(name).changes > 0);
  }

  /**
   * Inserts or replaces a document. A new document goes to the end of the
   * context (`seq`). Replacing keeps the original `added_at` and position
   * (0.x moved a re-added document to the end and reset its date; no caller
   * relied on that).
   */
  private put(name: string, d: NewDocument, now: string, addedAt?: string): void {
    const id = documentId(d.source);
    const { changes } = this.db
      .prepare(
        `INSERT INTO document (context, id, kind, title, source, content, metadata, masked, added_at, updated_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM document WHERE context = ?))
         ON CONFLICT (context, id) DO UPDATE SET
           kind = excluded.kind, title = excluded.title, content = excluded.content,
           metadata = excluded.metadata, masked = excluded.masked, updated_at = excluded.updated_at
         WHERE document.source = excluded.source`,
      )
      .run(name, id, d.kind, d.title, d.source, d.content, JSON.stringify(d.metadata ?? {}), d.masked ? 1 : 0, addedAt ?? now, now, name);
    if (changes === 0) {
      // Two different sources hashed to the same id: never let one overwrite the other.
      throw new Error(`Document id ${id} is already used by another source in context "${name}".`);
    }
  }

  private touch(name: string, at: string): void {
    this.db.prepare("UPDATE context SET updated_at = ? WHERE name = ?").run(at, name);
  }
}
