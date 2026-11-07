// Thin wrapper so the spike runs the same code on node:sqlite and better-sqlite3.
import { createRequire } from 'node:module';

export type DriverName = 'node:sqlite' | 'better-sqlite3';

export interface Stmt {
  run(...args: unknown[]): unknown;
  all(...args: unknown[]): any[];
  get(...args: unknown[]): any;
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  tx<T>(fn: () => T): T;
  close(): void;
}

const require = createRequire(import.meta.url);

export function open(driver: DriverName, file: string): Db {
  if (driver === 'better-sqlite3') {
    const Database = require('better-sqlite3');
    const db = new Database(file);
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => db.prepare(sql),
      tx: (fn) => db.transaction(fn)(),
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    tx: (fn) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => db.close(),
  };
}

export function configure(db: Db): void {
  // busy_timeout must come first: node:sqlite has no default timeout, so setting WAL can fail at once
  // with "database is locked" while another process writes. better-sqlite3 defaults to 5 s.
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
}
