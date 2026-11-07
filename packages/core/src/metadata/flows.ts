// Flows: what starts them, which records and fields they read and write, and what they call.

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

  return {
    type: "Flow",
    name,
    label: str(root.label),
    file,
    attrs: prune({
      processType,
      status: str(root.status),
      apiVersion: str(root.apiVersion),
      triggerObject,
      triggerType: str(start.triggerType),
      recordTriggerType: str(start.recordTriggerType),
      // Schedule details, entry conditions and element labels can carry names: not kept.
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

function prune(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(typeof v === "object" && v !== null && Object.keys(v).length === 0)));
}
