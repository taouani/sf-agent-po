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
const noun = (type: string) => NOUN[type.replace(/[^A-Za-z]/g, "").toLowerCase()] ?? type;
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
    const v = d.dataModel?.objects.flatMap((o) => o.validationRules).find((x) => same(x.name, name.split(".").pop() ?? name));
    return v ? [`Error when: ${v.condition}`, `Message: ${v.message}`] : [];
  }
  return [];
}

/**
 * The sub-tasks a detailed design gives a backlog's stories: one per component change in its
 * deployment list, under each story it cites (by id, or by the story's Jira key).
 */
export function planSubtasks(backlog: Backlog, design: DetailedDesign, designTitle: string, jiraKeyOf: (story: Story) => string | undefined): SubtaskPlan {
  const stories = backlog.epics.flatMap((e) => e.stories);
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
    for (const ref of c.stories) {
      const story = byRef.get(ref);
      if (!story) {
        unmatched.add(ref);
        continue;
      }
      const id = `${story.id}:${c.type.trim()}:${c.name.trim()}`;
      if (seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      const summary = `${VERB[c.change]} ${noun(c.type)} ${c.name.trim()}`;
      const lines = [`${VERB[c.change]} the ${c.type} ${c.name.trim()}.`, ...details(design, c.type, c.name.trim()), ...(c.notes ? [c.notes] : [])];
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
