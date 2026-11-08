// Reads a Salesforce project folder, in source format (sfdx) or metadata format (mdapi),
// into components and edges for the index.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { COMPONENT_TYPES, type ParsedComponent, type ParsedMetadata } from "./model.js";
import { componentKey, isCustomName, linkObjects, readField, readFieldSet, readObject, readRecordType, readValidationRule } from "./objects.js";
import { MARKUP_SUFFIX, readMarkup } from "./markup.js";
import { readFlow } from "./flows.js";
import { readApex } from "./apex.js";
import { readLayout, readPermissions, readPermissionSetGroup } from "./access.js";
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
  | "apexClass" | "apexTrigger" | "permissionSet" | "profile" | "permissionSetGroup" | "layout" | "fieldSet" | "markup";

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

/** The package folders an sfdx-project.json names, or the whole root without one. */
async function packageDirs(root: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path.join(root, "sfdx-project.json"), "utf8");
  } catch {
    return [""]; // not an sfdx project: read the whole folder
  }
  let project: { packageDirectories?: { path?: unknown }[] };
  try {
    project = JSON.parse(text) as typeof project;
  } catch {
    throw new Error("sfdx-project.json is not valid JSON");
  }
  const dirs = (Array.isArray(project.packageDirectories) ? project.packageDirectories : [])
    .map((d) => (typeof d?.path === "string" ? packagePath(d.path) : undefined))
    .filter((d): d is string => d !== undefined);
  if (!dirs.length) return [""];
  // A folder inside another is read once, with the outer one.
  return dirs.filter((d) => !dirs.some((o) => o !== d && (o === "" || d.startsWith(`${o}/`))));
}

/**
 * Reads the objects, fields, record types and validation rules of a project in detail, and
 * every other component the metadata registry knows by name and file. A file or
 * subfolder that cannot be read is skipped and reported, and the rest still indexes. If the
 * project folder or one of its package folders cannot be read at all, this throws: an
 * empty result would otherwise replace a good index.
 */
export async function scanProject(root: string, options: { exclude?: readonly string[] } = {}): Promise<ParsedMetadata> {
  // Folders not to read, such as the workspace when it sits in the project.
  const excludedDirs = new Set((options.exclude ?? []).map((d) => path.resolve(d)));
  const excluded = (rel: string) => excludedDirs.size > 0 && excludedDirs.has(path.resolve(root, rel));
  const components: ParsedComponent[] = [];
  const skipped: ParsedMetadata["skipped"] = [];
  let skippedCount = 0;
  // Error messages carry absolute paths (and so the user's name): keep them relative.
  const reason = (err: unknown) => ((err as Error)?.message ?? String(err)).split(root).join(".");
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

  const files = new Set<string>();
  for (const dir of await packageDirs(root)) {
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
      if (what.kind === "markup") {
        add(readMarkup(what.type!, what.object, content, file), file);
        knownHome(file);
        continue;
      }
      if (what.kind === "apexClass" || what.kind === "apexTrigger") {
        add(readApex(what.kind === "apexClass" ? "ApexClass" : "ApexTrigger", what.object, content, file), file);
        knownHome(file);
        continue;
      }
      const doc = parseMetadataXml(content);
      const named = (el: Record<string, unknown>) => ({ ...el, fullName: el.fullName ?? what.child });
      switch (what.kind) {
        case "mdapiObject":
        case "object": {
          const [object, ...children] = readObject(what.object, obj(doc.CustomObject), file);
          add(object!, file);
          for (const c of children) {
            if (c.name.endsWith(".")) skip(file, `a ${c.type} without a name`);
            else add(c, file);
          }
          break;
        }
        case "field":
          add(readField(what.object, named(obj(doc.CustomField)), file), file);
          break;
        case "recordType":
          add(readRecordType(what.object, named(obj(doc.RecordType)), file), file);
          break;
        case "validationRule":
          add(readValidationRule(what.object, named(obj(doc.ValidationRule)), file), file);
          break;
        case "fieldSet":
          add(readFieldSet(what.object, named(obj(doc.FieldSet)), file), file);
          break;
        case "flow":
          add(readFlow(what.object, obj(doc.Flow), file), file);
          break;
        case "permissionSet":
          add(readPermissions("PermissionSet", what.object, obj(doc.PermissionSet), file), file);
          break;
        case "profile":
          add(readPermissions("Profile", what.object, obj(doc.Profile), file), file);
          break;
        case "permissionSetGroup":
          add(readPermissionSetGroup(what.object, obj(doc.PermissionSetGroup), file), file);
          break;
        case "layout":
          add(readLayout(what.object, obj(doc.Layout), file), file);
          break;
      }
      knownHome(file);
      // A source-format object folder may hold only fields (a standard object the project
      // extends): the object is still part of the project.
      if (what.kind === "field" || what.kind === "recordType" || what.kind === "validationRule" || what.kind === "fieldSet") standIn(what.object, file.split("/").slice(0, -2).join("/"));
    } catch (err) {
      skip(file, reason(err));
    }
  }

  const { edges, missing } = linkObjects(components);
  for (const m of missing) components.push({ type: m.type, name: m.name, ...(m.parent ? { parent: m.parent } : {}), missing: true, attrs: {}, text: "" });
  return { components, edges, skipped, ...(skippedCount > skipped.length ? { skippedCount } : {}) };
}
