// Retrieves an org's metadata through the user's Salesforce CLI, in metadata format, for the
// metadata index (decision B). Read-only: it lists and retrieves, never deploys.

import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseMetadataXml } from "@sf-agent-po/core";
import { defaultSfRunner, type SfRunner } from "./salesforce.js";

/**
 * What is retrieved by default: what the index reads in detail, and what flows, Apex and
 * layouts point at. Left out: types whose content is records or people's text (email
 * templates, documents, reports, custom metadata records) and large binaries (static
 * resources).
 */
export const DEFAULT_ORG_TYPES = [
  "CustomObject", "CustomField", "RecordType", "ValidationRule", "ListView", "CompactLayout", "FieldSet", "WebLink",
  "BusinessProcess", "Flow", "ApexClass", "ApexTrigger", "ApexPage", "ApexComponent", "PermissionSet",
  "PermissionSetGroup", "Profile", "Layout", "LightningComponentBundle", "AuraDefinitionBundle", "QuickAction",
  "CustomApplication", "CustomTab", "FlexiPage", "CustomPermission", "CustomLabels", "Workflow",
  "ExternalServiceRegistration", "GlobalValueSet",
] as const;

/** Child types of an object: retrieved with their object, in its file. */
const OBJECT_CHILDREN = new Set(["CustomField", "RecordType", "ValidationRule", "ListView", "CompactLayout", "FieldSet", "WebLink", "BusinessProcess", "SharingReason", "Index"]);
/** Types made of a source file and its metadata file, or of a folder of files. */
const FILES_PER_MEMBER: Record<string, number> = { ApexClass: 2, ApexTrigger: 2, ApexPage: 2, ApexComponent: 2, LightningComponentBundle: 5, AuraDefinitionBundle: 5 };
/** One retrieve may return 10,000 files; a little room is kept. */
export const MAX_FILES_PER_RETRIEVE = 9_000;
/** Elements a profile lists per component: what a retrieve in several parts must merge. */
const PROFILE_LISTS = [
  "applicationVisibilities", "classAccesses", "customMetadataTypeAccesses", "customPermissions", "customSettingAccesses",
  "fieldPermissions", "flowAccesses", "layoutAssignments", "objectPermissions", "pageAccesses", "recordTypeVisibilities", "tabVisibilities",
];

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
    const members = (asList(t.members) as unknown[]).filter((m): m is string => typeof m === "string" && m !== "").sort();
    if (members.length) entries.push({ type: name, members });
  }
  return { entries, ...(typeof pkg.version === "string" ? { version: pkg.version } : {}) };
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
      const key = e.type === "CustomObject" ? `object:${m.toLowerCase()}` : OBJECT_CHILDREN.has(e.type) ? `object:${m.slice(0, m.indexOf(".")).toLowerCase()}` : `${e.type}:${m}`;
      const group = groups.get(key) ?? { files: 0, items: [] };
      if (!groups.has(key)) groups.set(key, group);
      // An object's children add nothing: they are in its file.
      group.files = Math.max(group.files, OBJECT_CHILDREN.has(e.type) ? 1 : FILES_PER_MEMBER[e.type] ?? 1);
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
  /** Members retrieved, by type. */
  counts: Record<string, number>;
  /** How many retrieves it took. */
  parts: number;
  retrievedAt: string;
}

export interface RetrieveOptions {
  /** The org's alias or username, as `sf org login` saved it. */
  targetOrg: string;
  /** Where the org's folders go: the retrieval replaces `<dir>/<org id>`. */
  dir: string;
  types?: readonly string[];
  sf?: SfRunner;
  /** Called as the work moves on, with a short line for the user. */
  progress?: (message: string) => void;
  /** How long one retrieve may take, in minutes (60 by default). */
  waitMinutes?: number;
}

/**
 * Lists what the org holds, keeps the types the index uses, and retrieves them in metadata
 * format, in several parts when there are too many files for one. Profiles, which only list
 * permissions for what is retrieved with them, are merged back into one file each.
 */
export async function retrieveOrgMetadata(options: RetrieveOptions): Promise<OrgRetrieval> {
  const { targetOrg } = options;
  checkOrgArg(targetOrg);
  const sf = options.sf ?? defaultSfRunner;
  const progress = options.progress ?? (() => {});
  const wait = Math.max(1, Math.min(options.waitMinutes ?? 60, 240));

  const info = (await sf(["org", "display", "--target-org", targetOrg])) as { id?: string; alias?: string };
  const orgId = typeof info?.id === "string" && /^[A-Za-z0-9]{15,18}$/.test(info.id) ? info.id : undefined;
  if (!orgId) throw new Error(`sf org display gave no org id for ${targetOrg}.`);

  await mkdir(options.dir, { recursive: true });
  // Work in a folder of its own; the CLI is given relative paths only, so a user name with a
  // space in the workspace path never reaches a shell.
  const work = await mkdtemp(path.join(options.dir, `.retrieve-${orgId}-`));
  try {
    progress(`Listing the metadata in ${targetOrg}`);
    await sf(["project", "generate", "manifest", "--from-org", targetOrg, "--output-dir", ".", "--name", "package"], { cwd: work, timeoutMs: wait * 60_000 });
    const { entries, version } = readManifest(await readFile(path.join(work, "package.xml"), "utf8"), options.types ?? DEFAULT_ORG_TYPES);
    // An empty listing is a CLI or permission problem, not an empty org: it must not replace
    // a good index.
    if (!entries.length) throw new Error(`The metadata listing of ${targetOrg} is empty: check that the user can view setup and configuration.`);
    const counts = Object.fromEntries(entries.map((e) => [e.type, e.members.length]));
    const parts = splitManifest(entries);
    for (const [i, part] of parts.entries()) {
      const name = `part-${i + 1}`;
      await writeFile(path.join(work, `${name}.xml`), writeManifest(part, version));
      progress(parts.length > 1 ? `Retrieving part ${i + 1} of ${parts.length}` : `Retrieving ${entries.reduce((n, e) => n + e.members.length, 0)} components`);
      await sf(
        ["project", "retrieve", "start", "--manifest", `${name}.xml`, "--target-metadata-dir", name, "--unzip", "--wait", String(wait), "--target-org", targetOrg],
        { cwd: work, timeoutMs: (wait + 5) * 60_000 },
      );
      // The zip the CLI kept beside the unzipped folder is not needed.
      for (const f of await readdir(path.join(work, name))) if (f.endsWith(".zip")) await rm(path.join(work, name, f), { force: true });
    }
    if (parts.length > 1) await mergeProfiles(work, parts.map((_, i) => `part-${i + 1}`));
    for (const f of await readdir(work)) if (f.endsWith(".xml")) await rm(path.join(work, f), { force: true });
    // The new retrieval replaces the last one only once it is complete.
    const dest = path.join(options.dir, orgId);
    await rm(dest, { recursive: true, force: true });
    await rename(work, dest);
    return { dir: dest, orgId, ...(typeof info.alias === "string" ? { alias: info.alias } : {}), counts, parts: parts.length, retrievedAt: new Date().toISOString() };
  } catch (err) {
    await rm(work, { recursive: true, force: true });
    throw err;
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
