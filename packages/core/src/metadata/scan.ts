// Reads a Salesforce project folder, in source format (sfdx) or metadata format (mdapi),
// into components and edges for the index.

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { COMPONENT_TYPES, type ParseCache, type ParsedComponent, type ParsedMetadata, type Ref } from "./model.js";
import { componentKey, isCustomName, linkObjects, readCustomMetadataRecord, readField, readFieldSet, readObject, readRecordType, readValidationRule } from "./objects.js";
import { MARKUP_SUFFIX, readMarkup } from "./markup.js";
import { readFlow } from "./flows.js";
import { readGroup, readQueue, readRole, readSharingRules } from "./sharing.js";
import { readApex } from "./apex.js";
import { readLayout, readPermissions, readPermissionSetGroup } from "./access.js";
import { readDashboard, readReport, readReportType } from "./reports.js";
import { readConnectedApp, readExternalCredential, readExternalService, readNamedCredential, readPlatformEventChannel, readOutboundMessage, readPlatformEventChannelMember, readRemoteSiteSetting, readWorkflow } from "./integrations.js";
import { classifyFile } from "./registry.js";
import { obj, parseMetadataXml } from "./xml.js";

/** Folders never read: tools' caches, dependencies and build output, not metadata. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".sf", ".sfdx", ".vscode", ".idea", ".husky", ".github",
  "coverage", "target", ".venv", "venv", "__pycache__", ".next", ".cache", ".pack-next",
  // sf-agent-po's own workspace, which holds retrieved org metadata.
  ".sf-agent",
]);
/** Larger files are skipped and reported: no object or field file comes near this. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** A folder with more files than this is not a Salesforce project, or not the right folder. */
export const MAX_FILES = 500_000;
/** How many skipped files the snapshot lists; the count covers them all. */
export const MAX_SKIPPED_LISTED = 200;

type Kind =
  | "object" | "field" | "recordType" | "validationRule" | "mdapiObject" | "flow"
  | "apexClass" | "apexTrigger" | "permissionSet" | "profile" | "permissionSetGroup" | "layout" | "fieldSet" | "markup"
  | "report" | "dashboard" | "reportType"
  | "namedCredential" | "externalCredential" | "remoteSite" | "connectedApp" | "externalService" | "eventChannel" | "eventChannelMember" | "workflow" | "outboundMessage"
  | "customMetadata" | "sharingRules" | "role" | "group" | "queue";

/**
 * Types read in detail that sit right in their folder: folder, the file's suffix, and the
 * kind. Apex is read from its source file, the rest from their XML in either format
 * (Foo.permissionset-meta.xml or Foo.permissionset).
 */
const TOP_LEVEL = new Map<string, [string, Kind, boolean]>([
  ["flows", [".flow", "flow", true]],
  ["classes", [".cls", "apexClass", false]],
  ["triggers", [".trigger", "apexTrigger", false]],
  ["permissionsets", [".permissionset", "permissionSet", true]],
  ["profiles", [".profile", "profile", true]],
  ["permissionsetgroups", [".permissionsetgroup", "permissionSetGroup", true]],
  ["layouts", [".layout", "layout", true]],
]);

/** Types read from their one XML file, named by the registry. */
const BY_TYPE: Readonly<Record<string, Kind>> = {
  Report: "report",
  Dashboard: "dashboard",
  ReportType: "reportType",
  NamedCredential: "namedCredential",
  ExternalCredential: "externalCredential",
  RemoteSiteSetting: "remoteSite",
  ConnectedApp: "connectedApp",
  ExternalServiceRegistration: "externalService",
  PlatformEventChannel: "eventChannel",
  PlatformEventChannelMember: "eventChannelMember",
  Workflow: "workflow",
  // workflows/Account/workflowOutboundMessages/Notify_ERP.workflowOutboundMessage-meta.xml
  WorkflowOutboundMessage: "outboundMessage",
  // customMetadata/CIM_Client_Field.Account_Name.md(-meta.xml)
  CustomMetadata: "customMetadata",
  // sharingRules/Case.sharingRules, roles/CEO.role, groups/Care_EU.group, queues/Care_Store.queue
  SharingRules: "sharingRules",
  Role: "role",
  Group: "group",
  Queue: "queue",
};

/** Types read in detail: every other one is indexed by name and file. */
const DETAILED = new Set<string>(COMPONENT_TYPES);

/** What a file is, from its name and the folders around it, or undefined. */
export function classify(rel: string): { kind: Kind; object: string; child?: string; type?: string } | undefined {
  // A file in a folder another type owns (an expanded static resource's classes/Foo.cls) is
  // that type's.
  const match = classifyFile(rel);
  const owner = match?.type;
  if (owner && !DETAILED.has(owner)) return undefined;
  // pages/Foo.page, components/Foo.component, email/Folder/Foo.email: read from the markup;
  // their -meta.xml files are the same component.
  if (match && Object.hasOwn(MARKUP_SUFFIX, match.type)) return rel.endsWith(MARKUP_SUFFIX[match.type]!) ? { kind: "markup", object: match.name, type: match.type } : undefined;
  // reports/Sales/Q1/Pipeline.report(-meta.xml), namedCredentials/Foo.namedCredential...:
  // read from their one XML file, named by the registry (in folders people name, for reports).
  if (match && Object.hasOwn(BY_TYPE, match.type)) return { kind: BY_TYPE[match.type]!, object: match.name };
  const parts = rel.split("/");
  const base = parts.at(-1)!;
  const dir = parts.at(-2);
  const up = parts.at(-3);
  const upper = parts.at(-4);
  // flows/Renewal.flow-meta.xml (source) or flows/Renewal.flow (metadata format),
  // classes/Foo.cls; the name travels in `object`. Source format lets these sit in any folder
  // (classes/services/Foo.cls); metadata format keeps them right in their own.
  for (const [folder, [suffix, kind, xml]] of TOP_LEVEL) {
    const meta = `${suffix}-meta.xml`;
    if (xml && base.endsWith(meta) && base.length > meta.length) return { kind, object: base.slice(0, -meta.length) };
    if (base.endsWith(suffix) && base.length > suffix.length && (dir === folder || !xml)) return { kind, object: base.slice(0, -suffix.length) };
  }
  // metadata format: objects/Account.object
  if (dir === "objects" && base.endsWith(".object") && base.length > ".object".length) return { kind: "mdapiObject", object: base.slice(0, -".object".length) };
  // source format: objects/Account/Account.object-meta.xml
  if (up === "objects" && dir && base === `${dir}.object-meta.xml`) return { kind: "object", object: dir };
  // source format children: objects/Account/fields/Industry.field-meta.xml
  if (upper === "objects" && up) {
    const children: Record<string, [string, Kind]> = {
      fields: [".field-meta.xml", "field"],
      recordTypes: [".recordType-meta.xml", "recordType"],
      validationRules: [".validationRule-meta.xml", "validationRule"],
      fieldSets: [".fieldSet-meta.xml", "fieldSet"],
    };
    const known = dir && Object.hasOwn(children, dir) ? children[dir] : undefined;
    if (known && base.endsWith(known[0]) && base.length > known[0].length) return { kind: known[1], object: up, child: base.slice(0, -known[0].length) };
  }
  return undefined;
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Every file under `start` (relative to `root`, forward slashes). The start folder must be
 * readable, or this throws; a subfolder that is not is reported in `skipped` and passed over.
 * Iterative, so neither a deep tree nor a large one strains the stack.
 */
async function walk(root: string, start: string, files: Set<string>, skip: (file: string, err: unknown) => void, excluded: (rel: string) => boolean = () => false): Promise<void> {
  const stack = [start];
  let first = true;
  while (stack.length) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch (err) {
      if (first) throw err;
      skip(rel, err);
      continue;
    }
    first = false;
    entries.sort(byName);
    // Pushed in reverse so folders come off the stack in name order.
    for (const e of entries.reverse()) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !excluded(child)) stack.push(child);
      } else if (e.isFile()) {
        files.add(child);
        if (files.size > MAX_FILES) throw new Error(`more than ${MAX_FILES.toLocaleString("en")} files: point the index at the Salesforce project folder`);
      }
    }
  }
}

/** A folder from sfdx-project.json, relative and with forward slashes, or undefined if it leaves the project. */
export function packagePath(p: string): string | undefined {
  const norm = path.posix.normalize(p.replace(/\\/g, "/")).replace(/\/+$/, "");
  if (norm === "." || norm === "") return "";
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm) || norm === ".." || norm.startsWith("../")) return undefined;
  return norm.replace(/^\.\//, "");
}

/** The package folders of a project's sfdx-project.json, with their package names; undefined without one. */
async function projectPackages(root: string): Promise<{ path: string; name?: string }[] | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(root, "sfdx-project.json"), "utf8");
  } catch {
    return undefined;
  }
  let project: { packageDirectories?: { path?: unknown; package?: unknown }[] };
  try {
    project = JSON.parse(text) as typeof project;
  } catch {
    throw new Error("sfdx-project.json is not valid JSON");
  }
  return (Array.isArray(project.packageDirectories) ? project.packageDirectories : []).flatMap((d) => {
    const at = typeof d?.path === "string" ? packagePath(d.path) : undefined;
    return at === undefined ? [] : [{ path: at, ...(typeof d.package === "string" ? { name: d.package } : {}) }];
  });
}

/** Folders with one inside another read once, with the outer one. */
const outermost = (dirs: string[]) => [...new Set(dirs)].filter((d, _, all) => !all.some((o) => o !== d && (o === "" || d.startsWith(`${o}/`))));

/**
 * The package folders to read: those an sfdx-project.json names, or the whole root without
 * one. With `only`, just those, each given by its package name, its path, or a folder that
 * holds package folders (row-app for row-app/force-app and row-app/care-app), and read in the
 * file's order; a folder the file does not name is read through its own sfdx-project.json,
 * or whole.
 */
async function packageDirs(root: string, only?: readonly string[]): Promise<string[]> {
  const listed = (await projectPackages(root)) ?? [];
  if (!only?.length) {
    const dirs = listed.map((d) => d.path);
    return dirs.length ? outermost(dirs) : [""];
  }
  const picked = new Set<string>();
  const others: string[] = [];
  for (const asked of only) {
    const named = listed.find((d) => d.name === asked);
    const at = named?.path ?? packagePath(asked);
    if (at === undefined || at === "") throw new Error(`"${asked}" is not a folder inside the project.`);
    const under = listed.filter((d) => d.path === at || d.path.startsWith(`${at}/`));
    if (under.length) {
      for (const d of under) picked.add(d.path);
      continue;
    }
    const isDir = await stat(path.join(root, at)).then((s) => s.isDirectory(), () => false);
    if (!isDir) throw new Error(`"${asked}" is neither a package of sfdx-project.json nor a folder of the project.`);
    // A sub-folder with its own sfdx-project.json: its package folders, else the whole sub-folder.
    const own = (await projectPackages(path.join(root, at)))?.map((d) => (d.path ? `${at}/${d.path}` : at));
    others.push(...(own?.length ? own : [at]));
  }
  return outermost([...listed.map((d) => d.path).filter((d) => picked.has(d)), ...others]);
}

/**
 * Reads the objects, fields, record types and validation rules of a project in detail, and
 * every other component the metadata registry knows by name and file. A file or
 * subfolder that cannot be read is skipped and reported, and the rest still indexes. If the
 * project folder or one of its package folders cannot be read at all, this throws: an
 * empty result would otherwise replace a good index.
 */
export async function scanProject(root: string, options: { exclude?: readonly string[]; cache?: ParseCache; packages?: readonly string[] } = {}): Promise<ParsedMetadata> {
  // Folders not to read, such as the workspace when it sits in the project.
  const excludedDirs = new Set((options.exclude ?? []).map((d) => path.resolve(d)));
  const excluded = (rel: string) => excludedDirs.size > 0 && excludedDirs.has(path.resolve(root, rel));
  const components: ParsedComponent[] = [];
  const skipped: ParsedMetadata["skipped"] = [];
  let skippedCount = 0;
  // Error messages carry absolute paths (and so the user's name): keep them relative.
  const reason = (err: unknown) => ((err as Error)?.message ?? String(err)).split(root).join(".");
  let read = 0;
  let reused = 0;
  const skip = (file: string, why: string) => {
    skippedCount++;
    if (skipped.length < MAX_SKIPPED_LISTED) skipped.push({ file, reason: why });
  };

  const seen = new Map<string, number>();
  /** Objects made up for folders that hold only fields, until their own file turns up. */
  const standIns = new Set<string>();
  const add = (c: ParsedComponent, file: string) => {
    const key = componentKey(c.type, c.name);
    const at = seen.get(key);
    if (at !== undefined && standIns.delete(key)) {
      components[at] = c;
      return;
    }
    if (at !== undefined) return skip(file, `${c.type} ${c.name} is also defined in ${components[at]!.file ?? "another file"}`);
    seen.set(key, components.length);
    components.push(c);
  };

  /** Where each component found by the registry was found: its type's folder. */
  const homes = new Map<string, string>();
  /** A file read in detail: its other files (Foo.cls-meta.xml) are the same component. */
  const knownHome = (file: string) => {
    const m = classifyFile(file);
    if (m && !homes.has(componentKey(m.type, m.name))) homes.set(componentKey(m.type, m.name), m.home);
  };

  /** The links custom metadata records give their type, by type. */
  const mappings = new Map<string, { refs: Ref[]; records: number }>();
  const files = new Set<string>();
  for (const dir of await packageDirs(root, options.packages)) {
    try {
      await walk(root, dir, files, (f, err) => skip(f, reason(err)), excluded);
    } catch (err) {
      throw new Error(`${dir || "the project folder"} cannot be read: ${reason(err)}`);
    }
  }

  /** An object a child stands in, kept as part of the project until its own file turns up. */
  const standIn = (object: string, folder: string) => {
    const objectKey = componentKey("CustomObject", object);
    if (seen.has(objectKey)) return;
    add({ type: "CustomObject", name: object, file: folder, attrs: { custom: isCustomName(object) }, text: "" }, folder);
    standIns.add(objectKey);
  };

  for (const file of [...files].sort()) {
    const what = classify(file);
    if (!what) {
      // Every other type the registry knows: indexed by name and file.
      const match = classifyFile(file);
      // A component's files (Foo.cls and Foo.cls-meta.xml, a bundle's) share its type's
      // folder; the same name in another folder is a second definition, and reported.
      const key = match && componentKey(match.type, match.name);
      if (match && key && homes.get(key) !== match.home) {
        if (!seen.has(key)) homes.set(key, match.home);
        add({ type: match.type, name: match.name, file, attrs: {}, text: "", ...(match.parent ? { parent: match.parent, parentType: match.parentType } : {}) }, file);
        if (match.parent && match.parentType === "CustomObject") standIn(match.parent, file.split("/").slice(0, -2).join("/"));
      }
      continue;
    }
    try {
      const size = (await stat(path.join(root, file))).size;
      if (size > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      const content = await readFile(path.join(root, file), "utf8");
      if (what.kind === "customMetadata") {
        // A record is read every run and never cached nor kept: only what it names is, as links of its type.
        const dot = what.object.indexOf(".");
        if (dot > 0) {
          const type = `${what.object.slice(0, dot)}__mdt`;
          const found = mappings.get(type) ?? { refs: [], records: 0 };
          found.refs.push(...readCustomMetadataRecord(obj(parseMetadataXml(content).CustomMetadata)));
          found.records++;
          mappings.set(type, found);
        }
        continue;
      }
      // A template's subject and plain text, in its -meta.xml, hold merge fields too.
      let meta = "";
      if (what.kind === "markup" && what.type === "EmailTemplate" && files.has(`${file}-meta.xml`)) {
        meta = await readFile(path.join(root, `${file}-meta.xml`), "utf8").catch(() => "");
        if (meta.length > MAX_FILE_BYTES) meta = "";
      }
      // An unchanged file is not parsed again: its components come from the last run.
      const hash = options.cache && createHash("sha256").update(`${content.length}:`).update(content).update(meta).digest("hex");
      let parsed = hash ? options.cache!.get(file, hash) : undefined;
      if (parsed) reused++;
      else {
        parsed = readComponents(what, file, content, meta);
        read++;
      }
      if (hash) options.cache!.put(file, hash, parsed);
      const children = what.kind === "object" || what.kind === "mdapiObject";
      for (const [i, c] of parsed.entries()) {
        // An object's children without a name are left out, as before the cache.
        if (children && i > 0 && c.name.endsWith(".")) skip(file, `a ${c.type} without a name`);
        else add(c, file);
      }
      knownHome(file);
      // A source-format object folder may hold only fields (a standard object the project
      // extends): the object is still part of the project.
      if (what.kind === "field" || what.kind === "recordType" || what.kind === "validationRule" || what.kind === "fieldSet") standIn(what.object, file.split("/").slice(0, -2).join("/"));
    } catch (err) {
      skip(file, reason(err));
      // A file of a type read from its one XML file that is too large or broken to read is
      // still in the project, by name (an external service with a huge schema), as it was
      // before the type was read in detail: what points at it does not find it missing.
      const match = classifyFile(file);
      const key = match && componentKey(match.type, match.name);
      if (match && key && Object.hasOwn(BY_TYPE, match.type) && match.type !== "CustomMetadata" && !seen.has(key) && homes.get(key) === undefined) {
        homes.set(key, match.home);
        add({ type: match.type, name: match.name, file, attrs: {}, text: "", ...(match.parent ? { parent: match.parent, parentType: match.parentType } : {}) }, file);
      }
    }
  }

  // What the records of each custom metadata type name goes to the type, with how many it has.
  for (const [type, { refs, records }] of mappings) {
    const at = seen.get(componentKey("CustomObject", type));
    if (at === undefined) continue;
    const c = components[at]!;
    components[at] = { ...c, attrs: { ...c.attrs, records }, refs: [...(c.refs ?? []), ...refs] };
  }
  const { edges, missing } = linkObjects(components);
  for (const m of missing) components.push({ type: m.type, name: m.name, ...(m.parent ? { parent: m.parent } : {}), missing: true, attrs: {}, text: "" });
  return { components, edges, skipped, ...(skippedCount > skipped.length ? { skippedCount } : {}), ...(options.cache ? { files: { read, reused } } : {}) };
}

/** The components one file read in detail holds, in the order they are added. */
function readComponents(what: NonNullable<ReturnType<typeof classify>>, file: string, content: string, meta: string): ParsedComponent[] {
  if (what.kind === "markup") {
    let extra = "";
    if (meta) {
      try {
        const t = obj(parseMetadataXml(meta).EmailTemplate);
        extra = [t.subject, t.textOnly].filter((v): v is string => typeof v === "string").join("\n");
      } catch {
        // An unreadable -meta.xml leaves the body's merge fields.
      }
    }
    return [readMarkup(what.type!, what.object, content, file, extra)];
  }
  if (what.kind === "apexClass" || what.kind === "apexTrigger") return [readApex(what.kind === "apexClass" ? "ApexClass" : "ApexTrigger", what.object, content, file)];
  const doc = parseMetadataXml(content);
  const named = (el: Record<string, unknown>) => ({ ...el, fullName: el.fullName ?? what.child });
  switch (what.kind) {
    case "mdapiObject":
    case "object":
      return readObject(what.object, obj(doc.CustomObject), file);
    case "field":
      return [readField(what.object, named(obj(doc.CustomField)), file)];
    case "recordType":
      return [readRecordType(what.object, named(obj(doc.RecordType)), file)];
    case "validationRule":
      return [readValidationRule(what.object, named(obj(doc.ValidationRule)), file)];
    case "fieldSet":
      return [readFieldSet(what.object, named(obj(doc.FieldSet)), file)];
    case "flow":
      return [readFlow(what.object, obj(doc.Flow), file)];
    case "permissionSet":
      return [readPermissions("PermissionSet", what.object, obj(doc.PermissionSet), file)];
    case "profile":
      return [readPermissions("Profile", what.object, obj(doc.Profile), file)];
    case "permissionSetGroup":
      return [readPermissionSetGroup(what.object, obj(doc.PermissionSetGroup), file)];
    case "layout":
      return [readLayout(what.object, obj(doc.Layout), file)];
    case "report":
      return [readReport(what.object, obj(doc.Report), file)];
    case "dashboard":
      return [readDashboard(what.object, obj(doc.Dashboard), file)];
    case "reportType":
      return [readReportType(what.object, obj(doc.ReportType), file)];
    case "namedCredential":
      return [readNamedCredential(what.object, obj(doc.NamedCredential), file)];
    case "externalCredential":
      return [readExternalCredential(what.object, obj(doc.ExternalCredential), file)];
    case "remoteSite":
      return [readRemoteSiteSetting(what.object, obj(doc.RemoteSiteSetting), file)];
    case "connectedApp":
      return [readConnectedApp(what.object, obj(doc.ConnectedApp), file)];
    case "externalService":
      return [readExternalService(what.object, obj(doc.ExternalServiceRegistration), file)];
    case "eventChannel":
      return [readPlatformEventChannel(what.object, obj(doc.PlatformEventChannel), file)];
    case "eventChannelMember":
      return [readPlatformEventChannelMember(what.object, obj(doc.PlatformEventChannelMember), file)];
    case "workflow":
      return readWorkflow(what.object, obj(doc.Workflow), file);
    case "sharingRules":
      return [readSharingRules(what.object, obj(doc.SharingRules), file)];
    case "role":
      return [readRole(what.object, obj(doc.Role), file)];
    case "group":
      return [readGroup(what.object, obj(doc.Group), file)];
    case "queue":
      return [readQueue(what.object, obj(doc.Queue), file)];
    case "outboundMessage": {
      const dot = what.object.indexOf(".");
      return dot > 0 ? [readOutboundMessage(what.object.slice(0, dot), what.object.slice(dot + 1), obj(doc.WorkflowOutboundMessage), file)] : [];
    }
  }
  return [];
}
