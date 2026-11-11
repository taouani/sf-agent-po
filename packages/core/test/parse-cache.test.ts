import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database, FULL_RUN_AFTER_MS, MetadataIndex, readerVersion, scanProject, type ParsedMetadata } from "../src/index.js";

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

  it("runs in full when asked, after 7 days, or when the readers changed", async () => {
    const { db, run } = setup();
    await run();
    expect((await run({ full: true })).stats).toMatchObject({ full: true, files: { reused: 0 } });
    expect((await run()).stats.full).toBe(false);

    db.db.prepare("UPDATE metadata_snapshot SET finished_at = ?").run(new Date(Date.now() - FULL_RUN_AFTER_MS - 60_000).toISOString());
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

  it("has a stable readers' version, from the readers' code", () => {
    expect(readerVersion()).toMatch(/^[0-9a-f]{16}$/);
    expect(readerVersion()).toBe(readerVersion());
  });
});
