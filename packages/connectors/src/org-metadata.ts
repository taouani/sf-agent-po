// Retrieves an org's metadata through the user's Salesforce CLI, in metadata format, for the
// metadata index (decision B). Read-only: it lists and retrieves, never deploys.

import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyFile, parseMetadataXml } from "@sf-agent-po/core";
import { defaultSfRunner, type SfRunner } from "./salesforce.js";

/**
 * What is retrieved by default: what the index reads in detail, and what flows, Apex and
 * layouts point at. Email templates are retrieved for their merge fields; the index keeps
 * none of their text. Left out: types whose content is records or people's text
 * (documents, reports, custom metadata records) and large binaries (static resources).
 */
export const DEFAULT_ORG_TYPES = [
  "CustomObject", "CustomField", "RecordType", "ValidationRule", "ListView", "CompactLayout", "FieldSet", "WebLink",
  "BusinessProcess", "Flow", "ApexClass", "ApexTrigger", "ApexPage", "ApexComponent", "PermissionSet",
  "PermissionSetGroup", "Profile", "Layout", "LightningComponentBundle", "AuraDefinitionBundle", "QuickAction",
  "CustomApplication", "CustomTab", "FlexiPage", "CustomPermission", "CustomLabels", "Workflow",
  "ExternalServiceRegistration", "GlobalValueSet", "EmailTemplate",
] as const;

/** Child types of an object: retrieved with their object, in its file. */
const OBJECT_CHILDREN = new Set(["CustomField", "RecordType", "ValidationRule", "ListView", "CompactLayout", "FieldSet", "WebLink", "BusinessProcess", "SharingReason", "Index"]);
/** Types made of a source file and its metadata file, or of a folder of files. */
const FILES_PER_MEMBER: Record<string, number> = { ApexClass: 2, ApexTrigger: 2, ApexPage: 2, ApexComponent: 2, EmailTemplate: 2, LightningComponentBundle: 8, AuraDefinitionBundle: 10 };
/** One retrieve may return 10,000 files; a little room is kept. */
export const MAX_FILES_PER_RETRIEVE = 9_000;
/** Elements a profile lists per component: what a retrieve in several parts must merge. */
const PROFILE_LISTS = [
  "applicationVisibilities", "classAccesses", "customMetadataTypeAccesses", "customPermissions", "customSettingAccesses",
  "fieldPermissions", "flowAccesses", "layoutAssignments", "objectPermissions", "pageAccesses", "recordTypeVisibilities", "tabVisibilities",
];

/**
 * Types whose members are retrieved on every run. Salesforce does not change the date of a
 * profile or permission set when only its access changes, so both are retrieved each time. A
 * permission set comes back whole (API 40 and later), so it replaces its last copy; a profile
 * only lists access to what is retrieved with it, so it is merged into its last copy. Labels,
 * workflows and email templates are listed without a dependable date per file.
 */
const MERGED = new Set(["Profile"]);
const ALWAYS = new Set([...MERGED, "PermissionSet", "CustomLabels", "Workflow", "EmailTemplate"]);
/** Files of these types go when their type is retrieved again: an email folder with its templates. */
const REPLACED_WITH: Record<string, string> = { EmailFolder: "EmailTemplate" };

/** A retrieval older than this is redone in full: dates can miss a change (access on a profile). */
export const FULL_RETRIEVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** The layout of a retrieval folder: 2 keeps every file in metadata/, whatever the parts. */
const LAYOUT = 2;
/** The folder of a retrieval that holds its files, at stable paths from run to run. */
export const RETRIEVAL_TREE = "metadata";

/** Each list a profile or permission set holds per component: its key element and the component's type. */
const ACCESS_KEYS: Record<string, [string, string]> = {
  fieldPermissions: ["field", "CustomField"],
  objectPermissions: ["object", "CustomObject"],
  classAccesses: ["apexClass", "ApexClass"],
  pageAccesses: ["apexPage", "ApexPage"],
  layoutAssignments: ["layout", "Layout"],
  recordTypeVisibilities: ["recordType", "RecordType"],
  tabVisibilities: ["tab", "CustomTab"],
  tabSettings: ["tab", "CustomTab"],
  applicationVisibilities: ["application", "CustomApplication"],
  customPermissions: ["name", "CustomPermission"],
  flowAccesses: ["flow", "Flow"],
  customMetadataTypeAccesses: ["name", "CustomObject"],
  customSettingAccesses: ["name", "CustomObject"],
};

/** The pattern of each access list's key element. */
const KEY_PATTERNS = new Map(Object.entries(ACCESS_KEYS).map(([tag, [key]]) => [tag, new RegExp(`<${key}>([\\s\\S]*?)</${key}>`)]));

/**
 * A profile retrieved with only some components, merged into its last full copy: what was retrieved now wins; the last copy's access to components not retrieved now
 * (and not deleted, which `changed` also answers for) is kept.
 */
export function mergeAccess(previous: string, retrieved: string, changed: (type: string, member: string) => boolean): string {
  const lists = new RegExp(`<(${Object.keys(ACCESS_KEYS).join("|")})>([\\s\\S]*?)</\\1>`, "g");
  const keyOf = (tag: string, body: string) => KEY_PATTERNS.get(tag)!.exec(body)?.[1]?.trim();
  const fresh = new Set<string>();
  for (const m of retrieved.matchAll(lists)) {
    const key = keyOf(m[1]!, m[2]!);
    if (key) fresh.add(`${m[1]}\0${key}`);
  }
  const kept: string[] = [];
  for (const m of previous.matchAll(lists)) {
    const key = keyOf(m[1]!, m[2]!);
    if (!key || fresh.has(`${m[1]}\0${key}`) || changed(ACCESS_KEYS[m[1]!]![1], key)) continue;
    kept.push(`    ${m[0]}\n`);
  }
  const close = Math.max(retrieved.lastIndexOf("</Profile>"), retrieved.lastIndexOf("</PermissionSet>"));
  if (close < 0 || !kept.length) return retrieved;
  return `${retrieved.slice(0, close)}${kept.join("")}${retrieved.slice(close)}`;
}

/**
 * Members an org lists but never returns: those of historical trending objects (`__hd`),
 * which the Metadata API cannot retrieve.
 */
const unretrievable = (member: string) => /__hd(?:$|\.)/.test(member);

/** Org aliases and usernames passed to the CLI: nothing a shell or the CLI could read as more. */
const ORG_ARG = /^[\w.@+-]+$/;

/** Throws unless `targetOrg` can be an org alias or username. */
export function checkOrgArg(targetOrg: string): void {
  if (!ORG_ARG.test(targetOrg) || targetOrg.startsWith("-")) throw new Error(`"${targetOrg}" is not an org alias or username.`);
}

export interface ManifestEntry {
  type: string;
  members: string[];
}

/** The types and members of a package.xml, keeping only `types`. */
export function readManifest(xml: string, types: readonly string[] = DEFAULT_ORG_TYPES): { entries: ManifestEntry[]; version?: string } {
  const pkg = parseMetadataXml(xml).Package as Record<string, unknown> | undefined;
  if (!pkg || typeof pkg !== "object") throw new Error("the manifest has no Package element");
  const wanted = new Set(types);
  const asList = (v: unknown) => (v === undefined || v === "" ? [] : Array.isArray(v) ? v : [v]);
  const entries: ManifestEntry[] = [];
  for (const t of asList(pkg.types) as Record<string, unknown>[]) {
    const name = typeof t.name === "string" ? t.name : undefined;
    if (!name || !wanted.has(name)) continue;
    const members = (asList(t.members) as unknown[]).filter((m): m is string => typeof m === "string" && m !== "" && !unretrievable(m)).sort();
    if (members.length) entries.push({ type: name, members });
  }
  return { entries, ...(typeof pkg.version === "string" ? { version: pkg.version } : {}) };
}

/**
 * Which members travel together: an object with its children and its layouts (a profile's
 * layout assignment names a layout and a record type of one object), anything else alone.
 */
function groupOf(type: string, member: string): string {
  const owner = (sep: string) => {
    const at = member.indexOf(sep);
    return (at > 0 ? member.slice(0, at) : member).toLowerCase();
  };
  if (type === "CustomObject") return `object:${member.toLowerCase()}`;
  if (OBJECT_CHILDREN.has(type)) return `object:${owner(".")}`;
  if (type === "Layout") return `object:${owner("-")}`;
  return `${type}:${member}`;
}

/** The files a part is expected to bring back. */
export function estimateFiles(entries: readonly ManifestEntry[]): number {
  return entries.reduce((n, e) => n + (OBJECT_CHILDREN.has(e.type) ? 0 : e.members.length * (FILES_PER_MEMBER[e.type] ?? 1)), 0);
}

/**
 * The manifest split into retrieves of at most `maxFiles` files each. An object and its
 * fields, record types and rules stay together, since they come back in one file. Profiles go
 * in every part: a profile only lists permissions for what is retrieved with it, and the parts
 * are merged afterwards.
 */
export function splitManifest(entries: readonly ManifestEntry[], maxFiles = MAX_FILES_PER_RETRIEVE): ManifestEntry[][] {
  const profiles = entries.find((e) => e.type === "Profile");
  const budget = Math.max(1, maxFiles - (profiles?.members.length ?? 0));
  // Groups of members that must travel together, with the files they make.
  const groups = new Map<string, { files: number; items: [string, string][] }>();
  for (const e of entries) {
    if (e === profiles) continue;
    for (const m of e.members) {
      const key = groupOf(e.type, m);
      const group = groups.get(key) ?? { files: 0, items: [] };
      if (!groups.has(key)) groups.set(key, group);
      // An object's children add nothing: they are in its file, which counts once.
      group.files = OBJECT_CHILDREN.has(e.type) ? Math.max(group.files, 1) : group.files + (FILES_PER_MEMBER[e.type] ?? 1);
      group.items.push([e.type, m]);
    }
  }
  const parts: [string, string][][] = [];
  let current: [string, string][] = [];
  let files = 0;
  for (const g of groups.values()) {
    if (current.length && files + g.files > budget) {
      parts.push(current);
      current = [];
      files = 0;
    }
    current.push(...g.items);
    files += g.files;
  }
  if (current.length || !parts.length) parts.push(current);
  return parts.map((items) => {
    const byType = new Map<string, string[]>();
    for (const [type, member] of items) {
      const list = byType.get(type);
      if (list) list.push(member);
      else byType.set(type, [member]);
    }
    return [...[...byType].map(([type, members]) => ({ type, members })), ...(profiles ? [profiles] : [])];
  }).filter((part) => part.length);
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function writeManifest(entries: readonly ManifestEntry[], version?: string): string {
  const types = entries.map((e) => `  <types>\n${e.members.map((m) => `    <members>${escapeXml(m)}</members>\n`).join("")}    <name>${e.type}</name>\n  </types>\n`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types}${version ? `  <version>${escapeXml(version)}</version>\n` : ""}</Package>\n`;
}

export interface OrgRetrieval {
  /** The folder holding the retrieved metadata, in metadata format, for scanProject. */
  dir: string;
  orgId: string;
  alias?: string;
  /** Members asked for, by type. */
  counts: Record<string, number>;
  /** How many retrieves it took. */
  parts: number;
  /** What the CLI said it could not retrieve (a component missing, or not visible to the user). */
  warnings: string[];
  retrievedAt: string;
  /** For a run that retrieved only what changed: how many members it retrieved, and how many were deleted. */
  incremental?: { retrieved: number; deleted: number };
}

export interface RetrieveOptions {
  /** The org's alias or username, as `sf org login` saved it. */
  targetOrg: string;
  /** The org's id and alias, when the caller already asked `sf org display`. */
  org?: { id: string; alias?: string };
  /**
   * Where the org's folders go: each retrieval gets `<dir>/<org id>-<suffix>`, and
   * `<dir>/<org id>.json` names the last complete one.
   */
  dir: string;
  types?: readonly string[];
  /**
   * Package metadata to list besides the org's own: "unlocked" by default (teams build their
   * own code in unlocked packages); "managed" adds installed packages such as CPQ.
   */
  includePackages?: readonly ("unlocked" | "managed")[];
  sf?: SfRunner;
  /** Called as the work moves on, with a short line for the user. */
  progress?: (message: string) => void;
  /** Called between long steps, to say the run is alive (MetadataIndex's lease). */
  heartbeat?: () => void;
  /** Files one retrieve may return (MAX_FILES_PER_RETRIEVE by default). */
  maxFilesPerRetrieve?: number;
  /** How long one retrieve may take, in minutes (60 by default). */
  waitMinutes?: number;
  /** Retrieve everything, not only what changed since the last retrieval. */
  full?: boolean;
}

/** The org id from `sf org display`, checked. */
export function orgIdOf(info: unknown): string | undefined {
  const id = (info as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && /^[A-Za-z0-9]{15,18}$/.test(id) ? id : undefined;
}

/** Removing a folder on Windows can meet files another process (an antivirus) still holds. */
const remove = (p: string) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

/** A retrieve's problems, from the CLI's result: messages with a `problem`, or an error. */
function problemsOf(result: unknown): string[] {
  const r = (result ?? {}) as { messages?: unknown; errorMessage?: unknown };
  const messages = Array.isArray(r.messages) ? r.messages : r.messages ? [r.messages] : [];
  const out = messages
    .map((m) => (m && typeof m === "object" ? (m as { problem?: unknown }).problem : undefined))
    .filter((p): p is string => typeof p === "string" && p !== "");
  if (typeof r.errorMessage === "string" && r.errorMessage) out.push(r.errorMessage);
  return out;
}

/** A retrieve refused for its size: the 10,000-file or the zip size limit. */
const tooLarge = (err: unknown) => /LIMIT_EXCEEDED|too many files|exceed(?:s|ed)? the (?:maximum|limit)|maximum size/i.test((err as Error)?.message ?? "");

/**
 * Lists what the org holds, keeps the types the index uses, and retrieves them in metadata
 * format, in several parts when there are too many files for one (a part the org refuses as
 * too large is split again). Profiles, which only list permissions for what is retrieved with
 * them, are merged back into one file each. The new retrieval replaces the last one only once
 * it is complete.
 */
export async function retrieveOrgMetadata(options: RetrieveOptions): Promise<OrgRetrieval> {
  const { targetOrg } = options;
  checkOrgArg(targetOrg);
  const sf = options.sf ?? defaultSfRunner;
  const progress = options.progress ?? (() => {});
  const heartbeat = options.heartbeat ?? (() => {});
  const wait = Math.max(1, Math.min(options.waitMinutes ?? 60, 240));

  let info: { id?: string; alias?: unknown } | undefined = options.org;
  if (!info) {
    const shown: unknown = await sf(["org", "display", "--target-org", targetOrg]);
    info = { id: orgIdOf(shown), alias: (shown as { alias?: unknown } | undefined)?.alias };
  }
  const orgId = info.id;
  if (!orgId) throw new Error(`sf org display gave no org id for ${targetOrg}.`);

  await mkdir(options.dir, { recursive: true });
  // Folders of runs that died (the caller holds the lease, so no other run is alive). Without
  // a readable pointer nothing is known to be complete, so nothing but old work folders goes:
  // the last good retrieval, or an earlier version's, stays until a new one is complete.
  const pointer = await readPointer(options.dir, orgId);
  const previous = pointer?.folder;
  await removeStale(options.dir, orgId, previous ? { keep: previous } : { workOnly: true });
  // Work in a folder of its own, which becomes the retrieval: folders are never renamed,
  // because Windows refuses to while an antivirus or an editor still holds new files in them.
  // The CLI is given relative paths only, so a user name with a space in the workspace path
  // never reaches a shell.
  const work = await mkdtemp(path.join(options.dir, `${orgId}-`));
  try {
    // The CLI refuses to list or retrieve outside a Salesforce project, so the work folder
    // is a minimal one. Retrieval goes to metadata folders, never into its package folder.
    await mkdir(path.join(work, "force-app"));
    await writeFile(path.join(work, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }, null, 2));
    progress(`Listing the metadata in ${targetOrg}`);
    const packages = options.includePackages ?? ["unlocked"];
    await sf(["project", "generate", "manifest", "--from-org", targetOrg, ...packages.flatMap((p) => ["--include-packages", p]), "--output-dir", ".", "--name", "package"], {
      cwd: work,
      timeoutMs: wait * 60_000,
    });
    heartbeat();
    const types = options.types ?? DEFAULT_ORG_TYPES;
    const { entries, version } = readManifest(await readFile(path.join(work, "package.xml"), "utf8"), types);
    // An empty listing is a CLI or permission problem, not an empty org: it must not replace
    // a good index.
    if (!entries.length) throw new Error(`The metadata listing of ${targetOrg} is empty: check that the user can view setup and configuration.`);
    const counts = Object.fromEntries(entries.map((e) => [e.type, e.members.length]));
    progress(`Reading when each component of ${targetOrg} last changed`);
    const dates = await listDates(sf, targetOrg, entries.map((e) => e.type).filter((t) => !ALWAYS.has(t)), { cwd: work, timeoutMs: wait * 60_000, heartbeat });
    // The last tree, which an incremental run starts from: gone (deleted, or quarantined by an
    // antivirus) means a full run, as does a profile it has no copy of to merge into.
    const base = previous ? path.join(options.dir, previous, RETRIEVAL_TREE) : undefined;
    const baseProfiles = base ? await profilesIn(base) : undefined;
    const plan = baseProfiles ? changesSince(pointer, entries, dates, types, baseProfiles, { full: options.full, now: Date.now() }) : undefined;
    const wanted = plan ? entries.map((e) => ({ type: e.type, members: e.members.filter((m) => ALWAYS.has(e.type) || plan.changed.has(groupOf(e.type, m))) })).filter((e) => e.members.length) : entries;
    const queue = wanted.length ? splitManifest(wanted, options.maxFilesPerRetrieve) : [];
    const warnings: string[] = [];
    let n = 0;
    while (queue.length) {
      const part = queue.shift()!;
      const name = `part-${++n}`;
      await writeFile(path.join(work, `${name}.xml`), writeManifest(part, version));
      const members = part.reduce((k, e) => k + e.members.length, 0);
      progress(queue.length || n > 1 ? `Retrieving part ${n} of ${n + queue.length}` : `Retrieving ${members} ${plan ? "changed or always retrieved " : ""}components`);
      let result: unknown;
      try {
        result = await sf(
          ["project", "retrieve", "start", "--manifest", `${name}.xml`, "--target-metadata-dir", name, "--unzip", "--wait", String(wait), "--target-org", targetOrg],
          { cwd: work, timeoutMs: (wait + 5) * 60_000 },
        );
      } catch (err) {
        // Too large for one retrieve after all: split it in two and go on.
        const files = estimateFiles(part);
        if (!tooLarge(err) || files < 2) throw err;
        await remove(path.join(work, name));
        queue.unshift(...splitManifest(part, Math.ceil(files / 2)));
        n--;
        continue;
      }
      heartbeat();
      warnings.push(...problemsOf(result));
      // The zip the CLI kept beside the unzipped folder is not needed.
      const out = path.join(work, name);
      const kept = await readdir(out).catch(() => [] as string[]);
      for (const f of kept) if (f.endsWith(".zip")) await remove(path.join(out, f));
      if (!(await filesUnder(out).catch(() => [] as string[])).some((f) => !f.endsWith("package.xml"))) {
        throw new Error(`The org returned nothing for part ${n}${warnings.length ? `: ${warnings.slice(-3).join("; ")}` : ""}.`);
      }
    }
    const parts = Array.from({ length: n }, (_, i) => `part-${i + 1}`);
    if (n > 1) await mergeProfiles(work, parts);
    // Every file goes to one tree at the same path from run to run, so that the index's parse
    // cache finds the files that did not change. A run that retrieved only what changed starts
    // from a copy of the last tree.
    const tree = path.join(work, RETRIEVAL_TREE);
    await mkdir(tree, { recursive: true });
    if (plan) {
      progress("Copying the last retrieval");
      await cp(base!, tree, { recursive: true });
      await removeRetrievedAgain(tree, plan.changed, new Set(entries.flatMap((e) => (MERGED.has(e.type) ? e.members.map((m) => `${e.type}\0${m}`) : []))));
      heartbeat();
    }
    for (const part of parts) {
      for (const f of await filesUnder(path.join(work, part))) {
        const rel = f.startsWith("unpackaged/") ? f.slice("unpackaged/".length) : f;
        if (rel === "package.xml") continue;
        const target = path.join(tree, rel);
        const kind = classifyFile(rel)?.type;
        const text = await readFile(path.join(work, part, f));
        if (plan && kind && MERGED.has(kind)) {
          const last = await readFile(target, "utf8").catch(() => undefined);
          if (last !== undefined) {
            await writeFile(target, mergeAccess(last, text.toString("utf8"), (type, member) => plan.changed.has(groupOf(type, member))));
            continue;
          }
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, text);
      }
      await remove(path.join(work, part));
    }
    // Only the tree is kept. The project file must go, as it would steer the scan to its
    // empty package folder; the manifests and what the CLI left (.sf, .sfdx) may stay if
    // Windows holds them, and go with the folder later.
    await rm(path.join(work, "sfdx-project.json"), { force: true, maxRetries: 10, retryDelay: 300 });
    for (const f of await readdir(work)) if (f !== RETRIEVAL_TREE) await remove(path.join(work, f)).catch(() => {});
    const retrievedAt = new Date().toISOString();
    // A component the org did not return (a warning) is retrieved again next time: its date is
    // kept only when the tree holds its group's file. Members not in the manifest (those of
    // managed packages) are left out.
    const present = new Set<string>();
    for (const f of await filesUnder(tree)) {
      const c = classifyFile(f);
      if (c) present.add(groupOf(REPLACED_WITH[c.type] ?? c.type, c.name));
    }
    const keptDates: Record<string, Record<string, string>> = {};
    for (const e of entries) {
      const listed = dates[e.type];
      if (!listed) continue;
      const kept: Record<string, string> = {};
      for (const m of e.members) if (listed[m] && present.has(groupOf(e.type, m))) kept[m] = listed[m];
      keptDates[e.type] = kept;
    }
    // A small file names the new retrieval, with what it holds and when each component last
    // changed, and only then is the previous one removed. Folders of runs that died go at the
    // next start, so a run started meanwhile is never touched.
    const next: Pointer = {
      folder: path.basename(work),
      retrievedAt,
      layout: LAYOUT,
      fullAt: plan ? pointer!.fullAt! : retrievedAt,
      types: [...types],
      members: Object.fromEntries(entries.map((e) => [e.type, e.members])),
      dates: keptDates,
    };
    await writeRetrying(pointerFile(options.dir, orgId), JSON.stringify(next));
    await removeStale(options.dir, orgId, { only: previous });
    return {
      dir: work,
      orgId,
      ...(typeof info.alias === "string" ? { alias: info.alias } : {}),
      counts,
      parts: n,
      warnings,
      retrievedAt,
      ...(plan ? { incremental: { retrieved: wanted.reduce((k, e) => k + e.members.length, 0), deleted: plan.deleted } } : {}),
    };
  } catch (err) {
    await remove(work).catch(() => {});
    throw err;
  }
}

/** What an org's pointer file holds: the last complete retrieval, and what it was made of. */
interface Pointer {
  folder: string;
  retrievedAt: string;
  /** Missing in retrievals by earlier versions, which kept their parts' folders. */
  layout?: number;
  /** When the org was last retrieved in full. */
  fullAt?: string;
  types?: string[];
  members?: Record<string, string[]>;
  /** Each member's last-modified date, by type, from sf org list metadata. */
  dates?: Record<string, Record<string, string>>;
}

/**
 * What changed since the last retrieval, as the groups to retrieve again (an object with its
 * children and layouts, or one member), or undefined when this run must retrieve everything:
 * asked to, no usable last retrieval, other types, the last full one a week old or more, or a
 * profile the last tree has no copy of to merge into (a new one).
 *
 * Dates cannot see every change: access on a profile or permission set (both retrieved every
 * time), and what a standard object holds itself (its settings, overrides, search layouts),
 * which Salesforce does not date. The weekly full run, or `--full`, picks those up.
 */
function changesSince(
  pointer: Pointer | undefined,
  entries: readonly ManifestEntry[],
  dates: Record<string, Record<string, string>>,
  types: readonly string[],
  baseProfiles: Set<string>,
  { full, now }: { full?: boolean; now: number },
): { changed: Set<string>; deleted: number } | undefined {
  if (full || !pointer || pointer.layout !== LAYOUT || !pointer.fullAt || !pointer.members || !pointer.dates) return undefined;
  // An unreadable date counts as old.
  if (!(now - Date.parse(pointer.fullAt) < FULL_RETRIEVE_AFTER_MS)) return undefined;
  if ([...(pointer.types ?? [])].sort().join() !== [...types].sort().join()) return undefined;
  const before = new Set(Object.entries(pointer.members).flatMap(([type, members]) => members.map((m) => `${type}\0${m}`)));
  const changed = new Set<string>();
  for (const e of entries) {
    for (const m of e.members) {
      if (MERGED.has(e.type)) {
        if (!before.has(`${e.type}\0${m}`) || !baseProfiles.has(m)) return undefined;
        continue;
      }
      if (ALWAYS.has(e.type)) continue;
      const was = pointer.dates[e.type]?.[m];
      const is = dates[e.type]?.[m];
      // No date (a listing that failed, a member it did not show) counts as a change.
      if (!was || !is || was !== is || !before.has(`${e.type}\0${m}`)) changed.add(groupOf(e.type, m));
    }
  }
  const now_ = new Set(entries.flatMap((e) => e.members.map((m) => `${e.type}\0${m}`)));
  let deleted = 0;
  for (const [type, members] of Object.entries(pointer.members)) {
    for (const m of members) {
      if (now_.has(`${type}\0${m}`)) continue;
      deleted++;
      changed.add(groupOf(type, m));
    }
  }
  return { changed, deleted };
}

/**
 * Removes from a copy of the last tree the files this run retrieves again or that are gone:
 * the changed groups' files, every file of a type retrieved each time (but a profile still in
 * the org, which is merged), and those of deleted members.
 */
async function removeRetrievedAgain(tree: string, changed: Set<string>, mergedNow: Set<string>): Promise<void> {
  for (const f of await filesUnder(tree)) {
    const c = classifyFile(f);
    if (!c) continue;
    const type = REPLACED_WITH[c.type] ?? c.type;
    const gone = MERGED.has(type) ? !mergedNow.has(`${type}\0${c.name}`) : ALWAYS.has(type) || changed.has(groupOf(type, c.name));
    if (gone) await remove(path.join(tree, f));
  }
}

/** The profiles a retrieval tree holds, by name; undefined when the tree is gone. */
async function profilesIn(tree: string): Promise<Set<string> | undefined> {
  if (!(await stat(tree).then((s) => s.isDirectory(), () => false))) return undefined;
  const names = new Set<string>();
  for (const f of await readdir(path.join(tree, "profiles")).catch(() => [] as string[])) {
    const c = classifyFile(`profiles/${f}`);
    if (c?.type === "Profile") names.add(c.name);
  }
  return names;
}

/** When each member of `types` last changed, from sf org list metadata; a type whose listing fails is left out. */
async function listDates(sf: SfRunner, targetOrg: string, types: readonly string[], opts: { cwd: string; timeoutMs: number; heartbeat: () => void }): Promise<Record<string, Record<string, string>>> {
  const { heartbeat, ...run } = opts;
  const out: Record<string, Record<string, string>> = {};
  const queue = [...types];
  const worker = async () => {
    for (let type = queue.shift(); type; type = queue.shift()) {
      try {
        const result: unknown = await sf(["org", "list", "metadata", "--metadata-type", type, "--target-org", targetOrg], run);
        const rows = Array.isArray(result) ? result : result ? [result] : [];
        const dates: Record<string, string> = {};
        for (const r of rows as { fullName?: unknown; lastModifiedDate?: unknown }[]) {
          if (typeof r?.fullName === "string" && typeof r.lastModifiedDate === "string") dates[r.fullName] = r.lastModifiedDate;
        }
        out[type] = dates;
      } catch {
        // Without dates, every member of the type counts as changed.
      }
      heartbeat();
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, types.length) }, worker));
  return out;
}

/** The file naming an org's last complete retrieval. */
const pointerFile = (dir: string, orgId: string) => path.join(dir, `${orgId}.json`);

/** An org's last complete retrieval, if there is one, with its folder name checked. */
async function readPointer(dir: string, orgId: string): Promise<Pointer | undefined> {
  try {
    const pointer = JSON.parse(await readFile(pointerFile(dir, orgId), "utf8")) as Pointer;
    const folder = pointer.folder as unknown;
    return typeof folder === "string" && folder.startsWith(`${orgId}-`) && !/[\\/]/.test(folder) ? pointer : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes an org's stale folders, leaving a folder Windows will not let go of yet for the next
 * run: every retrieval folder but `keep`, and an earlier version's (`<org id>`); with
 * `workOnly`, only earlier versions' work folders (`.retrieve-…`, `.old-…`); with `only`, that
 * one folder and an earlier version's.
 */
async function removeStale(dir: string, orgId: string, which: { keep: string } | { workOnly: true } | { only: string | undefined }): Promise<void> {
  for (const f of await readdir(dir)) {
    const work = f.startsWith(`.retrieve-${orgId}-`) || f.startsWith(`.old-${orgId}-`);
    const stale =
      "workOnly" in which ? work : "only" in which ? f === which.only || f === orgId || work : work || f === orgId || (f.startsWith(`${orgId}-`) && f !== which.keep);
    if (stale) await remove(path.join(dir, f)).catch(() => {});
  }
}

/**
 * Writes a file whole or not at all (a new file renamed over the old one), trying again for a
 * few seconds while Windows holds the old one.
 */
async function writeRetrying(file: string, text: string): Promise<void> {
  const next = `${file}.next`;
  await writeFile(next, text);
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(next, file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Every file under `dir`, relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(child);
      else if (e.isFile()) out.push(child);
    }
  }
  return out;
}

/** Each profile retrieved in several parts, as one file in the first part that has it. */
async function mergeProfiles(work: string, parts: string[]): Promise<void> {
  const copies = new Map<string, string[]>();
  for (const part of parts) {
    for (const f of await filesUnder(path.join(work, part))) {
      if (/(^|\/)profiles\/[^/]+\.profile$/.test(f)) {
        const name = f.slice(f.lastIndexOf("/") + 1);
        copies.set(name, [...(copies.get(name) ?? []), path.join(work, part, f)]);
      }
    }
  }
  const lists = new RegExp(`<(${PROFILE_LISTS.join("|")})>[\\s\\S]*?</\\1>`, "g");
  for (const files of copies.values()) {
    if (files.length < 2) continue;
    const first = await readFile(files[0]!, "utf8");
    const close = first.lastIndexOf("</Profile>");
    if (close < 0) continue;
    const extra: string[] = [];
    for (const f of files.slice(1)) {
      for (const m of (await readFile(f, "utf8")).matchAll(lists)) extra.push(`    ${m[0]}\n`);
      await rm(f, { force: true });
    }
    await writeFile(files[0]!, `${first.slice(0, close)}${extra.join("")}${first.slice(close)}`);
  }
}
