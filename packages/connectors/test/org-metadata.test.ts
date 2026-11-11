import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database, MetadataIndex } from "@sf-agent-po/core";
import { BackgroundIndexer, indexOrg, indexProject, projectSource, summarizeWarnings } from "../src/indexing.js";
import { mergeAccess, readManifest, retrieveOrgMetadata, splitManifest, writeManifest } from "../src/org-metadata.js";
import type { SfRunner } from "../src/salesforce.js";

const ORG_ID = "00D000000000001AAA";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The folder an org's pointer file names as its last complete retrieval. */
const current = (dir: string) => (JSON.parse(readFileSync(path.join(dir, `${ORG_ID}.json`), "utf8")) as { folder: string }).folder;

const manifest = (types: Record<string, string[]>) =>
  `<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata">${Object.entries(types)
    .map(([name, members]) => `<types>${members.map((m) => `<members>${m}</members>`).join("")}<name>${name}</name></types>`)
    .join("")}<version>62.0</version></Package>`;

/** A fake sf CLI: lists `org`, and writes each retrieve's members as metadata-format files. */
function fakeSf(
  org: Record<string, string[]>,
  calls: { args: string[]; cwd?: string }[] = [],
  behaviour: { messages?: { problem: string }[]; limit?: number; empty?: boolean; junk?: boolean; dates?: Record<string, string>; asked?: { type: string; members: string[] }[][];
    /** What each permission set grants, whatever was retrieved with it (as since API 40). */
    permissionSets?: Record<string, string[]>;
    /** Members the org lists but does not return, as `type:member`. */
    skip?: Set<string>;
  } = {},
): SfRunner {
  return async (args, opts = {}) => {
    calls.push({ args, cwd: opts.cwd });
    if (args[0] === "org" && args[1] === "list" && args[2] === "metadata") {
      if (!behaviour.dates) throw new Error("sf org list failed: not in this fake");
      const type = args[args.indexOf("--metadata-type") + 1]!;
      return (org[type] ?? []).map((m) => ({ fullName: m, type, lastModifiedDate: behaviour.dates![`${type}:${m}`] ?? "2026-11-01T00:00:00.000Z" }));
    }
    if (args[0] === "org" && args[1] === "display") return { id: ORG_ID, alias: "dev", accessToken: "SECRET" };
    // Like the real CLI, which refuses both commands outside a Salesforce project.
    if (args[0] === "project" && !existsSync(path.join(opts.cwd!, "sfdx-project.json"))) throw new Error("sf project failed: RequiresProjectError");
    if (args[1] === "generate") {
      writeFileSync(path.join(opts.cwd!, "package.xml"), manifest(org));
      return {};
    }
    if (args[1] === "retrieve") {
      const wanted = readManifest(readFileSync(path.join(opts.cwd!, args[args.indexOf("--manifest") + 1]!), "utf8"), Object.keys(org)).entries;
      behaviour.asked?.push(wanted);
      const out = path.join(opts.cwd!, args[args.indexOf("--target-metadata-dir") + 1]!);
      if (behaviour.limit && wanted.reduce((n, e) => n + e.members.length, 0) > behaviour.limit) throw new Error("sf project retrieve failed: LIMIT_EXCEEDED: Too many files");
      if (behaviour.empty) {
        mkdirSync(path.join(out, "unpackaged"), { recursive: true });
        writeFileSync(path.join(out, "unpackaged", "package.xml"), "<Package/>");
        return { status: "Succeeded", messages: behaviour.messages };
      }
      if (behaviour.junk) {
        mkdirSync(path.join(out, "unpackaged"), { recursive: true });
        writeFileSync(path.join(out, "unpackaged", "package.xml"), "<Package/>");
        writeFileSync(path.join(out, "unpackaged", "notes.txt"), "not metadata");
        return { status: "Succeeded" };
      }
      const root = path.join(out, "unpackaged");
      const write = (rel: string, content: string) => {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), content);
      };
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "unpackaged.zip"), "zip");
      const objects = new Map<string, string[]>();
      for (const e of wanted) {
        for (const m of e.members) {
          if (behaviour.skip?.has(`${e.type}:${m}`)) continue;
          if (e.type === "PermissionSet") {
            write(`permissionsets/${m}.permissionset`, `<?xml version="1.0"?><PermissionSet>${(behaviour.permissionSets?.[m] ?? []).map((c) => `<classAccesses><apexClass>${c}</apexClass><enabled>true</enabled></classAccesses>`).join("")}<label>${m}</label></PermissionSet>`);
          }
          if (e.type === "CustomObject") objects.set(m, objects.get(m) ?? []);
          if (e.type === "CustomField") {
            const [o, f] = m.split(".");
            objects.set(o!, [...(objects.get(o!) ?? []), `<fields><fullName>${f}</fullName><type>Text</type></fields>`]);
          }
          if (e.type === "ApexClass") {
            write(`classes/${m}.cls`, `public class ${m} { void x() { Account a = [SELECT Id FROM Account]; } }`);
            write(`classes/${m}.cls-meta.xml`, "<ApexClass/>");
          }
          if (e.type === "Profile") {
            const objs = wanted.find((w) => w.type === "CustomObject")?.members ?? [];
            const classes = wanted.find((w) => w.type === "ApexClass")?.members ?? [];
            write(
              `profiles/${m}.profile`,
              `<?xml version="1.0"?><Profile><custom>false</custom>${objs.map((o) => `<objectPermissions><object>${o}</object><allowRead>true</allowRead></objectPermissions>`).join("")}${classes.map((c) => `<classAccesses><apexClass>${c}</apexClass><enabled>true</enabled></classAccesses>`).join("")}<userLicense>Salesforce</userLicense></Profile>`,
            );
          }
        }
      }
      for (const [o, fields] of objects) write(`objects/${o}.object`, `<?xml version="1.0"?><CustomObject>${fields.join("")}</CustomObject>`);
      return { status: "Succeeded", ...(behaviour.messages ? { messages: behaviour.messages } : {}) };
    }
    throw new Error(`unexpected sf ${args.join(" ")}`);
  };
}

const temp: string[] = [];
const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const d of temp.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "sf-agent-org-"));
  temp.push(d);
  return d;
};
const index = () => {
  const db = new Database(":memory:");
  open.push(db);
  return new MetadataIndex(db);
};

describe("org manifests", () => {
  it("keeps the types the index uses, and writes them back", () => {
    const { entries, version } = readManifest(manifest({ ApexClass: ["B", "A"], Document: ["Files/Contract"], EmailTemplate: ["Letters/Hello"], CustomObject: ["Account"] }));
    expect(version).toBe("62.0");
    // Documents are left out; email templates come for their merge fields.
    expect(entries).toEqual([
      { type: "ApexClass", members: ["A", "B"] },
      { type: "EmailTemplate", members: ["Letters/Hello"] },
      { type: "CustomObject", members: ["Account"] },
    ]);
    expect(readManifest(writeManifest(entries, version)).entries).toEqual(entries);
    expect(writeManifest([{ type: "Layout", members: ["Account-A & B"] }])).toContain("<members>Account-A &amp; B</members>");
  });

  it("splits a large org into retrieves, keeping each object with its fields", () => {
    const entries = [
      { type: "ApexClass", members: ["A", "B", "C"] },
      { type: "CustomObject", members: ["Account", "Policy__c"] },
      { type: "CustomField", members: ["Account.Tier__c", "Policy__c.Status__c", "Policy__c.Premium__c"] },
    ];
    const parts = splitManifest(entries, 3);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const objects = part.find((e) => e.type === "CustomObject")?.members ?? [];
      const fieldsOf = (part.find((e) => e.type === "CustomField")?.members ?? []).map((f) => f.split(".")[0]);
      for (const o of fieldsOf) expect(objects).toContain(o);
    }
    expect(parts.flat().flatMap((e) => e.members).sort()).toEqual(entries.flatMap((e) => e.members).sort());
    expect(splitManifest(entries)).toHaveLength(1);
  });
});

describe("retrieveOrgMetadata", () => {
  it("retrieves in metadata format, with relative paths only, and replaces the last retrieval", async () => {
    const dir = tmp();
    const calls: { args: string[]; cwd?: string }[] = [];
    const sf = fakeSf({ ApexClass: ["RenewalService"], CustomObject: ["Policy__c"], CustomField: ["Policy__c.Status__c"], EmailTemplate: ["x/y"] }, calls);
    const first = await retrieveOrgMetadata({ targetOrg: "dev", dir, sf });
    expect(first).toMatchObject({ dir: expect.stringMatching(new RegExp(`^${escape(path.join(dir, ORG_ID))}-\\w+$`)), orgId: ORG_ID, alias: "dev", parts: 1, counts: { ApexClass: 1, CustomObject: 1, CustomField: 1 } });
    expect(JSON.stringify(first)).not.toContain("SECRET");
    const retrieve = calls.find((c) => c.args[1] === "retrieve")!;
    expect(retrieve.args).toEqual(["project", "retrieve", "start", "--manifest", "part-1.xml", "--target-metadata-dir", "part-1", "--unzip", "--wait", "60", "--target-org", "dev"]);
    // Only relative paths reach the CLI: the workspace path can hold the user's name.
    for (const c of calls) for (const a of c.args) expect(path.isAbsolute(a)).toBe(false);
    // Every file is in one tree, at the same path from run to run; the parts and the project
    // file (which would steer the scan to an empty package folder) are gone.
    expect(readdirSync(first.dir)).toEqual(["metadata"]);
    expect(readdirSync(path.join(first.dir, "metadata")).sort()).toEqual(["classes", "email", "objects"].filter((d) => existsSync(path.join(first.dir, "metadata", d))));
    expect(existsSync(path.join(first.dir, "metadata", "classes", "RenewalService.cls"))).toBe(true);
    expect(current(dir)).toBe(path.basename(first.dir));
    // A second retrieval replaces the first, without renaming a folder, and the first goes.
    const second = await retrieveOrgMetadata({ targetOrg: "dev", dir, sf });
    expect(second.dir).not.toBe(first.dir);
    expect(readdirSync(dir).sort()).toEqual([path.basename(second.dir), `${ORG_ID}.json`].sort());
    expect(current(dir)).toBe(path.basename(second.dir));
  });

  it("refuses an org argument the CLI could read as more, and cleans up after a failure", async () => {
    const dir = tmp();
    await expect(retrieveOrgMetadata({ targetOrg: "--target-org", dir, sf: fakeSf({}) })).rejects.toThrow(/not an org alias/);
    await expect(retrieveOrgMetadata({ targetOrg: "dev x", dir, sf: fakeSf({}) })).rejects.toThrow(/not an org alias/);
    const failing: SfRunner = async (args, opts) => {
      if (args[1] === "retrieve") throw new Error("sf project retrieve failed: INVALID_SESSION_ID");
      return fakeSf({ ApexClass: ["A"] })(args, opts);
    };
    await expect(retrieveOrgMetadata({ targetOrg: "dev", dir, sf: failing })).rejects.toThrow("INVALID_SESSION_ID");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("merges a profile retrieved in several parts", async () => {
    const dir = tmp();
    const big = Array.from({ length: 30 }, (_, i) => `Obj${i}__c`);
    const retrieved = await retrieveOrgMetadata({ targetOrg: "dev", dir, sf: fakeSf({ CustomObject: big, Profile: ["Admin"] }), maxFilesPerRetrieve: 20 });
    expect(retrieved.parts).toBe(2);
    const profiles = readdirSync(retrieved.dir, { recursive: true }).filter((f) => String(f).endsWith(".profile"));
    expect(profiles).toHaveLength(1);
    const merged = readFileSync(path.join(retrieved.dir, String(profiles[0])), "utf8");
    expect(merged.match(/<objectPermissions>/g)).toHaveLength(30);
    expect(merged.match(/<userLicense>/g)).toHaveLength(1);
  });
});

describe("retrieveOrgMetadata, from one run to the next", () => {
  const retrieves = (calls: { args: string[]; cwd?: string }[]) => calls.filter((c) => c.args[1] === "retrieve").length;

  it("retrieves only what changed, keeps the rest, merges profiles and removes what was deleted", async () => {
    const dir = tmp();
    const org: Record<string, string[]> = { ApexClass: ["A", "B", "C"], CustomObject: ["Policy__c"], CustomField: ["Policy__c.Status__c"], Profile: ["Admin"] };
    const dates: Record<string, string> = {};
    const calls: { args: string[]; cwd?: string }[] = [];
    const asked: { type: string; members: string[] }[][] = [];
    const sf = fakeSf(org, calls, { dates, asked });
    const first = await retrieveOrgMetadata({ targetOrg: "dev", dir, sf });
    expect(first.incremental).toBeUndefined();
    const tree = (r: { dir: string }) => path.join(r.dir, "metadata");
    const profile = (r: { dir: string }) => readFileSync(path.join(tree(r), "profiles", "Admin.profile"), "utf8");
    expect(profile(first).match(/<classAccesses>/g)).toHaveLength(3);

    // Nothing changed: only the profile is retrieved, and it keeps its access to everything.
    calls.length = 0;
    const second = await retrieveOrgMetadata({ targetOrg: "dev", dir, sf });
    expect(second.incremental).toEqual({ retrieved: 1, deleted: 0 });
    expect(readFileSync(path.join(dir, `${ORG_ID}.json`), "utf8")).toContain('"layout":2');
    expect(readdirSync(path.join(tree(second), "classes")).sort()).toEqual(["A.cls", "A.cls-meta.xml", "B.cls", "B.cls-meta.xml", "C.cls", "C.cls-meta.xml"]);
    expect(profile(second).match(/<classAccesses>/g)).toHaveLength(3);
    expect(profile(second).match(/<objectPermissions>/g)).toHaveLength(1);
    expect(retrieves(calls)).toBe(1);

    // B changed, C was deleted, and the object got a field: those are retrieved or removed.
    dates["ApexClass:B"] = "2026-11-09T10:00:00.000Z";
    org.ApexClass = ["A", "B"];
    org.CustomField = ["Policy__c.Status__c", "Policy__c.Premium__c"];
    asked.length = 0;
    const third = await retrieveOrgMetadata({ targetOrg: "dev", dir, sf });
    expect(third.incremental).toEqual({ retrieved: 1 + 1 + 2 + 1, deleted: 1 });
    // B, the object with all its fields, and the profile; not A.
    expect(asked).toEqual([
      [
        { type: "ApexClass", members: ["B"] },
        { type: "CustomObject", members: ["Policy__c"] },
        { type: "CustomField", members: ["Policy__c.Premium__c", "Policy__c.Status__c"] },
        { type: "Profile", members: ["Admin"] },
      ],
    ]);
    expect(readdirSync(path.join(tree(third), "classes")).sort()).toEqual(["A.cls", "A.cls-meta.xml", "B.cls", "B.cls-meta.xml"]);
    expect(readFileSync(path.join(tree(third), "objects", "Policy__c.object"), "utf8")).toContain("Premium__c");
    // The profile keeps A, has B from this run, and lost the deleted C.
    expect([...profile(third).matchAll(/<apexClass>(\w+)<\/apexClass>/g)].map((m) => m[1]).sort()).toEqual(["A", "B"]);
    // The folders of earlier runs are gone.
    expect(readdirSync(dir).sort()).toEqual([path.basename(third.dir), `${ORG_ID}.json`].sort());
  });

  it("retrieves everything when asked, a week after the last full run, or for a new profile", async () => {
    const dir = tmp();
    const org: Record<string, string[]> = { ApexClass: ["A", "B"], Profile: ["Admin"] };
    const sf = fakeSf(org, [], { dates: {} });
    await retrieveOrgMetadata({ targetOrg: "dev", dir, sf });
    expect((await retrieveOrgMetadata({ targetOrg: "dev", dir, sf })).incremental).toBeDefined();
    expect((await retrieveOrgMetadata({ targetOrg: "dev", dir, sf, full: true })).incremental).toBeUndefined();
    const file = path.join(dir, `${ORG_ID}.json`);
    const pointer = JSON.parse(readFileSync(file, "utf8")) as { fullAt: string };
    writeFileSync(file, JSON.stringify({ ...pointer, fullAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }));
    expect((await retrieveOrgMetadata({ targetOrg: "dev", dir, sf })).incremental).toBeUndefined();
    org.Profile = ["Admin", "Sales"];
    expect((await retrieveOrgMetadata({ targetOrg: "dev", dir, sf })).incremental).toBeUndefined();
    // A retrieval by an earlier version (no layout) is redone in full too.
    writeFileSync(file, JSON.stringify({ folder: (JSON.parse(readFileSync(file, "utf8")) as { folder: string }).folder, retrievedAt: pointer.fullAt }));
    expect((await retrieveOrgMetadata({ targetOrg: "dev", dir, sf })).incremental).toBeUndefined();
  });

  it("replaces permission sets, retrieves again what the org did not return, and runs in full without the last tree", async () => {
    const dir = tmp();
    const org: Record<string, string[]> = { ApexClass: ["A", "B"], Profile: ["Admin"], PermissionSet: ["PS"] };
    const dates: Record<string, string> = {};
    const permissionSets: Record<string, string[]> = { PS: ["A", "B"] };
    const skip = new Set<string>();
    const asked: { type: string; members: string[] }[][] = [];
    const sf = fakeSf(org, [], { dates, asked, permissionSets, skip, messages: [] });
    const run = () => retrieveOrgMetadata({ targetOrg: "dev", dir, sf });
    const tree = (r: { dir: string }) => path.join(r.dir, "metadata");
    await run();

    // Access taken away from a permission set goes, though the class did not change; a new
    // permission set needs no full run.
    permissionSets.PS = ["A"];
    org.PermissionSet = ["PS", "PS2"];
    const second = await run();
    expect(second.incremental).toBeDefined();
    expect(readFileSync(path.join(tree(second), "permissionsets", "PS.permissionset"), "utf8")).not.toContain("<apexClass>B</apexClass>");
    expect(existsSync(path.join(tree(second), "permissionsets", "PS2.permissionset"))).toBe(true);

    // B changed but did not come back: the next run asks for it again, though its date is the same.
    dates["ApexClass:B"] = "2026-11-09T10:00:00.000Z";
    skip.add("ApexClass:B");
    const third = await run();
    expect(existsSync(path.join(tree(third), "classes", "B.cls"))).toBe(false);
    skip.clear();
    asked.length = 0;
    const fourth = await run();
    expect(asked[0]?.find((e) => e.type === "ApexClass")?.members).toEqual(["B"]);
    expect(existsSync(path.join(tree(fourth), "classes", "B.cls"))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith(".next"))).toEqual([]);

    // A profile the last tree has no copy of, or no last tree at all: everything is retrieved.
    rmSync(path.join(tree(fourth), "profiles", "Admin.profile"));
    const fifth = await run();
    expect(fifth.incremental).toBeUndefined();
    expect(readFileSync(path.join(tree(fifth), "profiles", "Admin.profile"), "utf8").match(/<classAccesses>/g)).toHaveLength(2);
    rmSync(tree(fifth), { recursive: true });
    const sixth = await run();
    expect(sixth.incremental).toBeUndefined();
    expect(readdirSync(path.join(tree(sixth), "classes")).sort()).toEqual(["A.cls", "A.cls-meta.xml", "B.cls", "B.cls-meta.xml"]);
  });

  it("merges access: what was retrieved wins, the rest of the last copy stays, changed components lose theirs", () => {
    const last = "<Profile><classAccesses><apexClass>A</apexClass><enabled>true</enabled></classAccesses><classAccesses><apexClass>Gone</apexClass><enabled>true</enabled></classAccesses><fieldPermissions><field>Policy__c.Old__c</field></fieldPermissions><userLicense>Salesforce</userLicense></Profile>";
    const now = "<Profile><classAccesses><apexClass>A</apexClass><enabled>false</enabled></classAccesses><userLicense>Salesforce</userLicense></Profile>";
    const merged = mergeAccess(last, now, (type, member) => (type === "ApexClass" && member === "Gone") || (type === "CustomField" && member.startsWith("Policy__c.")));
    expect(merged.match(/<classAccesses>/g)).toHaveLength(1);
    expect(merged).toContain("<enabled>false</enabled>");
    expect(merged).not.toContain("Gone");
    expect(merged).not.toContain("Old__c");
    expect(mergeAccess(last, now, () => false)).toContain("Gone");
  });
});

describe("retrieveOrgMetadata, when things go wrong", () => {
  it("reports what the org could not return, and fails when it returns nothing", async () => {
    const dir = tmp();
    const sf = fakeSf({ ApexClass: ["A"] }, [], { messages: [{ problem: "Entity of type 'ApexClass' named 'Gone' cannot be found" }] });
    const r = await retrieveOrgMetadata({ targetOrg: "dev", dir, sf });
    expect(r.warnings).toEqual(["Entity of type 'ApexClass' named 'Gone' cannot be found"]);
    const empty = fakeSf({ ApexClass: ["A"] }, [], { empty: true, messages: [{ problem: "INSUFFICIENT_ACCESS" }] });
    await expect(retrieveOrgMetadata({ targetOrg: "dev", dir, sf: empty })).rejects.toThrow(/returned nothing for part 1: INSUFFICIENT_ACCESS/);
    // The good retrieval is still there, and still the current one.
    expect(current(dir)).toBe(path.basename(r.dir));
    expect(readdirSync(dir).sort()).toEqual([path.basename(r.dir), `${ORG_ID}.json`].sort());
    expect(readdirSync(r.dir, { recursive: true }).some((f) => String(f).endsWith("A.cls"))).toBe(true);
  });

  it("splits a part the org refuses as too large, lists unlocked packages, and skips the display it was given", async () => {
    const dir = tmp();
    const calls: { args: string[]; cwd?: string }[] = [];
    const sf = fakeSf({ ApexClass: ["A", "B", "C", "D"] }, calls, { limit: 2 });
    const r = await retrieveOrgMetadata({ targetOrg: "dev", org: { id: ORG_ID }, dir, sf });
    expect(r.parts).toBe(2);
    expect(calls.some((c) => c.args[1] === "display")).toBe(false);
    expect(calls.find((c) => c.args[1] === "generate")!.args).toContain("unlocked");
    expect(readdirSync(path.join(r.dir, "metadata", "classes")).filter((f) => f.endsWith(".cls")).sort()).toEqual(["A.cls", "B.cls", "C.cls", "D.cls"]);
  });

  it("removes the folders of runs that died, and of earlier versions, but not other orgs'", async () => {
    const dir = tmp();
    for (const f of [`.retrieve-${ORG_ID}-dead`, `.old-${ORG_ID}-1`, ORG_ID, `${ORG_ID}-dead`, "00D000000000002AAA-x"]) mkdirSync(path.join(dir, f, "part-1"), { recursive: true });
    // A failed first run after an upgrade keeps the earlier version's retrieval: nothing is
    // known to be complete without a pointer.
    const failing: SfRunner = async (args, opts) => {
      if (args[1] === "retrieve") throw new Error("sf project retrieve failed: INVALID_SESSION_ID");
      return fakeSf({ ApexClass: ["A"] })(args, opts);
    };
    await expect(retrieveOrgMetadata({ targetOrg: "dev", dir, sf: failing })).rejects.toThrow("INVALID_SESSION_ID");
    expect(readdirSync(dir).sort()).toEqual([ORG_ID, `${ORG_ID}-dead`, "00D000000000002AAA-x"].sort());
    // A run that completes removes the earlier version's folder; a dead run's goes at the next start.
    const r = await retrieveOrgMetadata({ targetOrg: "dev", dir, sf: fakeSf({ ApexClass: ["A"] }) });
    expect(readdirSync(dir).sort()).toEqual([`${ORG_ID}-dead`, "00D000000000002AAA-x", path.basename(r.dir), `${ORG_ID}.json`].sort());
    const again = await retrieveOrgMetadata({ targetOrg: "dev", dir, sf: fakeSf({ ApexClass: ["A"] }) });
    expect(readdirSync(dir).sort()).toEqual(["00D000000000002AAA-x", path.basename(again.dir), `${ORG_ID}.json`].sort());
  });

  it("keeps an object's layouts with it", () => {
    const parts = splitManifest(
      [
        { type: "CustomObject", members: ["Account", "Policy__c"] },
        { type: "Layout", members: ["Account-Account Layout", "Policy__c-Policy Layout"] },
      ],
      2,
    );
    for (const part of parts) {
      const objects = part.find((e) => e.type === "CustomObject")?.members ?? [];
      for (const l of part.find((e) => e.type === "Layout")?.members ?? []) expect(objects).toContain(l.split("-")[0]);
    }
  });
});

describe("indexing", () => {
  it("indexes an org under its org id, and a project under its folder name and a hash of its path", async () => {
    const workspace = tmp();
    const idx = index();
    const snap = await indexOrg(idx, "dev", { workspace, sf: fakeSf({ ApexClass: ["RenewalService"], CustomObject: ["Policy__c"], CustomField: ["Policy__c.Status__c"] }) });
    expect(snap).toMatchObject({ source: `org:${ORG_ID}`, kind: "org", status: "ready", stats: { counts: { ApexClass: 1, CustomObject: 1, CustomField: 1 } } });
    expect(idx.component(snap.id, "ApexClass", "RenewalService")).toBeDefined();

    const project = path.join(tmp(), "my project");
    mkdirSync(path.join(project, "classes"), { recursive: true });
    writeFileSync(path.join(project, "classes", "A.cls"), "public class A {}");
    const p = await indexProject(idx, project);
    expect(p.source).toBe(projectSource(project));
    expect(p.source).toMatch(/^repo:my project#[0-9a-f]{8}$/);
    expect(p.source).not.toContain(tmpdir());
  });

  it("leaves the workspace out of a project, and its path out of errors", async () => {
    const project = tmp();
    const workspace = path.join(project, ".sf-agent");
    const idx = index();
    await indexOrg(idx, "dev", { workspace, sf: fakeSf({ ApexClass: ["FromOrg"] }) });
    mkdirSync(path.join(project, "classes"), { recursive: true });
    writeFileSync(path.join(project, "classes", "Mine.cls"), "public class Mine {}");
    const p = await indexProject(idx, project, { workspace });
    expect(Object.keys(p.stats.counts ?? {})).toEqual(["ApexClass"]);
    expect(idx.component(p.id, "ApexClass", "FromOrg")).toBeUndefined();
    // A workspace elsewhere, by its path.
    const other = path.join(project, "ws");
    await indexOrg(idx, "dev", { workspace: other, sf: fakeSf({ ApexClass: ["Again"] }) });
    expect(idx.component((await indexProject(idx, project, { workspace: other })).id, "ApexClass", "Again")).toBeUndefined();

    const failing: SfRunner = async (args, opts) => {
      if (args[1] === "retrieve") throw new Error(`sf project retrieve failed: ENOENT ${path.join(workspace, "orgs", "x")}`);
      return fakeSf({ ApexClass: ["A"] })(args, opts);
    };
    const err = await indexOrg(idx, "dev", { workspace, sf: failing }).then(() => new Error("indexed"), (e: Error) => e);
    expect(err.message).toContain("<workspace>");
    expect(err.message).not.toContain(project);
    expect(JSON.stringify(idx.snapshots())).not.toContain(project);
  });

  it("refuses an org retrieval with nothing the index can read", async () => {
    const workspace = tmp();
    const idx = index();
    await expect(indexOrg(idx, "dev", { workspace, sf: fakeSf({ ApexClass: ["A"] }, [], { junk: true }) })).rejects.toThrow(/Nothing could be read/);
  });

  it("runs in the background, one run per target, and reports failures", async () => {
    const workspace = tmp();
    const indexer = new BackgroundIndexer(index(), { workspace, sf: fakeSf({ ApexClass: ["A"] }) });
    const a = indexer.start({ kind: "org", targetOrg: "dev" });
    const again = indexer.start({ kind: "org", targetOrg: "dev" });
    expect(again.job).toBe(a.job);
    expect(a.job.state).toBe("running");
    const missing = indexer.start({ kind: "project", dir: path.join(workspace, "nope") });
    await indexer.settle();
    expect(a.job).toMatchObject({ state: "ready", snapshot: { status: "ready" } });
    expect(missing.job).toMatchObject({ state: "failed", message: expect.stringMatching(/cannot be read/) });
    expect(missing.job.target).toMatch(/^repo:nope#/);
    expect(indexer.list()).toHaveLength(2);
    // A finished run can be started again.
    expect(indexer.start({ kind: "org", targetOrg: "dev" }).job).not.toBe(a.job);
    await indexer.settle();
  });
});

describe("retrieve warnings and unretrievable members", () => {
  it("counts the components the org listed but did not return, by type", () => {
    const missing = (t: string, n: string) => `Entity of type '${t}' named '${n}' cannot be found`;
    expect(summarizeWarnings([missing("ListView", "A.x"), missing("ListView", "B.y"), "Some other problem", missing("CustomField", "C.z__c")])).toEqual([
      "2 ListView components were listed but not returned, such as A.x, B.y",
      "CustomField C.z__c was listed but not returned",
      "Some other problem",
    ]);
  });

  it("says a problem repeated by every part once, and caps the lines", () => {
    expect(summarizeWarnings(["Same", "Same"])).toEqual(["Same"]);
    const many = summarizeWarnings(Array.from({ length: 80 }, (_, i) => `Problem ${i}`));
    expect(many).toHaveLength(50);
    expect(many.at(-1)).toBe("and 31 more problems");
  });

  it("leaves historical trending objects out of the listing", () => {
    const { entries } = readManifest(manifest({ CustomObject: ["Opportunity__hd", "Policy__c"], CustomField: ["Opportunity__hd.Amount__c", "Policy__c.Status__c"] }));
    expect(entries).toEqual([
      { type: "CustomObject", members: ["Policy__c"] },
      { type: "CustomField", members: ["Policy__c.Status__c"] },
    ]);
  });
});
