import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

export interface FieldInfo {
  name: string;
  label?: string;
  type?: string;
  referenceTo?: string;
  required?: boolean;
}

export interface ObjectInfo {
  name: string;
  label?: string;
  custom: boolean;
  fields: FieldInfo[];
}

export interface FlowInfo {
  name: string;
  label?: string;
  processType?: string;
  status?: string;
  triggerObject?: string;
  triggerType?: string;
}

export interface ApexInfo {
  name: string;
  isTest: boolean;
  lines: number;
}

export interface TriggerInfo {
  name: string;
  object?: string;
  events: string[];
}

export interface MetadataInventory {
  root: string;
  packageDirectories: string[];
  objects: ObjectInfo[];
  flows: FlowInfo[];
  apexClasses: ApexInfo[];
  triggers: TriggerInfo[];
  lwc: string[];
  aura: string[];
  permissionSets: string[];
  /** Count of every metadata type found, keyed by its file suffix (e.g. "layout"). */
  typeCounts: Record<string, number>;
}

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

/**
 * Scans a Salesforce DX project (source format) and summarises what already
 * exists, so the SA agent can assess the impact of a change on the org.
 */
export async function buildInventory(root: string): Promise<MetadataInventory> {
  const packageDirectories = await readPackageDirectories(root);
  const inv: MetadataInventory = {
    root,
    packageDirectories,
    objects: [],
    flows: [],
    apexClasses: [],
    triggers: [],
    lwc: [],
    aura: [],
    permissionSets: [],
    typeCounts: {},
  };
  const objects = new Map<string, ObjectInfo>();
  const objectFor = (name: string): ObjectInfo => {
    let o = objects.get(name);
    if (!o) {
      o = { name, custom: name.endsWith("__c") || name.endsWith("__mdt") || name.endsWith("__e"), fields: [] };
      objects.set(name, o);
    }
    return o;
  };

  for (const dir of packageDirectories) {
    for (const file of await walk(path.join(root, dir))) {
      const base = path.basename(file);
      const parent = path.basename(path.dirname(file));

      if (parent !== "lwc" && path.basename(path.dirname(path.dirname(file))) === "lwc") {
        if (base.endsWith(".js-meta.xml")) inv.lwc.push(parent);
        continue;
      }
      if (path.basename(path.dirname(path.dirname(file))) === "aura") {
        if (base.endsWith(".cmp") || base.endsWith(".app")) inv.aura.push(parent);
        continue;
      }

      if (base.endsWith(".cls")) {
        const src = await readFile(file, "utf8");
        inv.apexClasses.push({ name: base.slice(0, -4), isTest: /@istest/i.test(src), lines: src.split("\n").length });
        continue;
      }
      if (base.endsWith(".trigger")) {
        const src = await readFile(file, "utf8");
        const m = src.match(/trigger\s+\w+\s+on\s+(\w+)\s*\(([^)]*)\)/i);
        inv.triggers.push({
          name: base.slice(0, -8),
          object: m?.[1],
          events: m ? m[2].split(",").map((e) => e.trim().toLowerCase()) : [],
        });
        continue;
      }

      const typeMatch = base.match(/\.([\w]+)-meta\.xml$/);
      if (!typeMatch) continue;
      const type = typeMatch[1];
      const name = base.slice(0, -typeMatch[0].length);
      inv.typeCounts[type] = (inv.typeCounts[type] ?? 0) + 1;

      if (type === "object") {
        const doc = await parseXml(file);
        objectFor(name).label = doc?.CustomObject?.label;
      } else if (type === "field" && parent === "fields") {
        const objectName = path.basename(path.dirname(path.dirname(file)));
        const f = (await parseXml(file))?.CustomField ?? {};
        objectFor(objectName).fields.push({
          name,
          label: f.label,
          type: f.type,
          referenceTo: f.referenceTo,
          required: f.required === "true" || undefined,
        });
      } else if (type === "flow") {
        const f = (await parseXml(file))?.Flow ?? {};
        inv.flows.push({
          name,
          label: f.label,
          processType: f.processType,
          status: f.status,
          triggerObject: f.start?.object,
          triggerType: f.start?.recordTriggerType ?? f.start?.triggerType,
        });
      } else if (type === "permissionset") {
        inv.permissionSets.push(name);
      }
    }
  }

  inv.objects = [...objects.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const o of inv.objects) o.fields.sort((a, b) => a.name.localeCompare(b.name));
  inv.lwc = [...new Set(inv.lwc)].sort();
  inv.aura = [...new Set(inv.aura)].sort();
  return inv;
}

/** Renders the inventory as Markdown, which is what goes into the requirement context. */
export function inventoryToMarkdown(inv: MetadataInventory, maxFieldsPerObject = 50): string {
  const lines: string[] = [];
  lines.push(`# Metadata inventory`, ``, `Package directories: ${inv.packageDirectories.join(", ")}`, ``);

  lines.push(`## Objects (${inv.objects.length})`);
  for (const o of inv.objects) {
    lines.push(``, `### ${o.name}${o.label ? ` (${o.label})` : ""}`);
    for (const f of o.fields.slice(0, maxFieldsPerObject)) {
      const ref = f.referenceTo ? ` -> ${f.referenceTo}` : "";
      lines.push(`- ${f.name}: ${f.type ?? "?"}${ref}${f.required ? ", required" : ""}${f.label ? ` "${f.label}"` : ""}`);
    }
    if (o.fields.length > maxFieldsPerObject) lines.push(`- ... ${o.fields.length - maxFieldsPerObject} more fields`);
  }

  lines.push(``, `## Flows (${inv.flows.length})`);
  for (const f of inv.flows) {
    const trigger = f.triggerObject ? ` on ${f.triggerObject}${f.triggerType ? ` (${f.triggerType})` : ""}` : "";
    lines.push(`- ${f.name}: ${f.processType ?? "?"}${trigger}, ${f.status ?? "unknown status"}`);
  }

  const tests = inv.apexClasses.filter((c) => c.isTest).length;
  lines.push(``, `## Apex classes (${inv.apexClasses.length}, of which ${tests} tests)`);
  for (const c of inv.apexClasses.filter((c) => !c.isTest)) lines.push(`- ${c.name} (${c.lines} lines)`);

  lines.push(``, `## Triggers (${inv.triggers.length})`);
  for (const t of inv.triggers) lines.push(`- ${t.name} on ${t.object ?? "?"}: ${t.events.join(", ")}`);

  lines.push(``, `## Lightning Web Components (${inv.lwc.length})`, inv.lwc.join(", ") || "none");
  if (inv.aura.length) lines.push(``, `## Aura components (${inv.aura.length})`, inv.aura.join(", "));
  lines.push(``, `## Permission sets (${inv.permissionSets.length})`, inv.permissionSets.join(", ") || "none");

  lines.push(``, `## Metadata type counts`);
  for (const [type, n] of Object.entries(inv.typeCounts).sort()) lines.push(`- ${type}: ${n}`);
  return lines.join("\n");
}

async function readPackageDirectories(root: string): Promise<string[]> {
  try {
    const project = JSON.parse(await readFile(path.join(root, "sfdx-project.json"), "utf8"));
    const dirs = (project.packageDirectories ?? []).map((d: { path: string }) => d.path).filter(Boolean);
    if (dirs.length) return dirs;
  } catch {
    // Not an SFDX project file; fall back to scanning the whole folder.
  }
  return ["."];
}

async function parseXml(file: string): Promise<Record<string, any> | undefined> {
  try {
    return xml.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}
