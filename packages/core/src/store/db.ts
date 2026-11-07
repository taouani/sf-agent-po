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
const BUSY_TIMEOUT_MS = 5000;

export class Database {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(readonly file: string, migrations: readonly Migration[] = MIGRATIONS) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
    try {
      // The busy timeout must be set before anything that needs a lock, or a
      // second process fails at once with "database is locked".
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      if (file !== ":memory:") this.enableWal();
      this.db.exec("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
      migrate(this, migrations);
    } catch (err) {
      // Release the file: on Windows an open handle keeps it locked.
      this.db.close();
      throw err;
    }
  }

  /**
   * Switching a new file to WAL needs an exclusive lock, and SQLite answers
   * SQLITE_BUSY at once instead of waiting, even with a busy timeout. When
   * several hosts open a new workspace together, retry until the timeout.
   * WAL is persistent, so once one process has switched, the others skip it.
   */
  private enableWal(): void {
    const deadline = Date.now() + BUSY_TIMEOUT_MS;
    for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
      try {
        const { journal_mode } = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
        if (journal_mode === "wal") return;
        this.db.exec("PRAGMA journal_mode = WAL");
        return;
      } catch (err) {
        if (!isBusy(err) || Date.now() >= deadline) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      }
    }
  }

  /**
   * Runs `fn` in a write transaction. The outermost call uses BEGIN IMMEDIATE,
   * which takes the write lock up front, so two processes doing
   * read-modify-write never interleave. A nested call runs in a savepoint: if
   * it throws, only its own changes are undone, even when the outer callback
   * catches the error. `fn` must be synchronous.
   */
  write<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T {
    const nested = this.depth > 0;
    if (!nested && this.db.isTransaction) {
      throw new Error("Database.write() cannot join a transaction it did not open.");
    }
    const savepoint = `sp_${this.depth}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      if (result !== null && typeof (result as { then?: unknown } | undefined)?.then === "function") {
        throw new Error("Database.write() needs a synchronous callback: the transaction would commit before the awaited work.");
      }
      this.db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return result as T;
    } catch (err) {
      // SQLite may already have rolled back (disk full, I/O error); do not hide the original error.
      if (this.db.isTransaction) this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      throw err;
    } finally {
      this.depth--;
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

function isBusy(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string } | undefined;
  // SQLITE_BUSY = 5 (extended codes keep it in the low byte).
  return (typeof e?.errcode === "number" && (e.errcode & 0xff) === 5) || /database is locked/i.test(e?.message ?? "");
}

export function schemaVersion(database: Database): number {
  const row = database.db.prepare("SELECT max(version) AS v FROM schema_migration").get() as { v: number | null };
  return row.v ?? 0;
}
