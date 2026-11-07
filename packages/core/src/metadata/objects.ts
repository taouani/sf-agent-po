// Objects and their children: fields, record types and validation rules, from either the
// source format (one file per child) or the metadata format (children inside the .object).

import type { ComponentType, ParsedComponent, ParsedEdge } from "./model.js";
import { bool, list, num, obj, str } from "./xml.js";

const CUSTOM_SUFFIX = /__(c|mdt|e|b|x|kav|ka|share|history|feed|chgevent)$/i;

const joinText = (...parts: (string | undefined)[]) => parts.filter((p): p is string => !!p && p.trim() !== "").join("\n");

/** An object from its CustomObject element. Children inside it (metadata format) come back too. */
export function readObject(name: string, root: Record<string, unknown>, file: string): ParsedComponent[] {
  const nameField = obj(root.nameField);
  const out: ParsedComponent[] = [
    {
      type: "CustomObject",
      name,
      label: str(root.label),
      file,
      attrs: prune({
        custom: CUSTOM_SUFFIX.test(name),
        pluralLabel: str(root.pluralLabel),
        sharingModel: str(root.sharingModel),
        externalSharingModel: str(root.externalSharingModel),
        deploymentStatus: str(root.deploymentStatus),
        nameField: str(nameField.type) ? prune({ label: str(nameField.label), type: str(nameField.type) }) : undefined,
        enableHistory: bool(root.enableHistory),
      }),
      text: joinText(str(root.description)),
    },
  ];
  for (const f of list(root.fields)) out.push(readField(name, obj(f), file));
  for (const r of list(root.recordTypes)) out.push(readRecordType(name, obj(r), file));
  for (const v of list(root.validationRules)) out.push(readValidationRule(name, obj(v), file));
  return out.filter((c) => c.name !== `${name}.`);
}

export function readField(object: string, f: Record<string, unknown>, file: string): ParsedComponent {
  const field = str(f.fullName) ?? "";
  const valueSet = obj(f.valueSet);
  const values = list(obj(valueSet.valueSetDefinition).value).map(obj);
  const picklist = values.map((v) => prune({ value: str(v.fullName), label: str(v.label), default: bool(v.default) || undefined }));
  return {
    type: "CustomField",
    name: `${object}.${field}`,
    parent: object,
    label: str(f.label),
    file,
    attrs: prune({
      custom: CUSTOM_SUFFIX.test(field),
      type: str(f.type),
      length: num(f.length),
      precision: num(f.precision),
      scale: num(f.scale),
      required: bool(f.required),
      unique: bool(f.unique),
      externalId: bool(f.externalId),
      referenceTo: list(f.referenceTo).map(str).filter((s): s is string => !!s),
      relationshipName: str(f.relationshipName),
      deleteConstraint: str(f.deleteConstraint),
      formula: str(f.formula),
      summaryForeignKey: str(f.summaryForeignKey),
      summaryOperation: str(f.summaryOperation),
      valueSetName: str(valueSet.valueSetName),
      restricted: bool(valueSet.restricted),
      controllingField: str(valueSet.controllingField),
      picklist: picklist.length ? picklist.map(({ value, default: d }) => prune({ value, default: d })) : undefined,
      trackHistory: bool(f.trackHistory),
      encrypted: str(f.encryptionScheme) && str(f.encryptionScheme) !== "None" ? true : undefined,
    }),
    // Picklist labels and values can name people or clients, so they go with the free text.
    text: joinText(str(f.description), str(f.inlineHelpText), ...picklist.map((p) => joinText(p.value as string | undefined, p.label as string | undefined).replace("\n", " "))),
  };
}

export function readRecordType(object: string, r: Record<string, unknown>, file: string): ParsedComponent {
  return {
    type: "RecordType",
    name: `${object}.${str(r.fullName) ?? ""}`,
    parent: object,
    label: str(r.label),
    file,
    attrs: prune({ active: bool(r.active), businessProcess: str(r.businessProcess) }),
    text: joinText(str(r.description)),
  };
}

export function readValidationRule(object: string, v: Record<string, unknown>, file: string): ParsedComponent {
  return {
    type: "ValidationRule",
    name: `${object}.${str(v.fullName) ?? ""}`,
    parent: object,
    file,
    attrs: prune({ active: bool(v.active), formula: str(v.errorConditionFormula), errorDisplayField: str(v.errorDisplayField) }),
    text: joinText(str(v.description), str(v.errorMessage)),
  };
}

/** Relationship names of standard lookups whose target is not the relationship's own name. */
const STANDARD_TARGETS: Record<string, string> = { Owner: "User", CreatedBy: "User", LastModifiedBy: "User" };

const FORMULA_WORDS = new Set(["TRUE", "FALSE", "NULL", "AND", "OR", "NOT"]);

/**
 * The fields a formula uses, as full names. A path through relationships
 * ("Parent__r.Owner.Email") reads each lookup on the way and the field at its end.
 * Functions, string literals, comments and global variables ($User...) are left out.
 */
export function formulaFields(
  formula: string,
  object: string,
  fieldsOf: (object: string) => ReadonlyMap<string, ParsedComponent> | undefined,
): string[] {
  const code = formula
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ");
  const found = new Set<string>();
  for (const m of code.matchAll(/(\$?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)(\s*\()?/g)) {
    const [, path, call] = m;
    if (!path || call || path.startsWith("$")) continue;
    const segs = path.split(".");
    if (segs.length === 1 && FORMULA_WORDS.has(path.toUpperCase())) continue;
    let current: string | undefined = object;
    for (let i = 0; i < segs.length && current; i++) {
      const seg = segs[i]!;
      if (i === segs.length - 1) {
        found.add(`${current}.${seg}`);
        break;
      }
      // A relationship: Parent__r goes through Parent__c, Account through AccountId.
      const custom = /__r$/i.test(seg);
      const lookup = custom ? seg.replace(/__r$/i, "__c") : `${seg}Id`;
      found.add(`${current}.${lookup}`);
      const field: ParsedComponent | undefined = fieldsOf(current)?.get(lookup);
      const targets: string[] = (field?.attrs.referenceTo as string[] | undefined) ?? [];
      // A standard relationship is usually named after its object (Account, Contact).
      current = targets.length === 1 ? targets[0] : targets.length > 1 || custom ? undefined : (STANDARD_TARGETS[seg] ?? seg);
    }
  }
  return [...found];
}

/**
 * The edges between components: each child is part of its object, lookups reference their
 * objects, and formulas and rules read fields. Objects and fields that are referenced but
 * not in the project come back as `missing`, so the index can hold them as placeholders.
 */
export function linkObjects(components: readonly ParsedComponent[]): {
  edges: ParsedEdge[];
  missing: { type: ComponentType; name: string; parent?: string }[];
} {
  const byKey = new Map(components.map((c) => [`${c.type}:${c.name}`, c]));
  const fields = new Map<string, Map<string, ParsedComponent>>();
  for (const c of components) {
    if (c.type !== "CustomField" || !c.parent) continue;
    let m = fields.get(c.parent);
    if (!m) fields.set(c.parent, (m = new Map()));
    m.set(c.name.slice(c.parent.length + 1), c);
  }
  const fieldsOf = (o: string) => fields.get(o) ?? (byKey.has(`CustomObject:${o}`) ? new Map() : undefined);

  const edges: ParsedEdge[] = [];
  const missing = new Map<string, { type: ComponentType; name: string; parent?: string }>();
  const need = (type: ComponentType, name: string, parent?: string) => {
    const key = `${type}:${name}`;
    if (!byKey.has(key) && !missing.has(key)) missing.set(key, { type, name, ...(parent ? { parent } : {}) });
    return { type, name };
  };

  for (const c of components) {
    const from = { type: c.type, name: c.name };
    if (c.parent) edges.push({ from, to: need("CustomObject", c.parent), kind: "part_of" });
    if (c.type === "CustomField") {
      for (const target of (c.attrs.referenceTo as string[] | undefined) ?? []) edges.push({ from, to: need("CustomObject", target), kind: "references" });
    }
    const formula = c.attrs.formula;
    if (typeof formula === "string" && c.parent) {
      for (const field of formulaFields(formula, c.parent, fieldsOf)) {
        if (field === c.name) continue;
        const owner = field.slice(0, field.lastIndexOf("."));
        need("CustomObject", owner);
        edges.push({ from, to: need("CustomField", field, owner), kind: "reads" });
      }
    }
  }
  for (const m of [...missing.values()]) {
    if (m.type === "CustomField" && m.parent) edges.push({ from: { type: m.type, name: m.name }, to: need("CustomObject", m.parent), kind: "part_of" });
  }
  return { edges, missing: [...missing.values()] };
}

/** Drops undefined values and empty arrays, so attrs hold only what the file said. */
function prune<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));
}
