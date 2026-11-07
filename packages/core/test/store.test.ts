import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContextRepository, Database, MIGRATIONS, documentId, schemaVersion } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "sf-agent-core-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const freshDb = () => new Database(join(dir, `ws-${++n}`, "sf-agent.db"));

describe("Database", () => {
  it("applies migrations once and records the schema version", () => {
    const file = join(dir, "migrate", "sf-agent.db");
    const a = new Database(file);
    expect(schemaVersion(a)).toBe(MIGRATIONS.length);
    a.close();
    const b = new Database(file); // re-opening applies nothing new
    expect(b.db.prepare("SELECT count(*) AS n FROM schema_migration").get()).toEqual({ n: MIGRATIONS.length });
    expect(b.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    b.close();
  });

  it("refuses a database written by a newer version", () => {
    const file = join(dir, "newer", "sf-agent.db");
    const a = new Database(file);
    a.db.prepare("INSERT INTO schema_migration (version, name, applied_at) VALUES (999, 'future', 'now')").run();
    a.close();
    expect(() => new Database(file)).toThrow(/newer version of sf-agent-po/);
  });

  it("rolls back a failed write transaction", () => {
    const db = freshDb();
    const repo = new ContextRepository(db);
    repo.ensure("rollback");
    expect(() =>
      db.write(() => {
        repo.addDocuments("rollback", [{ kind: "other", title: "a", source: "a.md", content: "x" }]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(repo.documents("rollback")).toHaveLength(0);
    db.close();
  });

  it("undoes only a nested write that fails, even when the outer write catches the error", () => {
    const db = freshDb();
    const repo = new ContextRepository(db);
    db.write(() => {
      repo.addDocuments("nested", [{ kind: "other", title: "kept", source: "kept.md", content: "x" }]);
      try {
        db.write(() => {
          repo.addDocuments("nested", [{ kind: "other", title: "lost", source: "lost.md", content: "x" }]);
          throw new Error("inner");
        });
      } catch {
        // the outer write carries on
      }
    });
    expect(repo.documents("nested").map((d) => d.source)).toEqual(["kept.md"]);
    expect(db.db.isTransaction).toBe(false);
    db.close();
  });

  it("rejects an async callback and rolls back", () => {
    const db = freshDb();
    const repo = new ContextRepository(db);
    const asyncWrite = (async () => {
      repo.addDocuments("async", [{ kind: "other", title: "a", source: "a.md", content: "x" }]);
    }) as unknown as () => void;
    expect(() => db.write(asyncWrite)).toThrow(/synchronous callback/);
    expect(repo.documents("async")).toHaveLength(0);
    db.close();
  });

  it("refuses to join a transaction it did not open", () => {
    const db = freshDb();
    db.db.exec("BEGIN");
    expect(() => db.write(() => 1)).toThrow(/cannot join/);
    db.db.exec("ROLLBACK");
    db.close();
  });
});

describe("ContextRepository", () => {
  it("adds documents, replacing by source, last one wins within a batch", () => {
    const db = freshDb();
    const repo = new ContextRepository(db);
    repo.addDocuments("renewal", [
      { kind: "meeting-notes", title: "Kick-off", source: "notes/kickoff.md", content: "v1" },
      { kind: "jira", title: "PROJ-1", source: "PROJ-1", content: "story" },
      { kind: "meeting-notes", title: "Kick-off", source: "notes/kickoff.md", content: "v2" },
    ]);
    repo.addDocuments("renewal", [{ kind: "meeting-notes", title: "Kick-off again", source: "notes/kickoff.md", content: "v3", metadata: { a: 1 } }]);
    const docs = repo.documents("renewal");
    expect(docs).toHaveLength(2);
    const kickoff = repo.getDocument("renewal", documentId("notes/kickoff.md"))!;
    expect(kickoff).toMatchObject({ title: "Kick-off again", content: "v3", metadata: { a: 1 }, masked: false });
    expect(repo.get("renewal")?.documentCount).toBe(2);
    db.close();
  });

  it("keeps the 0.x document id rule so imported ids stay stable", () => {
    expect(documentId("PROJ-1")).toMatch(/^doc-[0-9a-f]{10}$/);
    expect(documentId("PROJ-1")).toBe(documentId("PROJ-1"));
  });

  it("upserts with access to the current document", () => {
    const db = freshDb();
    const repo = new ContextRepository(db);
    const save = (content: string) =>
      repo.upsertDocument("c", "artifact:design:hld", (prev) => ({
        kind: "design",
        title: "HLD",
        source: "artifact:design:hld",
        content,
        metadata: { version: ((prev?.metadata.version as number) ?? 0) + 1 },
      }));
    save("one");
    const second = save("two");
    expect(second.metadata.version).toBe(2);
    expect(() => repo.upsertDocument("c", "x", () => ({ kind: "other", title: "t", source: "y", content: "" }))).toThrow(/cannot change/);
    db.close();
  });

  it("removes documents, deletes contexts with their documents, and stores settings", () => {
    const db = freshDb();
    const repo = new ContextRepository(db);
    const [doc] = repo.addDocuments("c", [{ kind: "email", title: "Mail", source: "mail.eml", content: "hi" }]);
    expect(repo.removeDocument("c", doc!.id)).toBe(true);
    expect(repo.removeDocument("c", doc!.id)).toBe(false);
    expect(repo.updateSettings("c", { outputLanguage: "fr" })).toEqual({ outputLanguage: "fr" });
    expect(repo.get("c")?.settings).toEqual({ outputLanguage: "fr" });
    repo.addDocuments("c", [{ kind: "email", title: "Mail", source: "mail.eml", content: "hi" }]);
    expect(repo.delete("c")).toBe(true);
    expect(db.db.prepare("SELECT count(*) AS n FROM document").get()).toEqual({ n: 0 });
    db.close();
  });

  it("never overwrites a document from another source that has the same id", () => {
    const db = freshDb();
    const repo = new ContextRepository(db);
    repo.ensure("c");
    // Simulate a hash collision: a row whose id belongs to "b.md" but whose source is "a.md".
    db.db
      .prepare("INSERT INTO document (context, id, kind, title, source, content, metadata, added_at, updated_at) VALUES ('c', ?, 'other', 'A', 'a.md', 'a', '{}', 'now', 'now')")
      .run(documentId("b.md"));
    expect(() => repo.addDocuments("c", [{ kind: "other", title: "B", source: "b.md", content: "b" }])).toThrow(/already used by another source/);
    expect(repo.documents("c").map((d) => d.source)).toEqual(["a.md"]);
    db.close();
  });

  it("rejects unsafe context names", () => {
    const db = freshDb();
    expect(() => new ContextRepository(db).ensure("../etc")).toThrow(/Invalid context name/);
    db.close();
  });
});

describe("several processes writing at once", () => {
  // The 0.x JSON store lost writes when two hosts saved the same context. Here
  // four processes each add 40 documents to one context at the same moment.
  const build = join(dir, "build");
  beforeAll(() => {
    const require = createRequire(import.meta.url);
    const tsc = join(require.resolve("typescript/package.json"), "..", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", join(import.meta.dirname, "..", "tsconfig.json"), "--outDir", build, "--declaration", "false", "--sourceMap", "false"]);
    writeFileSync(join(build, "package.json"), '{"type":"module"}');
  }, 60_000);

  it("loses no writes", async () => {
    const file = join(dir, "multi", "sf-agent.db");
    new Database(file).close();
    const writer = join(build, "writer.mjs");
    writeFileSync(
      writer,
      `import { ContextRepository, Database } from "./index.js";
       const [file, id, startAt] = process.argv.slice(2);
       const db = new Database(file);
       const repo = new ContextRepository(db);
       const wait = Number(startAt) - Date.now();
       if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
       for (let i = 0; i < 40; i++) repo.addDocuments("shared", [{ kind: "other", title: "t", source: id + "-" + i, content: "x" }]);
       db.close();`,
    );
    const startAt = Date.now() + 1500;
    await Promise.all([0, 1, 2, 3].map((i) => promisify(execFile)(process.execPath, [writer, file, `w${i}`, String(startAt)])));
    const db = new Database(file);
    expect(new ContextRepository(db).documents("shared")).toHaveLength(160);
    db.close();
  }, 60_000);

  it("opens a new database file from several processes at once", async () => {
    // Switching a new file to WAL needs an exclusive lock that SQLite does not wait for.
    const file = join(dir, "first-open", "sf-agent.db");
    const opener = join(build, "opener.mjs");
    writeFileSync(
      opener,
      `import { ContextRepository, Database } from "./index.js";
       const [file, id, startAt] = process.argv.slice(2);
       const wait = Number(startAt) - Date.now();
       if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
       const db = new Database(file);
       new ContextRepository(db).addDocuments("shared", [{ kind: "other", title: "t", source: id, content: "x" }]);
       db.close();`,
    );
    const startAt = Date.now() + 1500;
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => promisify(execFile)(process.execPath, [opener, file, `o${i}`, String(startAt)])));
    const db = new Database(file);
    expect(new ContextRepository(db).documents("shared")).toHaveLength(6);
    expect(db.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
  }, 60_000);
});
