// Jira sub-tasks from a detailed design (RM1, decision D7): each story gets one sub-task per
// component change the design's deployment list says it needs, such as "Create field
// Appointment__c.Channel__c". Everything here works on the masked backlog and design; the real
// values are put back only for the write (jira.ts).

import type { AdfNode, Backlog, Story } from "./backlog.js";
import type { DetailedDesign } from "./design/detailed-schema.js";

export interface PlannedSubtask {
  /** Its id in the Jira mapping: never a backlog id, which cannot hold a colon. */
  id: string;
  storyId: string;
  /** Masked. */
  summary: string;
  /** Masked. */
  description: AdfNode;
}

export interface SubtaskPlan {
  subtasks: PlannedSubtask[];
  /** Story refs in the deployment list that are not stories of this backlog. */
  unmatched: string[];
}

const VERB = { add: "Create", modify: "Update", delete: "Delete" } as const;

/** What a Metadata API type is called in a summary. */
const NOUN: Record<string, string> = {
  customobject: "object",
  customfield: "field",
  recordtype: "record type",
  validationrule: "validation rule",
  flow: "flow",
  apexclass: "Apex class",
  apextrigger: "Apex trigger",
  lightningcomponentbundle: "Lightning web component",
  auradefinitionbundle: "Aura component",
  flexipage: "Lightning page",
  layout: "page layout",
  permissionset: "permission set",
  permissionsetgroup: "permission set group",
  custompermission: "custom permission",
  namedcredential: "Named Credential",
  externalcredential: "External Credential",
  sharingrules: "sharing rules",
  customlabel: "custom label",
  custommetadata: "custom metadata record",
  quickaction: "quick action",
  listview: "list view",
};
/** A Metadata API type as one key, whatever its spacing or case ("Custom Field" is CustomField). */
const typeKey = (type: string) => type.replace(/[^A-Za-z]/g, "").toLowerCase();
const noun = (type: string) => NOUN[typeKey(type)] ?? type;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const txt = (text: string): AdfNode => ({ type: "text", text });
const para = (text: string): AdfNode => ({ type: "paragraph", content: [txt(text)] });

/** What the design says about a component, in a sentence or two. */
function details(d: DetailedDesign, type: string, name: string): string[] {
  const t = noun(type);
  if (t === "field") {
    const [object, field] = name.split(".");
    const f = d.dataModel?.objects.find((o) => object && same(o.name, object))?.fields.find((x) => field && same(x.name, field));
    if (!f) return [];
    const size = f.precision ? ` (${f.precision}${f.scale !== undefined ? `, ${f.scale}` : ""})` : f.length ? ` (${f.length})` : "";
    return [
      `${f.label}: ${f.relationship ? `${f.type} to ${f.relationship.to}` : `${f.type}${size}`}${f.required ? ", required" : ""}${f.picklistValues.length ? `; values: ${f.picklistValues.join(", ")}` : ""}.`,
      ...(f.helpText ? [`Help text: ${f.helpText}`] : []),
      ...(f.access.length ? [`Access: ${f.access.map((a) => `${a.permissionSet} (${a.edit ? "edit" : "read"})`).join(", ")}.`] : []),
    ];
  }
  if (t === "object") {
    const o = d.dataModel?.objects.find((x) => same(x.name, name));
    return o ? [`${o.fields.length} field(s), ${o.recordTypes.length} record type(s), ${o.validationRules.length} validation rule(s) in the design.`] : [];
  }
  if (t === "flow") {
    const f = d.automation?.flows.find((x) => same(x.name, name));
    if (!f) return [];
    const on = [f.object, f.event, f.timing].filter(Boolean).join(", ");
    return [`${f.kind} flow${on ? ` on ${on}` : ""}.`, ...(f.steps.length ? [`Steps: ${f.steps.join("; ")}.`] : []), ...(f.faultHandling ? [`Faults: ${f.faultHandling}`] : [])];
  }
  if (t === "Apex class" || t === "Apex trigger") {
    const a = d.automation?.apex.find((x) => same(x.name, name));
    if (!a) return [];
    return [`${a.kind}${a.object ? ` on ${a.object}` : ""}.`, ...(a.responsibility ? [a.responsibility] : []), ...(a.testClass ? [`Test class: ${a.testClass}.`] : [])];
  }
  if (t === "validation rule") {
    // "Object.Rule": the rule of that object; a bare name only when no other object has a rule by it.
    const [object, rule] = name.includes(".") ? name.split(".") : [undefined, name];
    const found = (d.dataModel?.objects ?? []).filter((o) => !object || same(o.name, object)).flatMap((o) => o.validationRules.filter((x) => rule && same(x.name, rule)));
    const v = found.length === 1 ? found[0] : undefined;
    return v ? [`Error when: ${v.condition}`, `Message: ${v.message}`] : [];
  }
  return [];
}

/** "per-change": one sub-task per deployment entry, under the first story that needs it. "per-story": one under each story it cites. */
export type SubtaskMode = "per-change" | "per-story";

export interface PlanOptions {
  mode?: SubtaskMode;
  /** Stories this publish leaves out of Jira: a change goes under a published story when one cites it. */
  skipped?: (story: Story) => boolean;
  /** Sub-task ids already in Jira: a change keeps the story it was published under. */
  known?: (id: string) => boolean;
}

/**
 * The sub-tasks a detailed design gives a backlog's stories, one per component change in its
 * deployment list (by story id, or by the story's Jira key). By default each change is one
 * sub-task, under the first story in backlog order that cites it, naming the others; with
 * "per-story", each story it cites gets its own.
 */
export function planSubtasks(backlog: Backlog, design: DetailedDesign, designTitle: string, jiraKeyOf: (story: Story) => string | undefined, opts: PlanOptions = {}): SubtaskPlan {
  const { mode = "per-change", skipped = () => false, known = () => false } = opts;
  const stories = backlog.epics.flatMap((e) => e.stories);
  const order = new Map(stories.map((s, i) => [s, i]));
  const byRef = new Map<string, Story>();
  for (const s of stories) {
    byRef.set(s.id, s);
    const key = jiraKeyOf(s);
    if (key) byRef.set(key, s);
  }
  const subtasks: PlannedSubtask[] = [];
  const seen = new Set<string>();
  const unmatched = new Set<string>();
  for (const c of design.deployment?.components ?? []) {
    const cited: Story[] = [];
    for (const ref of c.stories) {
      const story = byRef.get(ref);
      if (!story) unmatched.add(ref);
      else if (!cited.includes(story)) cited.push(story);
    }
    if (!cited.length) continue;
    cited.sort((a, b) => order.get(a)! - order.get(b)!);
    const name = c.name.trim();
    // Stable across rewordings Salesforce treats as the same component: the type's letters and the name, in lower case.
    const idOf = (story: Story) => `${story.id}:${typeKey(c.type)}:${name.toLowerCase()}`;
    const live = cited.filter((s) => !skipped(s));
    const targets = mode === "per-story" ? cited : [live.find((s) => known(idOf(s))) ?? live[0] ?? cited[0]!];
    for (const story of targets) {
      const id = idOf(story);
      if (seen.has(id)) continue;
      seen.add(id);
      const others = mode === "per-story" ? [] : live.filter((s) => s !== story);
      const summary = `${VERB[c.change]} ${noun(c.type)} ${name}`;
      const lines = [
        `${VERB[c.change]} the ${c.type} ${name}.`,
        ...details(design, c.type, name),
        ...(c.notes ? [c.notes] : []),
        ...(others.length ? [`Also needed by: ${others.map((s) => `${s.id} ${s.summary}`).join("; ")}.`] : []),
      ];
      subtasks.push({
        id,
        storyId: story.id,
        summary,
        description: { type: "doc", version: 1, content: [...lines.map(para), { type: "rule" }, para(`From the detailed design "${designTitle}".`)] },
      });
    }
  }
  return { subtasks, unmatched: [...unmatched] };
}
