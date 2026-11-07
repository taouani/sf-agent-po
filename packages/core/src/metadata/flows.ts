// Flows: what starts them, which records and fields they read and write, and what they call.

import type { ParsedComponent, Ref } from "./model.js";
import { list, obj, str } from "./xml.js";

/** `$Record.Field`, `$Record__Prior.Account.Name`: the triggering record's fields. */
const RECORD_PATH = /\$Record(?:__Prior)?\.([A-Za-z][A-Za-z0-9_]*(?::[A-Za-z][A-Za-z0-9_]*)?(?:\.[A-Za-z][A-Za-z0-9_]*(?::[A-Za-z][A-Za-z0-9_]*)?)*)/g;

/** Every string anywhere in an element, depth first. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

/**
 * A flow from its Flow element. Record-triggered flows trigger on their object and read the
 * fields they use through $Record; record elements read or write their object and fields;
 * Apex actions and subflows are called.
 */
export function readFlow(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const start = obj(root.start);
  const triggerObject = str(start.object);
  const refs: Ref[] = [];
  if (triggerObject) refs.push({ kind: "triggers_on", object: triggerObject });

  const fieldsOf = (object: string | undefined, items: unknown, key: string, kind: "reads" | "writes") => {
    if (!object) return;
    for (const item of list(items)) {
      const field = typeof item === "string" ? item : str(obj(item)[key]);
      if (field) refs.push({ kind, object, path: field });
    }
  };
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
      // An element that works on the triggering record ($Record) has no object of its own.
      const object = str(e.object) ?? (str(e.inputReference)?.startsWith("$Record") ? triggerObject : undefined);
      if (!object) continue;
      refs.push({ kind: "writes", object });
      fieldsOf(object, e.filters, "field", "reads");
      fieldsOf(object, e.inputAssignments, "field", "writes");
    }
  }
  for (const a of list(root.actionCalls).map(obj)) {
    const action = str(a.actionName);
    if (!action) continue;
    const type = str(a.actionType);
    if (type === "apex") refs.push({ kind: "calls", type: "ApexClass", name: action.split(".")[0]! });
    else if (type === "flow") refs.push({ kind: "calls", type: "Flow", name: action });
  }
  for (const s of list(root.subflows).map(obj)) {
    const flow = str(s.flowName);
    if (flow) refs.push({ kind: "calls", type: "Flow", name: flow });
  }
  if (triggerObject) {
    // Conditions, formulas, assignments: whatever mentions $Record reads that field.
    const seen = new Set<string>();
    for (const s of strings(root)) {
      for (const m of s.matchAll(RECORD_PATH)) {
        const path = m[1]!;
        if (!seen.has(path)) {
          seen.add(path);
          refs.push({ kind: "reads", object: triggerObject, path });
        }
      }
    }
  }

  return {
    type: "Flow",
    name,
    label: str(root.label),
    file,
    attrs: prune({
      processType: str(root.processType),
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
