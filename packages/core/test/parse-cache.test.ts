import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database, FULL_RUN_AFTER_MS, MetadataIndex, readerVersion, readerVersionComplete, scanProject, type ParsedMetadata } from "../src/index.js";

const fixtures = join(import.meta.dirname, "fixtures", "metadata", "source");
const FIELD = "force-app/main/default/objects/Policy__c/fields/Premium__c.field-meta.xml";
const CLASS = "force-app/main/default/classes/RenewalService.cls";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sfpo-cache-"));
  cpSync(fixtures, dir, { recursive: true });
  const db = new Database(":memory:");
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const index = new MetadataIndex(db);
  let last: ParsedMetadata | undefined;
  const run = (options: { full?: boolean } = {}) =>
    index.build({ source: "repo:test", kind: "repo" }, async (_lease, cache) => (last = await scanProject(dir, { cache })), options);
  return { dir, db, index, run, parsed: () => last! };
}

const rows = (db: Database) => db.db.prepare("SELECT file, hash FROM metadata_file WHERE source = 'repo:test' ORDER BY file").all() as { file: string; hash: string }[];

describe("parse cache", () => {
  it("parses only the files that changed, and gives the same index", async () => {
    const { dir, db, run, parsed } = setup();
    const first = await run();
    expect(first.stats).toMatchObject({ full: true, files: { reused: 0 } });
    const all = first.stats.files!.read;
    expect(all).toBeGreaterThan(10);
    expect(rows(db)).toHaveLength(all);
    const fresh = parsed();

    const second = await run();
    expect(second.stats).toMatchObject({ full: false, files: { read: 0, reused: all } });
    expect(parsed().components).toEqual(fresh.components);
    // The code of a class comes back from the cache too.
    expect(parsed().components.find((c) => c.file === CLASS)?.body).toContain("class RenewalService");
    expect(parsed().edges).toEqual(fresh.edges);
    expect(second.stats.counts).toEqual(first.stats.counts);

    // One changed file is read again; the others still come from the cache.
    writeFileSync(join(dir, FIELD), readFileSync(join(dir, FIELD), "utf8").replace("<label>", "<label>New "));
    const third = await run();
    expect(third.stats.files).toEqual({ read: 1, reused: all - 1 });
    expect(parsed().components.find((c) => c.name === "Policy__c.Premium__c")?.label).toMatch(/^New /);

    // A deleted file's components and cache row go.
    unlinkSync(join(dir, CLASS));
    unlinkSync(join(dir, `${CLASS}-meta.xml`));
    const fourth = await run();
    expect(fourth.stats.files).toEqual({ read: 0, reused: all - 1 });
    expect(parsed().components.some((c) => c.type === "ApexClass" && c.name === "RenewalService" && !c.missing)).toBe(false);
    expect(rows(db).map((r) => r.file)).not.toContain(CLASS);
  });

  it("parses again when asked, a file last parsed more than 7 days ago, and everything when the readers changed", async () => {
    const { db, run } = setup();
    const all = (await run()).stats.files!.read;
    expect((await run({ full: true })).stats).toMatchObject({ full: true, files: { reused: 0 } });
    expect((await run()).stats.full).toBe(false);

    // Daily runs still parse each file at least weekly: a row older than that is not reused.
    const old = new Date(Date.now() - FULL_RUN_AFTER_MS - 60_000).toISOString();
    db.db.prepare("UPDATE metadata_file SET parsed_at = ? WHERE file = ?").run(old, FIELD);
    expect((await run()).stats.files).toEqual({ read: 1, reused: all - 1 });
    expect((await run()).stats.files).toEqual({ read: 0, reused: all });
    db.db.prepare("UPDATE metadata_file SET parsed_at = ?").run(old);
    expect((await run()).stats.full).toBe(true);

    db.db.prepare("UPDATE metadata_file SET reader = 'older readers'").run();
    expect((await run()).stats.full).toBe(true);
    expect(new Set((db.db.prepare("SELECT reader FROM metadata_file").all() as { reader: string }[]).map((r) => r.reader))).toEqual(new Set([readerVersion()]));
  });

  it("keeps the last run's cache when a run fails", async () => {
    const { db, index, run } = setup();
    await run();
    const before = rows(db);
    await expect(
      index.build({ source: "repo:test", kind: "repo" }, async (_lease, cache) => {
        cache.put("new-file.xml", "h", []);
        throw new Error("the folder went away");
      }),
    ).rejects.toThrow(/went away/);
    expect(rows(db)).toEqual(before);
  });

  it("writes only what a run parsed, and drops the rows of sources no longer indexed", async () => {
    const { db, run } = setup();
    await run();
    const stamp = new Date(Date.now() - 1000).toISOString();
    db.db.prepare("UPDATE metadata_file SET parsed_at = ?").run(stamp);
    db.db.prepare("INSERT INTO metadata_file (source, file, hash, reader, parsed_at, components) VALUES ('repo:gone', 'a.xml', 'h', 'r', ?, '[]')").run(stamp);
    await run();
    // Reused rows keep the time they were parsed.
    expect((db.db.prepare("SELECT DISTINCT parsed_at AS t FROM metadata_file").all() as { t: string }[]).map((r) => r.t)).toEqual([stamp]);
    expect(db.db.prepare("SELECT 1 FROM metadata_file WHERE source = 'repo:gone'").get()).toBeUndefined();
  });

  it("gives what a fresh parse gives, in both formats", async () => {
    for (const format of ["source", "mdapi"]) {
      const dir = join(import.meta.dirname, "fixtures", "metadata", format);
      const fresh = await scanProject(dir);
      const rows = new Map<string, { hash: string; json: string }>();
      const cache = {
        get: (file: string, hash: string) => (rows.get(file)?.hash === hash ? JSON.parse(rows.get(file)!.json) : undefined),
        put: (file: string, hash: string, components: unknown) => void rows.set(file, { hash, json: JSON.stringify(components) }),
      };
      const first = await scanProject(dir, { cache });
      const second = await scanProject(dir, { cache });
      expect(second.files?.reused, format).toBe(first.files?.read);
      for (const r of [first, second]) {
        const { files: _files, ...rest } = r;
        expect(rest, format).toStrictEqual(fresh);
      }
    }
  });

  it("has a stable readers' version, from the readers' code and the XML parser's version", () => {
    expect(readerVersion()).toMatch(/^[0-9a-f]{16}$/);
    expect(readerVersion()).toBe(readerVersion());
    expect(readerVersionComplete()).toBe(true);
  });
});
