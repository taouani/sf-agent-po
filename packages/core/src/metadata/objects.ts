// Objects and their children: fields, record types and validation rules, from either the
// source format (one file per child) or the metadata format (children inside the .object).

import type { ComponentType, EdgeKind, ParsedComponent, ParsedEdge, Ref } from "./model.js";
import { bool, list, num, obj, str } from "./xml.js";

/** Suffixes of custom names: objects, metadata types, events, person account fields... */
const CUSTOM_SUFFIX = /__(c|mdt|e|b|x|kav|ka|share|history|feed|changeevent|pc|dlm)$/i;
export const isCustomName = (name: string) => CUSTOM_SUFFIX.test(name);

/** Formulas longer than this are not read for references (Salesforce allows 3,900 characters). */
export const MAX_FORMULA_LENGTH = 20_000;

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
        custom: isCustomName(name),
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
  for (const f of list(root.fieldSets)) out.push(readFieldSet(name, obj(f), file));
  return out;
}

/**
 * Whether a value of a custom metadata record can name an object or field: "Account",
 * "Account.Industry", "Segment__c", "ns__Field__c", "AccountId". A name is a custom name, a
 * dotted pair, or words in capitals (CamelCase); a key or token ("AKIAIOSFODNN7EXAMPLE",
 * "k_9f8e7d") is none of these. Shared with the retrieval, which keeps only such values.
 */
export function isNameValue(v: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,79}(?:\.[A-Za-z][A-Za-z0-9_]{0,79})?$/.test(v)) return false;
  return v.includes(".") || /__/.test(v) || /^(?:[A-Z][a-z]+)+$/.test(v);
}

/** A field of a custom metadata type whose values can name objects or fields (Object__c, Target_Field__c, SObject__c). */
const NAMING_FIELD = /object|entity|field|column|source|target|path|api|mapping/i;

/**
 * Whether a custom metadata record's value, in its field, is read as a name: a name in a field
 * named for one (Object__c, Source_Field__c), or a value shaped like an API name wherever it is
 * (Account.Industry, Segment__c). "Event" in Trigger__c or "Dupont" in Owner__c is not.
 */
export function isMappingValue(field: string, value: string): boolean {
  return isNameValue(value) && (NAMING_FIELD.test(field) || value.includes(".") || /__/.test(value));
}

/**
 * The objects and fields a custom metadata record (CIM_Client_Field.Account_Name) names, as
 * links that may be there (may_read), for its type (CIM_Client_Field__mdt), since code reads the
 * type, not the record. Only values of fields named for it (Object__c, Field__c, Source__c...),
 * or shaped like one (Account.Industry, Segment__c), count; the linker keeps only names of what
 * the project has. The record itself is not kept: records hold data, and their names can name
 * clients.
 */
export function readCustomMetadataRecord(root: Record<string, unknown>): Ref[] {
  const values: string[] = [];
  for (const entry of list(root.values)) {
    const e = obj(entry);
    const v = str(e.value)?.trim();
    if (v && isMappingValue(str(e.field) ?? "", v)) values.push(v);
  }
  // The values that may name an object: where a field named alone in the same record may be.
  const objects = [...new Set(values.filter((v) => !v.includes(".")))];
  const refs: Ref[] = [];
  for (const v of new Set(values)) {
    const at = v.indexOf(".");
    if (at > 0) refs.push({ kind: "may_read", field: v.slice(at + 1), among: [v.slice(0, at)] });
    else {
      refs.push({ kind: "may_read", object: v, known: true });
      // A field named alone: on an object the record names, or a custom field one object alone has.
      if (objects.length > 1) refs.push({ kind: "may_read", field: v, among: objects });
      if (/__c$/i.test(v)) refs.push({ kind: "may_read", field: v });
    }
  }
  return refs;
}

/** A field set: the fields it lists, shown wherever a page, component or code uses it. */
export function readFieldSet(object: string, f: Record<string, unknown>, file: string): ParsedComponent {
  const set = str(f.fullName) ?? "";
  const fields = [...list(f.displayedFields), ...list(f.availableFields)].map((x) => str(obj(x).field)).filter((x): x is string => !!x);
  return {
    type: "FieldSet",
    name: `${object}.${set}`,
    parent: object,
    label: str(f.label),
    file,
    attrs: prune({ fields: list(f.displayedFields).length || undefined }),
    refs: [...new Set(fields)].map((path) => ({ kind: "shows" as const, object, path })),
    text: joinText(str(f.description)),
  };
}

export function readField(object: string, f: Record<string, unknown>, file: string): ParsedComponent {
  const field = str(f.fullName) ?? "";
  const valueSet = obj(f.valueSet);
  const values = list(obj(valueSet.valueSetDefinition).value).map(obj);
  return {
    type: "CustomField",
    name: `${object}.${field}`,
    parent: object,
    label: str(f.label),
    file,
    attrs: prune({
      custom: isCustomName(field),
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
      summarizedField: str(f.summarizedField),
      summaryForeignKey: str(f.summaryForeignKey),
      summaryOperation: str(f.summaryOperation),
      valueSetName: str(valueSet.valueSetName),
      restricted: bool(valueSet.restricted),
      controllingField: str(valueSet.controllingField),
      // Only how many: the values and labels can name people or clients, so they are free text.
      picklistValues: values.length || undefined,
      trackHistory: bool(f.trackHistory),
      encrypted: str(f.encryptionScheme) && str(f.encryptionScheme) !== "None" ? true : undefined,
    }),
    text: joinText(
      str(f.description),
      str(f.inlineHelpText),
      ...values.map((v) => {
        const value = str(v.fullName);
        const label = str(v.label);
        return label && value && label !== value ? `${value} (${label})` : (value ?? label);
      }),
    ),
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

/**
 * Where standard relationships lead. null: the relationship is polymorphic (Who, What) and
 * a formula cannot follow it without a type; "self": the object the formula is on.
 */
const STANDARD_RELATIONSHIPS: Record<string, string | null> = {
  owner: "User",
  createdby: "User",
  lastmodifiedby: "User",
  manager: "User",
  delegatedapprover: "User",
  reportsto: "Contact",
  parent: "self",
  masterrecord: "self",
  who: null,
  what: null,
};

/** Standard objects a relationship of the same name leads to. */
const STANDARD_OBJECTS = new Set(
  [
    "Account", "AccountContactRelation", "Asset", "AssignedResource", "Attachment", "BusinessHours", "Campaign", "CampaignMember", "Case",
    "CaseComment", "Contact", "ContentDocument", "ContentDocumentLink", "ContentVersion", "Contract", "EmailMessage", "Entitlement", "Event",
    "FeedItem", "Group", "GroupMember", "Individual", "Lead", "Location", "Note", "Opportunity", "OpportunityContactRole", "OpportunityLineItem",
    "Order", "OrderItem", "Organization", "PermissionSet", "PermissionSetAssignment", "Pricebook2", "PricebookEntry", "Product2", "Profile",
    "Quote", "QuoteLineItem", "RecordType", "ServiceAppointment", "ServiceContract", "ServiceResource", "Task", "User", "UserRole", "WorkOrder",
    "WorkOrderLineItem", "WorkType",
  ].map((o) => o.toLowerCase()),
);
/** A standard object common enough that code naming it means the object (Account, Task). */
export const isStandardObject = (name: string) => STANDARD_OBJECTS.has(name.toLowerCase());

const FORMULA_WORDS = new Set(["true", "false", "null", "and", "or", "not"]);

/**
 * The formula with comments and string literals blanked out, in one pass (a regular
 * expression would take quadratic time on an unclosed comment or string).
 */
export function formulaCode(formula: string): string {
  const out: string[] = [];
  let i = 0;
  let from = 0;
  while (i < formula.length) {
    const ch = formula[i]!;
    if (ch === "/" && formula[i + 1] === "*") {
      out.push(formula.slice(from, i), " ");
      const end = formula.indexOf("*/", i + 2);
      i = from = end < 0 ? formula.length : end + 2;
    } else if (ch === '"' || ch === "'") {
      out.push(formula.slice(from, i), " ");
      let j = i + 1;
      while (j < formula.length && formula[j] !== ch) j += formula[j] === "\\" ? 2 : 1;
      i = from = Math.min(j + 1, formula.length);
    } else i++;
  }
  out.push(formula.slice(from));
  return out.join("");
}

/**
 * The fields a formula uses, as full names. A path through relationships
 * ("Parent__r.Owner.Email") reads each lookup on the way and the field at its end.
 * Functions, string literals, comments and global variables ($User...) are left out.
 * `fieldsOf` gives an object's fields by lowercase name, `objectNamed` the declared
 * spelling of a known object; known fields and objects come back as declared.
 */
export function formulaFields(
  formula: string,
  object: string,
  fieldsOf: (object: string) => ReadonlyMap<string, ParsedComponent> | undefined,
  objectNamed: (name: string) => string | undefined = () => undefined,
): string[] {
  if (formula.length > MAX_FORMULA_LENGTH) return [];
  const found = new Set<string>();
  const fieldName = (owner: string, field: string) => fieldsOf(owner)?.get(field.toLowerCase())?.name ?? `${owner}.${field}`;
  const ident = "[A-Za-z][A-Za-z0-9_]*";
  const path = new RegExp(`(?<![\\w.$:])(\\$?${ident}(?::${ident})?(?:\\.${ident}(?::${ident})?)*)(\\s*\\()?`, "g");
  for (const m of formulaCode(formula).matchAll(path)) {
    const [, text, call] = m;
    if (!text || call || text.startsWith("$")) continue;
    const segs = text.split(".");
    if (segs.length === 1 && FORMULA_WORDS.has(text.toLowerCase())) continue;
    let current: string | undefined = object;
    for (let i = 0; i < segs.length && current; i++) {
      const [seg, typed] = segs[i]!.split(":") as [string, string | undefined];
      if (i === segs.length - 1) {
        if (!typed) found.add(fieldName(current, seg));
        break;
      }
      // A relationship: Parent__r goes through Parent__c, Contact__pr through Contact__pc
      // (person accounts), Account through AccountId. "Owner:User" names the type to follow.
      const suffix = /__(r|pr)$/i.exec(seg);
      const lookup = suffix ? `${seg.slice(0, -suffix[0].length)}${suffix[1]!.toLowerCase() === "pr" ? "__pc" : "__c"}` : `${seg}Id`;
      found.add(fieldName(current, lookup));
      const field: ParsedComponent | undefined = fieldsOf(current)?.get(lookup.toLowerCase());
      const targets: string[] = (field?.attrs.referenceTo as string[] | undefined) ?? [];
      if (typed) current = objectNamed(typed) ?? typed;
      else if (targets.length === 1) current = objectNamed(targets[0]!) ?? targets[0];
      else if (targets.length > 1 || suffix) current = undefined;
      else {
        const known = STANDARD_RELATIONSHIPS[seg.toLowerCase()];
        if (known === "self") current = object;
        else if (known !== undefined) current = known ?? undefined;
        else current = objectNamed(seg) ?? (STANDARD_OBJECTS.has(seg.toLowerCase()) ? seg : undefined);
      }
    }
  }
  return [...found];
}

/** A component's identity in maps: Salesforce API names ignore case. */
export const componentKey = (type: ComponentType, name: string) => `${type}:${name.toLowerCase()}`;

/**
 * The edges between components: each child is part of its object, lookups reference their
 * objects, and formulas, rules, roll-ups and dependent picklists read fields. Objects and
 * fields that are referenced but not in the project come back as `missing`, so the index
 * can hold them as placeholders. Names are matched without case and kept as declared.
 */
export function linkObjects(components: readonly ParsedComponent[]): {
  edges: ParsedEdge[];
  missing: { type: ComponentType; name: string; parent?: string }[];
} {
  const byKey = new Map(components.map((c) => [componentKey(c.type, c.name), c]));
  const fields = new Map<string, Map<string, ParsedComponent>>();
  for (const c of components) {
    if (c.type !== "CustomField" || !c.parent) continue;
    const owner = c.parent.toLowerCase();
    let m = fields.get(owner);
    if (!m) fields.set(owner, (m = new Map()));
    m.set(c.name.slice(c.parent.length + 1).toLowerCase(), c);
  }
  const objectNamed = (o: string) => byKey.get(componentKey("CustomObject", o))?.name;
  const fieldsOf = (o: string) => fields.get(o.toLowerCase()) ?? (objectNamed(o) ? new Map<string, ParsedComponent>() : undefined);

  const edges: ParsedEdge[] = [];
  const missing = new Map<string, { type: ComponentType; name: string; parent?: string }>();
  const need = (type: ComponentType, name: string, parent?: string) => {
    const key = componentKey(type, name);
    const known = byKey.get(key) ?? missing.get(key);
    if (known) return { type, name: known.name };
    missing.set(key, { type, name, ...(parent ? { parent } : {}) });
    return { type, name };
  };
  const readsField = (from: ParsedEdge["from"], full: string, kind: EdgeKind = "reads") => {
    const dot = full.lastIndexOf(".");
    if (dot <= 0 || dot === full.length - 1) return;
    const owner = need("CustomObject", full.slice(0, dot)).name;
    const to = need("CustomField", `${owner}.${full.slice(dot + 1)}`, owner);
    if (componentKey(to.type, to.name) !== componentKey(from.type, from.name)) edges.push({ from, to, kind });
  };

  /** Fields named without their object, linked once every other link is known. */
  const byName: { from: ParsedEdge["from"]; field: string; kind: EdgeKind; among?: readonly string[] }[] = [];
  for (const c of components) {
    const from = { type: c.type, name: c.name };
    if (c.parent) edges.push({ from, to: need(c.parentType ?? "CustomObject", c.parent), kind: "part_of" });
    if (c.type === "CustomField") {
      for (const target of (c.attrs.referenceTo as string[] | undefined) ?? []) edges.push({ from, to: need("CustomObject", target), kind: "references" });
      // Roll-ups name their fields in full ("Claim__c.Amount__c"); a dependent picklist names
      // its controlling field on the same object.
      for (const full of [c.attrs.summarizedField, c.attrs.summaryForeignKey]) if (typeof full === "string") readsField(from, full);
      if (typeof c.attrs.controllingField === "string" && c.parent) readsField(from, `${c.parent}.${c.attrs.controllingField}`);
    }
    for (const ref of c.refs ?? []) {
      if ("field" in ref) byName.push({ from, field: ref.field, kind: ref.kind, ...(ref.among ? { among: ref.among } : {}) });
      else if ("type" in ref) {
        const types = typeof ref.type === "string" ? [ref.type] : ref.type;
        const type = types.find((t) => byKey.has(componentKey(t, ref.name))) ?? (ref.known ? undefined : types[0]);
        if (type) edges.push({ from, to: need(type, ref.name), kind: ref.kind });
      } else if ((ref.known || ref.kind === "may_read") && !objectNamed(ref.object)) continue;
      else if (!ref.path) edges.push({ from, to: need("CustomObject", ref.object), kind: ref.kind });
      else {
        const fields = formulaFields(ref.path, objectNamed(ref.object) ?? ref.object, fieldsOf, objectNamed);
        // A path through relationships reads each lookup; the field at its end is what the
        // reference is about (written, granted, shown); a write writes a record of its object.
        // A link that may be there names only what the project has: no placeholder for a guess.
        if (ref.kind === "may_read") {
          for (const field of fields) if (byKey.has(componentKey("CustomField", field))) readsField(from, field, "may_read");
          continue;
        }
        fields.forEach((field, i) => readsField(from, field, i === fields.length - 1 ? ref.kind : "reads"));
        const last = fields.at(-1);
        if (ref.kind === "writes" && last && last.lastIndexOf(".") > 0) edges.push({ from, to: need("CustomObject", last.slice(0, last.lastIndexOf("."))), kind: "writes" });
      }
    }
    const formula = c.attrs.formula;
    if (typeof formula === "string" && c.parent) {
      for (const field of formulaFields(formula, c.parent, fieldsOf, objectNamed)) readsField(from, field);
    }
  }
  if (byName.length) {
    // Which objects have a custom field of each name, and which field names each component
    // already reaches: a field the code or page names in full is not guessed again.
    const owners = new Map<string, string[]>();
    for (const m of fields.values()) for (const [field, f] of m) owners.set(field, [...(owners.get(field) ?? []), f.parent!]);
    const reached = new Set(edges.filter((e) => e.to.type === "CustomField" && e.kind !== "may_read").map((e) => `${componentKey(e.from.type, e.from.name)}>${e.to.name.slice(e.to.name.lastIndexOf(".") + 1).toLowerCase()}`));
    for (const { from, field, kind, among } of byName) {
      const lower = field.toLowerCase();
      // A mapping record's field named with its object is looked for whatever else was reached:
      // the records of one type name Lead.Email and Contact.Email.
      if (!(among && kind === "may_read") && reached.has(`${componentKey(from.type, from.name)}>${lower}`)) continue;
      // An object of that name (Policy__c.SObjectType, a managed object only referenced) is not a field.
      if (objectNamed(field) || missing.has(componentKey("CustomObject", field))) continue;
      const owning = /__pc$/i.test(field) ? ["Account"] : (owners.get(lower) ?? []);
      const on = among ? owning.filter((o) => among.some((a) => a.toLowerCase() === o.toLowerCase())) : owning.length === 1 ? owning : [];
      for (const o of on) readsField(from, `${o}.${field}`, kind);
      if (on.length) reached.add(`${componentKey(from.type, from.name)}>${lower}`);
    }
  }
  // A person account field (Account.Foo__pc) is its contact field (Contact.Foo__c) seen from the account.
  for (const e of [...edges]) {
    if (e.to.type !== "CustomField" || !/^account\.\w+__pc$/i.test(e.to.name)) continue;
    const contact = `Contact.${e.to.name.slice("Account.".length, -"__pc".length)}__c`;
    if (byKey.has(componentKey("CustomField", contact))) edges.push({ from: e.to, to: { type: "CustomField", name: byKey.get(componentKey("CustomField", contact))!.name }, kind: "references" });
  }
  for (const m of [...missing.values()]) {
    if (m.type === "CustomField" && m.parent) edges.push({ from: { type: m.type, name: m.name }, to: need("CustomObject", m.parent), kind: "part_of" });
  }
  // The same dependency found twice (a lookup on the way and the field itself) is one edge.
  const unique = new Map(edges.map((e) => [`${componentKey(e.from.type, e.from.name)}>${e.kind}>${componentKey(e.to.type, e.to.name)}`, e]));
  // A link that may be there is dropped where the same link is certain.
  for (const [key, e] of unique) if (e.kind === "may_read" && unique.has(key.replace(">may_read>", ">reads>"))) unique.delete(key);
  return { edges: [...unique.values()], missing: [...missing.values()] };
}

/** Drops undefined values and empty arrays, so attrs hold only what the file said. */
function prune<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));
}
