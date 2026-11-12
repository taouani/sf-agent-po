// Flows: what starts them, which records and fields they read and write, and what they call.

import { hideCodeSecrets } from "./apex.js";
import type { ParsedComponent, Ref } from "./model.js";
import { list, obj, str } from "./xml.js";

const SEGMENT = "[A-Za-z][A-Za-z0-9_]*(?::[A-Za-z][A-Za-z0-9_]*)?";
/**
 * `$Record.Field`, `{!Get_Accounts.Owner.Email}`, `acc.Name`: a record (the triggering one, a
 * record variable, a Get Records element, a loop's current item) and a path from it. Which
 * heads are records is decided by the flow's own declarations, so a word that only looks like
 * one ("Account.Name" in a formula with no such variable) is passed over.
 */
const REFERENCE = new RegExp(`(?<![A-Za-z0-9_.$])(\\$Record(?:__Prior)?|[A-Za-z][A-Za-z0-9_]*)\\.(${SEGMENT}(?:\\.${SEGMENT})*)`, "g");

/** Keys whose text is written for people, not the engine: a `$Record.X` there is prose. */
const PROSE = new Set(["description", "label", "interviewLabel", "masterLabel", "helpText"]);

/** Process Builder processes: the object is in their metadata values, not in `start`. */
const PROCESS_TYPES = new Set(["Workflow", "CustomEvent", "InvocableProcess"]);

/** Every string anywhere in an element with the key that holds it, depth first, skipping prose. */
function strings(v: unknown, key: string, out: [string, string][] = []): [string, string][] {
  if (PROSE.has(key)) return out;
  if (typeof v === "string") out.push([key, v]);
  else if (Array.isArray(v)) for (const x of v) strings(x, key, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) strings(x, k, out);
  return out;
}

/**
 * A flow from its Flow element. Record-triggered flows trigger on their object; record
 * elements read or write their object and fields; whatever names a field through a record
 * ($Record, a record variable, a Get Records result, a loop's item) reads it, and an
 * assignment to one writes it; Apex, subflows, email alerts, quick actions, external services
 * and custom screen components are called.
 */
export function readFlow(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const start = obj(root.start);
  const processType = str(root.processType);
  const processValue = (n: string) =>
    list(root.processMetadataValues)
      .map(obj)
      .find((v) => str(v.name) === n);
  const triggerObject = str(start.object) ?? (processType && PROCESS_TYPES.has(processType) ? str(obj(processValue("ObjectType")?.value).stringValue) : undefined);
  const refs: Ref[] = [];
  // A process (Workflow) runs when records change, as a record-triggered flow does; an
  // invocable one runs when called, so only its object is known.
  if (triggerObject && processType !== "InvocableProcess" && processType !== "CustomEvent") refs.push({ kind: "triggers_on", object: triggerObject });

  // Which names hold records of which object, lower-cased (flow names are not case-sensitive).
  const records = new Map<string, string>();
  if (triggerObject) for (const r of ["$record", "$record__prior"]) records.set(r, triggerObject);
  for (const v of list(root.variables).map(obj)) {
    const n = str(v.name);
    const o = str(v.objectType);
    if (n && o && str(v.dataType) === "SObject") records.set(n.toLowerCase(), o);
  }
  for (const e of list(root.recordLookups).map(obj)) {
    const n = str(e.name);
    const o = str(e.object);
    if (n && o) records.set(n.toLowerCase(), o);
  }
  /** The object and the path from it that a reference names: "$Record.Account" is Case and "Account". */
  const resolve = (reference: string | undefined): { object: string; path?: string } | undefined => {
    if (!reference) return undefined;
    const dot = reference.indexOf(".");
    const object = records.get((dot < 0 ? reference : reference.slice(0, dot)).toLowerCase());
    if (!object) return undefined;
    return dot < 0 ? { object } : { object, path: reference.slice(dot + 1) };
  };
  // A loop's current item is a record of what it loops over; loops can loop over loops.
  for (let pass = 0; pass < 3; pass++) {
    for (const l of list(root.loops).map(obj)) {
      const n = str(l.name);
      const over = resolve(str(l.collectionReference));
      if (n && over && !over.path && !records.has(n.toLowerCase())) records.set(n.toLowerCase(), over.object);
    }
  }

  /** Field names in `items` (strings, or elements whose `key` holds one) on `object`, through `prefix`. */
  const fieldsOf = (object: string | undefined, items: unknown, key: string, kind: "reads" | "writes", prefix?: string) => {
    if (!object) return;
    for (const item of list(items)) {
      const field = typeof item === "string" ? item : str(obj(item)[key]);
      if (field) refs.push({ kind, object, path: prefix ? `${prefix}.${field}` : field });
    }
  };
  fieldsOf(triggerObject, start.filters, "field", "reads");
  fieldsOf(triggerObject, start.scheduledPaths, "recordField", "reads");

  for (const e of list(root.recordLookups).map(obj)) {
    const object = str(e.object);
    if (!object) continue;
    refs.push({ kind: "reads", object });
    fieldsOf(object, e.filters, "field", "reads");
    fieldsOf(object, e.queriedFields, "", "reads");
    fieldsOf(object, e.outputAssignments, "field", "reads");
  }
  for (const items of [root.recordCreates, root.recordUpdates, root.recordDeletes]) {
    for (const e of list(items).map(obj)) {
      // An element either names its object, or works on a record it is given: the triggering
      // record, a record variable, a Get Records result, or a record related to one of them.
      const target = str(e.object) ? { object: str(e.object)! } : resolve(str(e.inputReference));
      if (!target) continue;
      if (!target.path) refs.push({ kind: "writes", object: target.object });
      fieldsOf(target.object, e.filters, "field", "reads", target.path);
      fieldsOf(target.object, e.inputAssignments, "field", "writes", target.path);
    }
  }
  for (const s of list(root.dynamicChoiceSets).map(obj)) {
    const object = str(s.object);
    if (object) {
      refs.push({ kind: "reads", object });
      fieldsOf(object, s.filters, "field", "reads");
      fieldsOf(object, s.outputAssignments, "field", "reads");
      for (const f of [s.displayField, s.valueField, s.sortField]) fieldsOf(object, f, "", "reads");
    }
    const picklistObject = str(s.picklistObject);
    if (picklistObject) fieldsOf(picklistObject, s.picklistField, "", "reads");
  }

  const calls = (type: string | string[], target: string | undefined) => {
    if (target) refs.push({ kind: "calls", type, name: target });
  };
  for (const a of list(root.actionCalls).map(obj)) {
    const action = str(a.actionName);
    if (!action) continue;
    switch (str(a.actionType)) {
      case "apex":
        calls("ApexClass", action.split(".")[0]);
        break;
      case "flow":
        calls("Flow", action);
        break;
      case "emailAlert":
        calls("WorkflowAlert", action);
        break;
      case "quickAction":
        calls("QuickAction", action);
        break;
      case "externalService":
        calls("ExternalServiceRegistration", action.split(".")[0]);
        break;
    }
  }
  for (const p of list(root.apexPluginCalls).map(obj)) calls("ApexClass", str(p.apexClass));
  for (const s of list(root.subflows).map(obj)) calls("Flow", str(s.flowName));
  for (const stage of list(root.orchestratedStages).map(obj)) {
    for (const step of list(stage.stageSteps).map(obj)) {
      const type = str(step.actionType);
      if (type === "stepInteractive" || type === "stepBackground") calls("Flow", str(step.actionName));
    }
  }
  // An Apex-defined variable is typed by its class.
  for (const v of list(root.variables).map(obj)) {
    const cls = str(v.apexClass);
    if (cls) refs.push({ kind: "references", type: "ApexClass", name: cls });
  }

  // Conditions, formulas, templates, assignments: whatever names a field through a record
  // reads it, and an assignment to one writes it.
  const seen = new Set<string>();
  for (const [key, s] of strings(root, "Flow")) {
    // A screen component of this project ("c:policyCard"), Lightning web or Aura.
    if (key === "extensionName") {
      if (s.startsWith("c:")) calls(["LightningComponentBundle", "AuraDefinitionBundle"], s.slice(2));
      continue;
    }
    // The record an element works on, or a loop walks: read above, as a record, not a field.
    if (key === "inputReference" || key === "collectionReference") continue;
    const kind = key === "assignToReference" ? "writes" : "reads";
    for (const m of s.matchAll(REFERENCE)) {
      const target = resolve(`${m[1]!}.${m[2]!}`);
      if (!target?.path) continue;
      const id = `${kind}:${target.object}:${target.path}`.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      refs.push({ kind, object: target.object, path: target.path });
    }
  }

  // The flow's logic as text, for an agent to read what the links cannot show: the conditions
  // of its decisions, the filters of its record elements, what it assigns and passes on.
  const outline = flowOutline(name, root);
  return {
    type: "Flow",
    name,
    label: str(root.label),
    file,
    body: hideCodeSecrets(outline),
    attrs: prune({
      lines: outline.split("\n").length,
      processType,
      status: str(root.status),
      apiVersion: str(root.apiVersion),
      triggerObject,
      triggerType: str(start.triggerType),
      recordTriggerType: str(start.recordTriggerType),
      // Schedule details, entry conditions and element labels can carry names: not kept here;
      // they are in the outline (body), which a tool masks when it returns it.
      elements: Object.fromEntries(
        ["decisions", "assignments", "loops", "recordLookups", "recordCreates", "recordUpdates", "recordDeletes", "actionCalls", "subflows", "screens"]
          .map((k) => [k, list(root[k]).length] as const)
          .filter(([, n]) => n > 0),
      ),
    }),
    refs,
    text: [str(root.description), str(root.interviewLabel)].filter((p): p is string => !!p && p.trim() !== "").join("\n"),
  };
}

/** Element kinds, in the order a flow's file lists them, with the words the outline gives them. */
const ELEMENTS: [string, string][] = [
  ["actionCalls", "ACTION"],
  ["apexPluginCalls", "APEX PLUGIN"],
  ["assignments", "ASSIGNMENT"],
  ["collectionProcessors", "COLLECTION"],
  ["customErrors", "CUSTOM ERROR"],
  ["decisions", "DECISION"],
  ["loops", "LOOP"],
  ["orchestratedStages", "STAGE"],
  ["recordCreates", "CREATE RECORDS"],
  ["recordDeletes", "DELETE RECORDS"],
  ["recordLookups", "GET RECORDS"],
  ["recordRollbacks", "ROLL BACK"],
  ["recordUpdates", "UPDATE RECORDS"],
  ["screens", "SCREEN"],
  ["steps", "STEP"],
  ["subflows", "SUBFLOW"],
  ["transforms", "TRANSFORM"],
  ["waits", "WAIT"],
];

/**
 * A literal in the outline: in single quotes, as Apex writes it, so that the secrets in it are
 * hidden the same way. A line break is written "\n " (with a space): a name at the start of the
 * next line must not be glued to the "n", or the masking would not find it.
 */
const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, "\\n ")}'`;

/** Text written as it is (a label, a name): no "'" that would open a literal for the secret scan. */
const plain = (s: string) => s.replace(/'/g, "’").replace(/\s*\r?\n\s*/g, " ");

/** A formula: its "strings" become literals, so that a secret in one is hidden; the rest is plain. */
function formula(s: string): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
    out += plain(s.slice(last, m.index)) + quote((m[1] ?? m[2]!).replace(/\\(.)/g, "$1"));
    last = m.index + m[0].length;
  }
  return out + plain(s.slice(last));
}

/** A flow value: a reference to a resource, a formula, or a literal. */
function value(v: unknown): string {
  const o = obj(v);
  const ref = str(o.elementReference);
  if (ref) return `{!${ref}}`;
  const s = o.stringValue;
  if (s !== undefined) return quote(typeof s === "string" ? s : "");
  const f = str(o.formulaExpression);
  if (f) return `formula ${formula(f)}`;
  for (const k of ["numberValue", "booleanValue", "dateValue", "dateTimeValue"]) {
    const x = str(o[k]);
    if (x) return x;
  }
  const other = Object.entries(o).find(([k, x]) => typeof x === "string" && k !== "formulaDataType");
  return other ? `${other[0]} ${quote(other[1] as string)}` : "(empty)";
}

/** The label of an element or outcome, after its name, when it says something else. */
const labelled = (name: string, label: string | undefined) => `${name}${label && label !== name ? ` "${plain(label)}"` : ""}`;

/**
 * Conditions, one per line under a heading that says how they combine: "all of", "any of", or
 * a custom logic that numbers them ("1 AND (2 OR 3)").
 */
function conditions(items: unknown, logic: string | undefined, left: string, indent: string): { how: string; lines: string[] } {
  const parts = list(items)
    .map(obj)
    .map((c) => {
      const l = str(c[left]) ?? "?";
      const op = str(c.operator) ?? "?";
      const right = c.rightValue ?? c.value;
      return `${left === "field" ? l : `{!${l}}`} ${op}${right === undefined ? "" : ` ${value(right)}`}`;
    });
  const how = (logic ?? "and").toLowerCase();
  if (how === "and" || how === "or") return { how: parts.length > 1 ? (how === "and" ? "all of" : "any of") : "", lines: parts.map((p) => `${indent}${p}`) };
  return { how: plain(logic!), lines: parts.map((p, i) => `${indent}${i + 1}: ${p}`) };
}

/** A heading followed by its conditions, or nothing when there are none. */
function when(out: string[], heading: string, items: unknown, logic: string | undefined, left: string): void {
  const c = conditions(items, logic, left, `${/^\s*/.exec(heading)![0]}  `);
  if (!c.lines.length) return;
  out.push(`${heading}${c.how ? ` ${c.how}` : ""}:`, ...c.lines);
}

/** Where an element goes next, and on error. */
function next(e: Record<string, unknown>, out: string[], indent = "  "): void {
  const to = str(obj(e.connector).targetReference);
  if (to) out.push(`${indent}-> ${to}`);
  const fault = str(obj(e.faultConnector).targetReference);
  if (fault) out.push(`${indent}on error -> ${fault}`);
}

/** The names a connector leads to from an element, primary path first. */
function targets(e: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (c: unknown) => {
    for (const one of list(c)) {
      const t = str(obj(one).targetReference);
      if (t) out.push(t);
    }
  };
  add(e.connector);
  add(e.connectors);
  for (const r of list(e.rules)) add(obj(r).connector);
  for (const p of list(e.scheduledPaths)) add(obj(p).connector);
  for (const w of list(e.waitEvents)) add(obj(w).connector);
  add(e.nextValueConnector);
  add(e.defaultConnector);
  add(e.noMoreValuesConnector);
  add(e.faultConnector);
  return out;
}

/** The fields of a screen, those inside its sections and columns too. */
function screenFields(fields: unknown, out: string[] = []): string[] {
  for (const f of list(fields).map(obj)) {
    const type = str(f.extensionName) ?? str(f.fieldType) ?? "field";
    if (type !== "RegionContainer" && type !== "Region") out.push(`${str(f.name) ?? "?"} (${type})`);
    screenFields(f.fields, out);
  }
  return out;
}

/** One element of a flow, as lines of the outline. */
function element(kind: string, e: Record<string, unknown>): string[] {
  const out = [`${kind} ${labelled(str(e.name) ?? "?", str(e.label))}`];
  /** Values given to something: "name = value", the form the secret scan knows. */
  const given = (items: unknown, key: string, prefix = "") => {
    for (const a of list(items).map(obj)) {
      const target = str(a[key]);
      if (target) out.push(`  ${prefix}${target} = ${value(a.value)}`);
    }
  };
  /** Values taken back: "{!variable} = output name". */
  const taken = (items: unknown, from: string, to: string) => {
    for (const p of list(items).map(obj)) {
      const n = str(p[from]);
      const v = str(p[to]);
      if (n && v) out.push(`  {!${v}} = output ${n}`);
    }
  };
  switch (kind) {
    case "DECISION":
      for (const r of list(e.rules).map(obj)) {
        const c = conditions(r.conditions, str(r.conditionLogic), "leftValueReference", "    ");
        out.push(`  outcome ${labelled(str(r.name) ?? "?", str(r.label))}${c.lines.length ? ` when${c.how ? ` ${c.how}` : ""}:` : ": (no conditions)"}`, ...c.lines);
        const to = str(obj(r.connector).targetReference);
        if (to) out.push(`    -> ${to}`);
      }
      out.push(`  otherwise${str(e.defaultConnectorLabel) ? ` "${plain(str(e.defaultConnectorLabel)!)}"` : ""} -> ${str(obj(e.defaultConnector).targetReference) ?? "(end)"}`);
      return out;
    case "ASSIGNMENT":
      for (const a of list(e.assignmentItems).map(obj)) out.push(`  {!${str(a.assignToReference) ?? "?"}} ${str(a.operator) ?? "Assign"} ${value(a.value)}`);
      break;
    case "GET RECORDS": {
      out.push(`  from ${str(e.object) ?? "?"}${str(e.getFirstRecordOnly) === "true" ? ", first record only" : ""}${str(e.sortField) ? `, sorted by ${str(e.sortField)} ${str(e.sortOrder) ?? ""}`.trimEnd() : ""}`);
      when(out, "  where", e.filters, str(e.filterLogic), "field");
      const fields = list(e.queriedFields).map(str).filter(Boolean);
      if (fields.length) out.push(`  fields ${fields.join(", ")}`);
      for (const a of list(e.outputAssignments).map(obj)) {
        const to = str(a.assignToReference);
        const field = str(a.field);
        if (to && field) out.push(`  {!${to}} = field ${field}`);
      }
      const into = str(e.outputReference);
      if (into) out.push(`  into {!${into}}`);
      else if (str(e.storeOutputAutomatically) === "true") out.push(`  into {!${str(e.name) ?? "?"}} (stored automatically)`);
      break;
    }
    case "CREATE RECORDS":
    case "UPDATE RECORDS":
    case "DELETE RECORDS": {
      const on = str(e.object) ?? (str(e.inputReference) ? `{!${str(e.inputReference)}}` : "?");
      out.push(`  ${kind === "CREATE RECORDS" ? "of" : "on"} ${on}`);
      when(out, "  where", e.filters, str(e.filterLogic), "field");
      given(e.inputAssignments, "field");
      const id = str(e.assignRecordIdToReference);
      if (id) out.push(`  {!${id}} = the new record's Id`);
      break;
    }
    case "ACTION":
      out.push(`  calls ${str(e.actionType) ?? "action"} ${str(e.actionName) ?? "?"}`);
      given(e.inputParameters, "name", "input ");
      taken(e.outputParameters, "name", "assignToReference");
      break;
    case "APEX PLUGIN":
      out.push(`  calls ${str(e.apexClass) ?? "?"}`);
      given(e.inputParameters, "name", "input ");
      taken(e.outputParameters, "name", "assignToReference");
      break;
    case "SUBFLOW":
      out.push(`  runs ${str(e.flowName) ?? "?"}`);
      given(e.inputAssignments, "name", "input ");
      taken(e.outputAssignments, "name", "assignToReference");
      break;
    case "LOOP":
      out.push(`  over {!${str(e.collectionReference) ?? "?"}}${str(e.iterationOrder) === "Desc" ? ", last first" : ""}`);
      if (str(obj(e.nextValueConnector).targetReference)) out.push(`  each -> ${str(obj(e.nextValueConnector).targetReference)}`);
      out.push(`  then -> ${str(obj(e.noMoreValuesConnector).targetReference) ?? "(end)"}`);
      return out;
    case "COLLECTION":
      out.push(`  ${str(e.elementSubtype) ?? "processes"} {!${str(e.collectionReference) ?? "?"}}`);
      when(out, "  where", e.conditions, str(e.conditionLogic), "leftValueReference");
      break;
    case "CUSTOM ERROR":
      for (const m of list(e.customErrorMessages).map(obj)) out.push(`  shows ${value({ stringValue: str(m.errorMessage) ?? "" })}${str(m.fieldSelection) ? ` on ${str(m.fieldSelection)}` : ""}`);
      break;
    case "SCREEN": {
      const fields = screenFields(e.fields);
      if (fields.length) out.push(`  shows ${fields.join(", ")}`);
      break;
    }
    case "STAGE":
      for (const s of list(e.stageSteps).map(obj)) out.push(`  step ${labelled(str(s.name) ?? "?", str(s.label))}: ${str(s.actionType) ?? "?"} ${str(s.actionName) ?? "?"}`);
      break;
    case "WAIT":
      for (const w of list(e.waitEvents).map(obj)) {
        const to = str(obj(w.connector).targetReference);
        out.push(`  event ${labelled(str(w.name) ?? "?", str(w.label))}${str(w.eventType) ? ` (${str(w.eventType)})` : ""}${to ? ` -> ${to}` : ""}`);
        given(w.inputParameters, "name", "  input ");
        when(out, "    only when", w.conditions, str(w.conditionLogic), "leftValueReference");
      }
      out.push(`  otherwise -> ${str(obj(e.defaultConnector).targetReference) ?? "(end)"}`);
      break;
  }
  next(e, out);
  return out;
}

const TIMING: ReadonlyMap<string, string> = new Map([
  ["RecordBeforeSave", "before save"],
  ["RecordAfterSave", "after save"],
  ["RecordBeforeDelete", "before delete"],
  ["Scheduled", "on a schedule"],
  ["PlatformEvent", "on a platform event"],
]);
const CHANGE: ReadonlyMap<string, string> = new Map([
  ["Create", "created"],
  ["Update", "updated"],
  ["CreateAndUpdate", "created or updated"],
  ["Delete", "deleted"],
]);

/** Text longer than this is cut, with a line that says so: the largest flows keep their start. */
export const MAX_OUTLINE_LENGTH = 1_000_000;

/**
 * A flow as text an agent can read: how it starts, then each element in the order the flow
 * reaches them, with its conditions (one per line), filters, assignments and where it goes
 * next, then its resources (variables, constants, formulas, text templates). Literal values are
 * kept in single quotes, to be masked like any input when a tool returns them; secrets among
 * them are hidden by the caller (hideCodeSecrets), which knows "name = 'value'".
 */
export function flowOutline(name: string, root: Record<string, unknown>): string {
  const out: string[] = [];
  const head = [str(root.processType), str(root.status), str(root.apiVersion) && `API ${str(root.apiVersion)}`].filter(Boolean).join(", ");
  out.push(`FLOW ${labelled(name, str(root.label))}${head ? ` (${head})` : ""}`);
  const start = obj(root.start);
  const object = str(start.object);
  const trigger = str(start.triggerType);
  const change = CHANGE.get(str(start.recordTriggerType) ?? "");
  out.push("", `START${trigger ? ` ${TIMING.get(trigger) ?? trigger}` : ""}${object ? ` on ${object}` : ""}${change ? `, when a record is ${change}` : ""}`);
  when(out, "  only when", start.filters, str(start.filterLogic), "field");
  if (str(start.filterFormula)) out.push(`  only when formula ${formula(str(start.filterFormula)!)}`);
  if (str(start.doesRequireRecordChangedToMeetCriteria) === "true") out.push("  only when the record changes to meet the conditions");
  const schedule = obj(start.schedule);
  if (str(schedule.frequency)) out.push(`  runs ${str(schedule.frequency)}${str(schedule.startTime) ? ` at ${str(schedule.startTime)}` : ""}`);
  for (const p of list(start.scheduledPaths).map(obj)) {
    const to = str(obj(p.connector).targetReference);
    const at =
      str(p.pathType) === "AsyncAfterCommit"
        ? "runs asynchronously, after the save"
        : `${str(p.offsetNumber) ?? "?"} ${str(p.offsetUnit) ?? ""} ${str(p.timeSource) === "RecordField" ? `from ${str(p.recordField) ?? "?"}` : "from the trigger"}`.replace(/\s+/g, " ");
    out.push(`  path ${labelled(str(p.name) ?? "(unnamed)", str(p.label))}: ${at}${to ? ` -> ${to}` : ""}`);
  }
  const first = str(obj(start.connector).targetReference) ?? str(root.startElementReference);
  out.push(`  -> ${first ?? "(nothing)"}`);

  // Elements by name, then in the order the flow reaches them from the start.
  const byName = new Map<string, [string, Record<string, unknown>]>();
  for (const [key, kind] of ELEMENTS) for (const e of list(root[key]).map(obj)) if (str(e.name)) byName.set(str(e.name)!, [kind, e]);
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [first, ...list(start.scheduledPaths).map((p) => str(obj(obj(p).connector).targetReference))].filter((n): n is string => !!n);
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]!;
    if (seen.has(n) || !byName.has(n)) continue;
    seen.add(n);
    order.push(n);
    queue.push(...targets(byName.get(n)![1]));
  }
  const unreached = [...byName.keys()].filter((n) => !seen.has(n));
  for (const n of order) out.push("", ...element(...byName.get(n)!));
  if (unreached.length) {
    out.push("", "-- Not reached from the start:");
    for (const n of unreached) out.push("", ...element(...byName.get(n)!));
  }

  const resources: string[] = [];
  for (const v of list(root.variables).map(obj)) {
    const type = str(v.objectType) ?? str(v.apexClass) ?? str(v.dataType) ?? "?";
    const flags = [type, str(v.isCollection) === "true" && "collection", str(v.isInput) === "true" && "input", str(v.isOutput) === "true" && "output"].filter(Boolean);
    // The value right after the name, where the secret scan looks for it.
    resources.push(`  variable ${str(v.name) ?? "?"}${v.value !== undefined ? ` = ${value(v.value)}` : ""} (${flags.join(", ")})`);
  }
  for (const c of list(root.constants).map(obj)) resources.push(`  constant ${str(c.name) ?? "?"} = ${value(c.value)}`);
  for (const f of list(root.formulas).map(obj)) resources.push(`  formula ${str(f.name) ?? "?"} = ${formula(str(f.expression) ?? "")} (${str(f.dataType) ?? "?"})`);
  for (const t of list(root.textTemplates).map(obj)) {
    // One literal per line of the template: a long email body stays readable line by line.
    const lines = (str(t.text) ?? "").split(/\r?\n/);
    resources.push(`  text template ${str(t.name) ?? "?"} =${lines.length > 1 ? "" : ` ${quote(lines[0]!)}`}`, ...(lines.length > 1 ? lines.map((l) => `    ${quote(l)}`) : []));
  }
  for (const c of list(root.choices).map(obj)) resources.push(`  choice ${str(c.name) ?? "?"} = ${value(c.value)}`);
  for (const s of list(root.dynamicChoiceSets).map(obj)) {
    resources.push(`  choice set ${str(s.name) ?? "?"}: ${str(s.object) ?? str(s.picklistObject) ?? "?"}${str(s.picklistField) ? `.${str(s.picklistField)}` : ""}`);
    when(resources, "    where", s.filters, str(s.filterLogic), "field");
  }
  if (resources.length) out.push("", "RESOURCES", ...resources);

  let text = out.join("\n");
  if (text.length > MAX_OUTLINE_LENGTH) {
    const cut = text.lastIndexOf("\n", MAX_OUTLINE_LENGTH);
    text = `${text.slice(0, cut > 0 ? cut : MAX_OUTLINE_LENGTH)}\n\n-- The outline stops here: the flow is too large to keep all of it.`;
  }
  return text;
}

function prune(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(typeof v === "object" && v !== null && Object.keys(v).length === 0)));
}
