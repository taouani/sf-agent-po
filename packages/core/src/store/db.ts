import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, type Migration } from "./migrations.js";

/**
 * One SQLite database per workspace (DE2). Several host processes (Copilot,
 * Cursor, Claude Code) and the background indexer may open it at once, so it
 * runs in WAL mode with a busy timeout and every write goes through an
 * immediate transaction.
 */
export class Database {
  readonly db: DatabaseSync;

  constructor(readonly file: string, migrations: readonly Migration[] = MIGRATIONS) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: 5000 });
    // The busy timeout must be set before anything that needs a lock (such as
    // switching to WAL), or a second process fails at once with "database is locked".
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (file !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    migrate(this, migrations);
  }

  /**
   * Runs `fn` in a write transaction. BEGIN IMMEDIATE takes the write lock up
   * front, so two processes doing read-modify-write never interleave.
   * Nested calls join the outer transaction.
   */
  write<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Applies pending migrations in order, each in its own transaction. */
export function migrate(database: Database, migrations: readonly Migration[]): void {
  const { db } = database;
  db.exec("CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set((db.prepare("SELECT version FROM schema_migration").all() as { version: number }[]).map((r) => r.version));
  const latest = Math.max(0, ...migrations.map((m) => m.version));
  const newest = Math.max(0, ...applied);
  if (newest > latest) {
    throw new Error(
      `The workspace database ${database.file} was written by a newer version of sf-agent-po (schema ${newest}, this version knows ${latest}). Update sf-agent-po.`,
    );
  }
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    database.write(() => {
      // Another process may have applied it while we waited for the lock.
      if (db.prepare("SELECT 1 FROM schema_migration WHERE version = ?").get(m.version)) return;
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, new Date().toISOString());
    });
  }
}

export function schemaVersion(database: Database): number {
  const row = database.db.prepare("SELECT max(version) AS v FROM schema_migration").get() as { v: number | null };
  return row.v ?? 0;
}
