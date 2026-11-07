// Reads a Salesforce project folder, in source format (sfdx) or metadata format (mdapi),
// into components and edges for the index.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ParsedComponent, ParsedMetadata } from "./model.js";
import { linkObjects, readField, readObject, readRecordType, readValidationRule } from "./objects.js";
import { obj, parseMetadataXml } from "./xml.js";

/** Folders never read: tools' caches and dependencies, not metadata. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".sf", ".sfdx", ".vscode", ".idea", ".husky"]);
/** Larger files are skipped and reported: no object or field file comes near this. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

type Kind = "object" | "field" | "recordType" | "validationRule" | "mdapiObject";

/** What a file is, from its name and the folders around it, or undefined. */
export function classify(rel: string): { kind: Kind; object: string; child?: string } | undefined {
  const parts = rel.split("/");
  const base = parts.at(-1)!;
  const dir = parts.at(-2);
  const up = parts.at(-3);
  const upper = parts.at(-4);
  // metadata format: objects/Account.object
  if (dir === "objects" && base.endsWith(".object")) return { kind: "mdapiObject", object: base.slice(0, -".object".length) };
  // source format: objects/Account/Account.object-meta.xml
  if (up === "objects" && dir && base === `${dir}.object-meta.xml`) return { kind: "object", object: dir };
  // source format children: objects/Account/fields/Industry.field-meta.xml
  if (upper === "objects" && up) {
    const children: Record<string, [string, Kind]> = {
      fields: [".field-meta.xml", "field"],
      recordTypes: [".recordType-meta.xml", "recordType"],
      validationRules: [".validationRule-meta.xml", "validationRule"],
    };
    const known = dir ? children[dir] : undefined;
    if (known && base.endsWith(known[0])) return { kind: known[1], object: up, child: base.slice(0, -known[0].length) };
  }
  return undefined;
}

/** Every file under `root`, relative and with forward slashes, in a stable order. */
async function walk(root: string, rel = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: string[] = [];
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await walk(root, child)));
    } else if (e.isFile()) out.push(child);
  }
  return out;
}

/** The package folders an sfdx-project.json names, or the whole root without one. */
async function packageDirs(root: string): Promise<string[]> {
  try {
    const project = JSON.parse(await readFile(path.join(root, "sfdx-project.json"), "utf8")) as { packageDirectories?: { path?: unknown }[] };
    const dirs = (project.packageDirectories ?? [])
      .map((d) => (typeof d.path === "string" ? d.path.replace(/\\/g, "/").replace(/^\.\/|\/+$/g, "") : ""))
      .filter((d) => d && !d.split("/").includes(".."));
    if (dirs.length) return dirs;
  } catch {
    // Not an sfdx project, or an unreadable one: read the whole folder.
  }
  return [""];
}

/**
 * Reads the objects, fields, record types and validation rules of a project. A file that
 * cannot be read or parsed is skipped and reported; the rest of the project still indexes.
 */
export async function scanProject(root: string): Promise<ParsedMetadata> {
  const components: ParsedComponent[] = [];
  const skipped: ParsedMetadata["skipped"] = [];
  const seen = new Map<string, number>();
  /** Objects made up for folders that hold only fields, until their own file turns up. */
  const standIns = new Set<string>();
  const add = (c: ParsedComponent, file: string) => {
    const key = `${c.type}:${c.name}`;
    const at = seen.get(key);
    if (at !== undefined && standIns.delete(key)) {
      components[at] = c;
      return;
    }
    if (c.name.endsWith(".") || at !== undefined) {
      skipped.push({ file, reason: c.name.endsWith(".") ? `a ${c.type} without a name` : `${c.type} ${c.name} is also defined elsewhere` });
      return;
    }
    seen.set(key, components.length);
    components.push(c);
  };

  const files = new Set<string>();
  for (const dir of await packageDirs(root)) {
    try {
      for (const f of await walk(root, dir)) files.add(f);
    } catch (err) {
      skipped.push({ file: dir || ".", reason: (err as Error).message });
    }
  }
  for (const file of [...files].sort()) {
    const what = classify(file);
    if (!what) continue;
    try {
      const size = (await stat(path.join(root, file))).size;
      if (size > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      const doc = parseMetadataXml(await readFile(path.join(root, file), "utf8"));
      switch (what.kind) {
        case "mdapiObject":
        case "object": {
          const [object, ...children] = readObject(what.object, obj(doc.CustomObject), file);
          add(object!, file);
          for (const c of children) add(c, file);
          break;
        }
        case "field": {
          const el = obj(doc.CustomField);
          add(readField(what.object, { ...el, fullName: el.fullName ?? what.child }, file), file);
          break;
        }
        case "recordType": {
          const el = obj(doc.RecordType);
          add(readRecordType(what.object, { ...el, fullName: el.fullName ?? what.child }, file), file);
          break;
        }
        case "validationRule": {
          const el = obj(doc.ValidationRule);
          add(readValidationRule(what.object, { ...el, fullName: el.fullName ?? what.child }, file), file);
          break;
        }
      }
      // A source-format object folder may hold only fields (a standard object the project
      // extends): the object is still part of the project.
      if (what.kind !== "object" && what.kind !== "mdapiObject" && !seen.has(`CustomObject:${what.object}`)) {
        const folder = file.split("/").slice(0, -2).join("/");
        add({ type: "CustomObject", name: what.object, file: folder, attrs: { custom: /__[a-z]+$/i.test(what.object) }, text: "" }, folder);
        standIns.add(`CustomObject:${what.object}`);
      }
    } catch (err) {
      skipped.push({ file, reason: (err as Error).message });
    }
  }

  const { edges, missing } = linkObjects(components);
  for (const m of missing) components.push({ type: m.type, name: m.name, ...(m.parent ? { parent: m.parent } : {}), missing: true, attrs: {}, text: "" });
  return { components, edges, skipped };
}
