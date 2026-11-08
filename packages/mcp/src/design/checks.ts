// The checks of each high-level design section (phase 4, section 5 of the plan). They run on
// the masked section, after its shape is checked: errors send the step back, warnings pass and
// stay visible, info is for the agent. Components the design calls existing are looked up in
// the metadata index; requirement ids must be confirmed ones.

import type { IndexedComponent, Requirement, SourceDocument } from "@sf-agent-po/core";
import type { Finding } from "../backlog.js";
import { hash } from "../artifacts.js";
import { languageFinding, type CheckRules } from "../checks.js";
import { stringsOf } from "./mask.js";
import {
  FIELD_TYPES,
  FIXED_WORDS,
  tracedItems,
  type AutomationSection,
  type ContextSection,
  type CurrentStateSection,
  type DataModelSection,
  type DecisionsSection,
  type HighLevelDesign,
  type ImpactSection,
  type IntegrationsSection,
  type SecuritySection,
  type SolutionSection,
} from "./schema.js";

export interface DesignCheckEnv<D = HighLevelDesign> {
  /** The confirmed requirements. */
  requirements: readonly Requirement[];
  /** The sections the earlier steps saved. */
  design: D;
  rules: CheckRules;
  /** A component of the index, by type and API name as the agent wrote it; absent when nothing is indexed. */
  lookup?: (type: string, name: string) => IndexedComponent | undefined;
  /** Whether metadata_impact looked at a component during this run. */
  impactChecked?: (type: string, name: string) => boolean;
  /** A document of the context, by id. */
  document?: (id: string) => SourceDocument | undefined;
}

/** Metadata types the index holds, which existing components are checked against. */
export const INDEXED_TYPES = [
  "CustomObject", "CustomField", "RecordType", "ValidationRule", "Flow", "ApexClass", "ApexTrigger", "PermissionSet", "Profile", "PermissionSetGroup", "Layout",
  "LightningComponentBundle", "AuraDefinitionBundle", "FlexiPage", "CustomApplication", "CustomTab", "WorkflowRule", "NamedCredential", "ExternalCredential",
  "ConnectedApp", "CustomMetadata", "PlatformEventChannel", "QuickAction", "ApexPage",
] as const;
const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const TYPE_ALIASES: Record<string, string> = {
  ...Object.fromEntries(INDEXED_TYPES.map((t) => [squash(t), t])),
  object: "CustomObject", standardobject: "CustomObject", field: "CustomField", customfields: "CustomField", recordtypes: "RecordType", validation: "ValidationRule",
  flows: "Flow", processbuilder: "Flow", process: "Flow", apex: "ApexClass", class: "ApexClass", trigger: "ApexTrigger", lwc: "LightningComponentBundle",
  lightningwebcomponent: "LightningComponentBundle", aura: "AuraDefinitionBundle", auracomponent: "AuraDefinitionBundle", lightningpage: "FlexiPage",
  lightningrecordpage: "FlexiPage", pagelayout: "Layout", workflow: "WorkflowRule", app: "CustomApplication", lightningapp: "CustomApplication",
  visualforcepage: "ApexPage", visualforce: "ApexPage", permissionsets: "PermissionSet",
};

/** The Metadata API type the index uses for what the agent wrote ("Custom Object", "LWC"), or undefined for a type it does not hold. */
export const indexedType = (type: string): string | undefined => TYPE_ALIASES[squash(type)];

/**
 * How metadata_impact records a component it looked at: a hash of its type and real API name,
 * so nothing is stored in clear and a masked or clear spelling of the same name matches.
 */
export const impactKey = (type: string, realName: string) => hash(`${indexedType(type) ?? squash(type)}:${realName.trim().toLowerCase()}`).slice(0, 32);

export const error = (where: string, message: string): Finding => ({ level: "error", where, message });
export const warning = (where: string, message: string): Finding => ({ level: "warning", where, message });
export const info = (where: string, message: string): Finding => ({ level: "info", where, message });

/** A custom object's API name: custom, metadata type, platform event, external or big object. */
export const CUSTOM_OBJECT = /__(c|mdt|e|x|b)$/i;
export const CUSTOM_FIELD = /__c$/i;
export const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Unknown or unconfirmed requirement ids, as errors. */
export function requirementFindings(env: DesignCheckEnv<unknown>, where: string, ids: readonly string[]): Finding[] {
  const confirmed = new Set(env.requirements.map((r) => r.id));
  const unknown = [...new Set(ids)].filter((id) => !confirmed.has(id));
  return unknown.length ? [error(where, `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not confirmed requirement(s): cite only the ids the brief lists.`)] : [];
}

/** Repeated local ids (C1, A1...), as errors. */
export function repeatedIds(items: readonly { id: string }[], what: string): Finding[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const i of items) (seen.has(i.id) ? twice : seen).add(i.id);
  return [...twice].map((id) => error(id, `Two ${what} have the id ${id}: give each its own.`));
}

/** The language warning for a section, on the text the agent wrote: not the fixed words, ids or API names. */
export const language = (env: DesignCheckEnv<unknown>, section: unknown, where: string): Finding[] => {
  const texts = stringsOf(section).filter((t) => !FIXED_WORDS.has(t) && !/^[\w.-]+$/.test(t));
  const f = languageFinding(texts, env.rules.language, where);
  return f ? [f] : [];
};

/**
 * An existing component that is not in the index: an error for a custom one (the design
 * describes something that does not exist), info for a standard one, which a source often
 * holds only when something references it.
 */
export function existence(env: DesignCheckEnv<unknown>, where: string, type: string, name: string, custom: boolean): Finding[] {
  if (!env.lookup || env.lookup(type, name)) return [];
  return custom
    ? [error(where, `${type} ${name} is not in the metadata index: check its API name with metadata_search, or mark it new.`)]
    : [info(where, `${type} ${name} is not in the index, as standard components often are not: check it exists in the org.`)];
}

/** Errors as warnings: for a check that cannot be fixed at this step (an earlier section failed). */
export const soften = (findings: Finding[]): Finding[] => findings.map((f) => (f.level === "error" ? { ...f, level: "warning" } : f));

/** A field type as the Metadata API names it, from what the agent wrote ("Text Area", "Lookup Relationship", "Number(18,0)"). */
const FIELD_TYPE_ALIASES: Record<string, string> = {
  ...Object.fromEntries(FIELD_TYPES.map((t) => [squash(t), t])),
  rollupsummary: "Summary", masterdetailrelationship: "MasterDetail", lookuprelationship: "Lookup", picklistmultiselect: "MultiselectPicklist",
  richtextarea: "Html", textarearich: "Html", textarealong: "LongTextArea", textencrypted: "EncryptedText",
};
export const fieldType = (type: string): string | undefined => FIELD_TYPE_ALIASES[squash(type.replace(/\(.*\)/, ""))];

/** A field's API name without its object ("Policy__c.Status__c" written in Policy__c's fields). */
export const fieldName = (object: string, field: string) => (field.toLowerCase().startsWith(`${object.toLowerCase()}.`) ? field.slice(object.length + 1) : field);

/** Whether a name looks custom for its type: objects and fields by their suffix, everything else is the org's own. */
export const customName = (type: string, name: string) =>
  type === "CustomObject" ? CUSTOM_OBJECT.test(name) : type === "CustomField" ? CUSTOM_FIELD.test(name) : true;

export function checkContext(s: ContextSection, env: DesignCheckEnv): Finding[] {
  return [
    ...s.personas.filter((p) => env.rules.genericPersona(p.name)).map((p) => warning("personas", `Persona "${p.name}" is generic; name the role, e.g. "Renewals agent".`)),
    ...(s.outOfScope.length ? [] : [info("outOfScope", "Nothing is out of scope: say what the work does not cover, if the inputs say it.")]),
    ...language(env, s, "context"),
  ];
}

export const LEGACY = (c: IndexedComponent | undefined) => c && ((c.type === "Flow" && c.attrs.processType === "Workflow") || c.type === "WorkflowRule");

export function checkCurrentState(s: CurrentStateSection, env: DesignCheckEnv): Finding[] {
  const findings: Finding[] = [];
  if (!env.lookup) findings.push(info("components", "Nothing is indexed, so the current state cannot be checked: say it is unknown where no org document shows it."));
  const unchecked = new Set<string>();
  for (const c of s.components) {
    const type = indexedType(c.type);
    if (!type) {
      unchecked.add(c.type);
      continue;
    }
    findings.push(...existence(env, c.name, type, c.name, customName(type, c.name)));
    const found = env.lookup?.(type, c.name);
    if (LEGACY(found) && !s.debt.some((d) => same(d.component, c.name)))
      findings.push(warning(c.name, `${c.name} is a ${found!.type === "Flow" ? "Process Builder process" : "Workflow Rule"}, which reached end of support: list it under debt, to migrate to Flow.`));
  }
  if (env.lookup && unchecked.size) findings.push(info("components", `Not checked against the index, which holds no such type: ${[...unchecked].join(", ")}.`));
  findings.push(...language(env, s, "current-state"));
  return findings;
}

export function checkSolution(s: SolutionSection, env: DesignCheckEnv): Finding[] {
  const findings: Finding[] = [...repeatedIds(s.components, "components")];
  for (const c of s.components) {
    findings.push(...requirementFindings(env, c.id, c.requirementIds));
    const type = indexedType(c.type);
    if (c.status !== "new" && type) findings.push(...existence(env, c.id, type, c.name, customName(type, c.name)));
  }
  if (s.diagram) {
    const nodes = new Set(s.diagram.nodes.map((n) => n.id));
    for (const e of s.diagram.edges)
      for (const end of [e.from, e.to]) if (!nodes.has(end)) findings.push(error("diagram", `An edge goes from or to "${end}", which is not a node of the diagram.`));
  } else findings.push(warning("diagram", "No diagram: add the main components and systems as nodes and edges."));
  if (!s.components.some((c) => c.requirementIds.length)) findings.push(warning("components", "No component cites a requirement: cite the ids each one addresses."));
  findings.push(...language(env, s, "solution"));
  return findings;
}

export function checkDataModel(s: DataModelSection, env: DesignCheckEnv): Finding[] {
  const findings: Finding[] = [];
  const names = new Set<string>();
  for (const o of s.objects) {
    if (names.has(o.name.toLowerCase())) findings.push(error(o.name, `${o.name} is listed twice: describe each object once.`));
    names.add(o.name.toLowerCase());
    if (o.status === "new") {
      if (!CUSTOM_OBJECT.test(o.name)) findings.push(error(o.name, `A new object is custom: its API name ends in __c (or __mdt, __e), such as "${o.name.replace(/\W+/g, "_")}__c".`));
      else if (!o.whyNotStandard) findings.push(warning(o.name, `New custom object ${o.name}: say in whyNotStandard why no standard object fits.`));
    } else findings.push(...existence(env, o.name, "CustomObject", o.name, CUSTOM_OBJECT.test(o.name)));
    for (const f of o.fields) {
      const name = fieldName(o.name, f.name);
      const where = `${o.name}.${name}`;
      if (!fieldType(f.type)) findings.push(error(where, `"${f.type}" is not a field type: use one of ${FIELD_TYPES.join(", ")}.`));
      if (f.status === "new" && !CUSTOM_FIELD.test(name)) findings.push(error(where, `A new field is custom: its API name ends in __c.`));
      if (f.status !== "new" && o.status !== "new") findings.push(...existence(env, where, "CustomField", where, CUSTOM_FIELD.test(name)));
    }
    for (const r of o.relationships) {
      const target = r.to.trim();
      if (!r.reason) findings.push(warning(`${o.name}.${r.field}`, `Say why ${r.kind} to ${target}: sharing, cascade delete, roll-up summaries, or keeping records apart.`));
      if (!s.objects.some((x) => same(x.name, target))) findings.push(...existence(env, `${o.name}.${r.field}`, "CustomObject", target, CUSTOM_OBJECT.test(target)));
    }
  }
  findings.push(...language(env, s, "data-model"));
  return findings;
}

/** The metadata type of an automation, to look an existing one up. */
const AUTOMATION_METADATA: Record<string, string | undefined> = {
  "record-triggered flow": "Flow",
  "screen flow": "Flow",
  "scheduled flow": "Flow",
  "autolaunched flow": "Flow",
  "apex trigger": "ApexTrigger",
  "apex class": "ApexClass",
  "batch apex": "ApexClass",
};
const RECORD_TRIGGERED = new Set(["record-triggered flow", "apex trigger"]);

export function checkAutomation(s: AutomationSection, env: DesignCheckEnv): Finding[] {
  const findings: Finding[] = [...repeatedIds(s.automations, "automations")];
  // Objects the design adds: in the data model, or as a new component of the solution.
  const modelled = [
    ...(env.design.dataModel?.objects ?? []).map((o) => o.name),
    ...(env.design.solution?.components ?? []).filter((c) => c.status === "new" && indexedType(c.type) === "CustomObject").map((c) => c.name),
  ];
  const groups = new Map<string, AutomationSection["automations"]>();
  for (const a of s.automations) {
    findings.push(...requirementFindings(env, a.id, a.requirementIds));
    if (RECORD_TRIGGERED.has(a.type) && (!a.object || !a.event)) findings.push(error(a.id, `${/^[aeiou]/.test(a.type) ? "An" : "A"} ${a.type} runs on an object and an event: give both.`));
    if (a.object && !modelled.some((o) => same(o, a.object!))) {
      const found = existence(env, a.id, "CustomObject", a.object, CUSTOM_OBJECT.test(a.object));
      // Without a data model (its step failed), a new object cannot be told from a wrong name.
      findings.push(...(env.design.dataModel ? found : soften(found)));
    }
    const type = AUTOMATION_METADATA[a.type];
    if (a.status !== "new" && type) findings.push(...existence(env, a.id, type, a.name, true));
    if (a.status !== "existing" && a.status !== "retired" && !a.why) findings.push(warning(a.id, `Say why ${a.type.includes("flow") ? "Flow" : a.type === "other" ? "this mechanism" : "Apex"} for ${a.name}.`));
    if (a.object && a.event && a.status !== "retired") {
      const key = `${a.object.toLowerCase()}|${a.event}`;
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
  }
  for (const list of groups.values())
    if (list.length > 1 && list.some((a) => a.order === undefined))
      findings.push(warning(list.map((a) => a.id).join(", "), `${list.length} automations run on ${list[0]!.object} ${list[0]!.event}: give each its order, or merge them.`));
  findings.push(...language(env, s, "automation"));
  return findings;
}

export function checkIntegrations(s: IntegrationsSection, env: DesignCheckEnv): Finding[] {
  const findings: Finding[] = [...repeatedIds(s.integrations, "integrations")];
  for (const i of s.integrations) {
    findings.push(...requirementFindings(env, i.id, i.requirementIds));
    if (!i.errorHandling) findings.push(warning(i.id, `Say how ${i.system} errors are handled: retries, logging, who is told.`));
    if (!i.volume) findings.push(warning(i.id, `Give the volume for ${i.system}, even as an estimate.`));
  }
  findings.push(...language(env, s, "integrations"));
  return findings;
}

export function checkSecurity(s: SecuritySection, env: DesignCheckEnv): Finding[] {
  const findings: Finding[] = [...repeatedIds(s.measures, "measures")];
  for (const m of s.measures) findings.push(...requirementFindings(env, m.id, m.requirementIds));
  for (const n of s.nonFunctional) findings.push(...requirementFindings(env, n.topic, n.requirementIds));
  const measured = new Set(s.measures.flatMap((m) => m.requirementIds));
  for (const r of env.requirements.filter((r) => r.kind === "compliance" && r.priority !== "wont" && !measured.has(r.id))) {
    const message = `Compliance requirement ${r.id} has no security measure: add the measure that meets it, citing ${r.id}.`;
    findings.push(r.priority === "could" ? warning(r.id, message) : error(r.id, message));
  }
  const targeted = new Set(s.nonFunctional.flatMap((n) => n.requirementIds));
  for (const r of env.requirements.filter((r) => r.kind === "non-functional" && !targeted.has(r.id)))
    findings.push(warning(r.id, `Non-functional requirement ${r.id} has no target here: add it under nonFunctional, citing ${r.id}.`));
  for (const o of (env.design.dataModel?.objects ?? []).filter((o) => o.status === "new" && !s.sharing.some((x) => same(x.object, o.name))))
    findings.push(warning(o.name, `New object ${o.name} has no sharing entry: give its internal (and external) default.`));
  findings.push(...language(env, s, "security"));
  return findings;
}

export function checkImpact(s: ImpactSection, env: DesignCheckEnv): Finding[] {
  const findings: Finding[] = [];
  if (!env.lookup) findings.push(info("changes", "Nothing is indexed, so the impact on the existing org cannot be checked: say so under delivery or in the risks."));
  else
    for (const c of s.changes.filter((c) => c.change !== "add" && !env.impactChecked?.(c.type, c.name)))
      findings.push(error(`${c.type} ${c.name}`, `Run metadata_impact on ${c.type} ${c.name} (${c.change}) first, and carry its weak links into notes or the risks.`));
  // What the design adds, changes or retires elsewhere should be here.
  const listed = new Set(s.changes.map((c) => c.name.trim().toLowerCase()));
  const touched = [
    ...(env.design.dataModel?.objects ?? []).flatMap((o) => [
      ...(o.status !== "existing" ? [o.name] : []),
      ...o.fields.filter((f) => f.status !== "existing" && o.status !== "new").map((f) => `${o.name}.${fieldName(o.name, f.name)}`),
    ]),
    ...(env.design.automation?.automations ?? []).filter((a) => a.status !== "existing").map((a) => a.name),
  ];
  const missing = touched.filter((n) => !listed.has(n.trim().toLowerCase()));
  if (missing.length) findings.push(warning("changes", `The design changes ${missing.slice(0, 15).join(", ")}${missing.length > 15 ? ` and ${missing.length - 15} more` : ""}, not listed here.`));
  findings.push(...language(env, s, "impact"));
  return findings;
}

export function checkDecisions(s: DecisionsSection, env: DesignCheckEnv<unknown>): Finding[] {
  const findings: Finding[] = [...repeatedIds(s.decisions, "decisions")];
  for (const d of s.decisions) findings.push(...requirementFindings(env, d.id, d.requirementIds));
  if (!s.decisions.length) findings.push(warning("decisions", "No decision is recorded: a design makes some (Flow or Apex, standard or custom, an integration pattern)."));
  s.openQuestions.forEach((q, i) => {
    if (!q.owner) findings.push(warning(`openQuestions.${i}`, "Name who should answer this question: a role, such as the business owner or security."));
  });
  findings.push(...language(env, s, "decisions"));
  return findings;
}

/** The confirmed requirements no section addresses yet, by priority. */
export function unaddressed(design: HighLevelDesign, requirements: readonly Requirement[]): Requirement[] {
  const traced = new Set(tracedItems(design).flatMap((t) => t.requirementIds));
  return requirements.filter((r) => !traced.has(r.id));
}
