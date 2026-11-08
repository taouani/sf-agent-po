// The checks of each detailed design section (phase 4, PR 5). Like the high-level design's,
// they run on the masked section: errors send the step back, warnings pass and stay visible.
// The stories in scope, and their acceptance criteria, are what the other sections cite.

import type { Finding } from "../backlog.js";
import { backlogSchema } from "../backlog.js";
import {
  CUSTOM_FIELD,
  CUSTOM_OBJECT,
  error,
  existence,
  fieldName,
  fieldType,
  indexedType,
  info,
  language,
  repeatedIds,
  requirementFindings,
  same,
  soften,
  warning,
  type DesignCheckEnv,
} from "./checks.js";
import {
  STORY_REF,
  type DdAutomationSection,
  type DdDataModelSection,
  type DdDeploymentSection,
  type DdIntegrationsSection,
  type DdScopeSection,
  type DdSecuritySection,
  type DdTestsSection,
  type DdUserInterfaceSection,
  type DetailedDesign,
} from "./detailed-schema.js";
import { FIELD_TYPES } from "./schema.js";

type Env = DesignCheckEnv<DetailedDesign>;

/** Story refs that are not in scope, as errors; nothing to check when the scope step failed. */
function storyFindings(env: Env, where: string, refs: readonly string[]): Finding[] {
  const scope = env.design.scope;
  if (!scope) return [];
  const known = new Set(scope.stories.map((s) => s.ref));
  const unknown = [...new Set(refs)].filter((r) => !known.has(r));
  return unknown.length ? [error(where, `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a story in scope: cite only ${[...known].join(", ")}.`)] : [];
}

export function checkDdScope(s: DdScopeSection, env: Env): Finding[] {
  const findings: Finding[] = [];
  const refs = new Set<string>();
  for (const st of s.stories) {
    if (refs.has(st.ref)) findings.push(error(st.ref, `${st.ref} is listed twice.`));
    refs.add(st.ref);
    findings.push(...requirementFindings(env, st.ref, st.requirementIds));
    const ids = new Set<string>();
    for (const ac of st.acceptanceCriteria) {
      if (ids.has(ac.id)) findings.push(error(`${st.ref} ${ac.id}`, `Two criteria of ${st.ref} have the id ${ac.id}.`));
      ids.add(ac.id);
    }
  }
  const hld = s.highLevelDesignId ? env.document?.(s.highLevelDesignId) : undefined;
  if (s.highLevelDesignId && env.document) {
    const meta = hld?.metadata as { artifact?: boolean; artifactType?: string } | undefined;
    if (!hld || hld.kind !== "design" || !meta?.artifact || meta.artifactType !== "high-level")
      findings.push(error("highLevelDesignId", `${s.highLevelDesignId} is not a high-level design of this context.`));
  } else if (!s.highLevelDesignId) findings.push(info("highLevelDesignId", "No high-level design is named: say so if there is none, or give its id."));
  if (s.backlogId && env.document) {
    const doc = env.document(s.backlogId);
    const parsed = backlogSchema.safeParse((doc?.metadata as { backlog?: unknown } | undefined)?.backlog);
    if (!doc || doc.kind !== "backlog" || !parsed.success) findings.push(error("backlogId", `${s.backlogId} is not a backlog of this context.`));
    else {
      const inBacklog = new Map(parsed.data.epics.flatMap((e) => e.stories).map((x) => [x.id, x]));
      for (const st of s.stories) {
        const found = inBacklog.get(st.ref);
        if (!found) {
          if (/^S\d/.test(st.ref)) findings.push(error(st.ref, `${st.ref} is not a story of backlog ${s.backlogId}.`));
        } else if (found.acceptanceCriteria.length !== st.acceptanceCriteria.length)
          findings.push(error(st.ref, `${st.ref} has ${found.acceptanceCriteria.length} acceptance criteria in the backlog: list each one (AC1 to AC${found.acceptanceCriteria.length}), in order.`));
      }
    }
  } else if (!s.backlogId && s.stories.some((st) => /^S\d/.test(st.ref))) findings.push(error("backlogId", "Stories such as S1 come from a backlog: give its id in backlogId, or use the Jira keys."));
  findings.push(...language(env, s, "scope"));
  return findings;
}

/** Field settings each type needs. */
function fieldShape(where: string, f: DdDataModelSection["objects"][number]["fields"][number], type: string): Finding[] {
  if (f.status === "existing" || f.status === "retired") return [];
  const out: Finding[] = [];
  if (["Text", "EncryptedText"].includes(type) && (!f.length || f.length > 255)) out.push(error(where, `A ${type} field needs a length from 1 to 255.`));
  if (["LongTextArea", "Html"].includes(type) && (!f.length || f.length > 131_072)) out.push(error(where, `A ${type} field needs a length up to 131072.`));
  if (["Number", "Currency", "Percent"].includes(type)) {
    if (!f.precision || f.precision > 18) out.push(error(where, `A ${type} field needs a precision (total digits) up to 18.`));
    else if ((f.scale ?? 0) > f.precision) out.push(error(where, "The scale (decimal places) cannot be more than the precision."));
  }
  if (["Picklist", "MultiselectPicklist"].includes(type) && !f.picklistValues.length && !f.valueSet) out.push(error(where, "A picklist needs its values, or a global value set in valueSet."));
  if (["Lookup", "MasterDetail"].includes(type) && !f.relationship) out.push(error(where, "A relationship field needs relationship: the object it points to, lookup or master-detail, and why."));
  else if (f.relationship && !f.relationship.reason) out.push(warning(where, `Say why ${f.relationship.kind} to ${f.relationship.to}: sharing, cascade delete, roll-up summaries.`));
  if (!f.description && !f.helpText) out.push(warning(where, "Give a description or help text."));
  if (!f.access.length) out.push(warning(where, "No permission set gives access to it: list the field-level security in access."));
  return out;
}

export function checkDdDataModel(s: DdDataModelSection, env: Env): Finding[] {
  const findings: Finding[] = [];
  const names = new Set<string>();
  for (const o of s.objects) {
    if (names.has(o.name.toLowerCase())) findings.push(error(o.name, `${o.name} is listed twice: describe each object once.`));
    names.add(o.name.toLowerCase());
    findings.push(...storyFindings(env, o.name, o.stories));
    if (o.status === "new" && !CUSTOM_OBJECT.test(o.name)) findings.push(error(o.name, "A new object is custom: its API name ends in __c (or __mdt, __e)."));
    if (o.status !== "new") findings.push(...existence(env, o.name, "CustomObject", o.name, CUSTOM_OBJECT.test(o.name)));
    for (const f of o.fields) {
      const name = fieldName(o.name, f.name);
      const where = `${o.name}.${name}`;
      const type = fieldType(f.type);
      if (!type) findings.push(error(where, `"${f.type}" is not a field type: use one of ${FIELD_TYPES.join(", ")}.`));
      if (f.status === "new" && !CUSTOM_FIELD.test(name)) findings.push(error(where, "A new field is custom: its API name ends in __c."));
      if (f.status !== "new" && o.status !== "new") findings.push(...existence(env, where, "CustomField", where, CUSTOM_FIELD.test(name)));
      if (type) findings.push(...fieldShape(where, f, type));
      const said = [f.name, f.label, f.description ?? "", f.helpText ?? ""].join(" ");
      if (!f.classification && env.rules.sensitive.test(said)) findings.push(warning(where, "It looks sensitive: give its classification (sensitivity and compliance categories)."));
      if (f.relationship && !s.objects.some((x) => same(x.name, f.relationship!.to))) findings.push(...existence(env, where, "CustomObject", f.relationship.to, CUSTOM_OBJECT.test(f.relationship.to)));
    }
    for (const r of o.recordTypes) if (r.status !== "new" && o.status !== "new") findings.push(...existence(env, `${o.name}.${r.name}`, "RecordType", `${o.name}.${r.name}`, true));
    for (const v of o.validationRules) if (v.status !== "new" && o.status !== "new") findings.push(...existence(env, `${o.name}.${v.name}`, "ValidationRule", `${o.name}.${v.name}`, true));
  }
  findings.push(...language(env, s, "data-model"));
  return findings;
}

/** An object some automation or field runs on: one the data model has, or one in the index. */
function objectFindings(env: Env, where: string, object: string): Finding[] {
  if ((env.design.dataModel?.objects ?? []).some((o) => same(o.name, object))) return [];
  const found = existence(env, where, "CustomObject", object, CUSTOM_OBJECT.test(object));
  return env.design.dataModel ? found : soften(found);
}

export function checkDdAutomation(s: DdAutomationSection, env: Env): Finding[] {
  const findings: Finding[] = [...repeatedIds(s.flows, "flows"), ...repeatedIds(s.apex, "Apex classes or triggers")];
  const slots = new Map<string, string[]>();
  const slot = (key: string, id: string) => slots.set(key, [...(slots.get(key) ?? []), id]);
  for (const f of s.flows) {
    findings.push(...requirementFindings(env, f.id, f.requirementIds), ...storyFindings(env, f.id, f.stories));
    if (f.kind === "record-triggered" && (!f.object || !f.event || !f.timing)) findings.push(error(f.id, "A record-triggered flow needs its object, event (create, update...) and timing (before-save, after-save or async)."));
    if (f.object) findings.push(...objectFindings(env, f.id, f.object));
    if (f.status !== "new") findings.push(...existence(env, f.id, "Flow", f.name, true));
    if (f.kind !== "screen" && f.status !== "retired" && !f.faultHandling) findings.push(warning(f.id, `Say how ${f.name} handles a fault: a fault path, who is told, what is rolled back.`));
    if (f.runAs === "system without sharing") findings.push(warning(f.id, `${f.name} runs in system context without sharing: check it cannot expose records the user should not see.`));
    if (f.object && f.timing && f.status !== "retired") slot(`${f.object.toLowerCase()}|${f.timing}`, f.id);
  }
  const triggersPer = new Map<string, string[]>();
  for (const a of s.apex) {
    findings.push(...requirementFindings(env, a.id, a.requirementIds), ...storyFindings(env, a.id, a.stories));
    if (a.kind === "trigger") {
      if (!a.object || !a.events.length) findings.push(error(a.id, "A trigger needs its object and its events (before insert, after update...)."));
      if (a.object && a.status !== "retired") triggersPer.set(a.object.toLowerCase(), [...(triggersPer.get(a.object.toLowerCase()) ?? []), a.id]);
    }
    if (a.object) findings.push(...objectFindings(env, a.id, a.object));
    if (a.status !== "new") findings.push(...existence(env, a.id, a.kind === "trigger" ? "ApexTrigger" : "ApexClass", a.name, true));
    if (a.status === "existing" || a.status === "retired") continue;
    if (a.sharing === "without sharing" && !a.why) findings.push(warning(a.id, `${a.name} runs without sharing: say why in why.`));
    if (!a.userMode && a.kind !== "trigger") findings.push(warning(a.id, `${a.name} does not run its queries and DML in user mode: say why, or use WITH USER_MODE and AccessLevel.USER_MODE so CRUD and field-level security apply.`));
    if (!a.why) findings.push(warning(a.id, `Say why Apex rather than Flow for ${a.name}.`));
    if (same(a.testClass, a.name)) findings.push(error(a.id, `The test class of ${a.name} cannot be the class itself.`));
  }
  for (const [key, ids] of slots) {
    const flows = s.flows.filter((f) => ids.includes(f.id));
    if (flows.length > 1 && flows.some((f) => f.order === undefined)) {
      const timing = key.split("|")[1];
      findings.push(warning(ids.join(", "), `${ids.length} flows run on ${flows[0]!.object} ${timing}: give each its order (trigger order), or merge them.`));
    }
  }
  for (const ids of triggersPer.values())
    if (ids.length > 1) findings.push(warning(ids.join(", "), "Keep one trigger per object, and put the logic in a handler class."));
  if (!s.orderNotes && (s.flows.length || s.apex.length)) findings.push(warning("orderNotes", "Say how the new automation runs with the existing triggers and flows on the same objects."));
  findings.push(...language(env, s, "automation"));
  return findings;
}

export function checkDdUserInterface(s: DdUserInterfaceSection, env: Env): Finding[] {
  const findings: Finding[] = [];
  for (const p of s.pages) {
    findings.push(...storyFindings(env, p.name, p.stories));
    if (p.object) findings.push(...objectFindings(env, p.name, p.object));
  }
  for (const c of s.components) {
    findings.push(...storyFindings(env, c.name, c.stories));
    if (c.status === "new" && (c.kind === "aura" || c.kind === "visualforce")) findings.push(warning(c.name, `A new ${c.kind === "aura" ? "Aura component" : "Visualforce page"}: build it as a Lightning web component unless something rules it out, and say what.`));
    if (c.kind === "lwc" && c.status === "new" && !/^[a-z][A-Za-z0-9]*$/.test(c.name)) findings.push(error(c.name, "A Lightning web component's name is camelCase and starts with a lowercase letter, such as renewalPanel."));
    if (c.kind === "lwc" && c.status !== "new") findings.push(...existence(env, c.name, "LightningComponentBundle", c.name, true));
  }
  findings.push(...language(env, s, "user-interface"));
  return findings;
}

export function checkDdIntegrations(s: DdIntegrationsSection, env: Env): Finding[] {
  const findings: Finding[] = [...repeatedIds(s.integrations, "integrations")];
  for (const i of s.integrations) {
    findings.push(...requirementFindings(env, i.id, i.requirementIds), ...storyFindings(env, i.id, i.stories));
    if (i.direction !== "inbound" && !i.namedCredential) findings.push(warning(i.id, `Call ${i.system} through a Named Credential (with an External Credential), never an endpoint and secret in code or settings.`));
    if (i.direction !== "outbound" && !i.integrationUser) findings.push(warning(i.id, `Name the integration user ${i.system} signs in as: a dedicated API-only user with least-privilege permission sets.`));
    if (!i.retries) findings.push(warning(i.id, `Say how calls to or from ${i.system} are retried, and how duplicates are avoided.`));
    if (!i.logging) findings.push(warning(i.id, `Say how ${i.system} calls are logged, and where an administrator sees the failures.`));
  }
  findings.push(...language(env, s, "integrations"));
  return findings;
}

export function checkDdSecurity(s: DdSecuritySection, env: Env): Finding[] {
  const findings: Finding[] = [];
  const defined = new Set(s.permissionSets.map((p) => p.name.toLowerCase()));
  for (const p of s.permissionSets) {
    findings.push(...storyFindings(env, p.name, p.stories));
    if (p.status !== "new") findings.push(...existence(env, p.name, "PermissionSet", p.name, true));
  }
  for (const c of s.customPermissions) findings.push(...storyFindings(env, c.name, c.stories));
  // Every permission set the field tables give access through is described here or exists.
  const named = new Set((env.design.dataModel?.objects ?? []).flatMap((o) => o.fields.flatMap((f) => f.access.map((a) => a.permissionSet))));
  for (const name of named)
    if (!defined.has(name.toLowerCase()) && (!env.lookup || !env.lookup("PermissionSet", name)))
      findings.push(error(name, `The data model gives access through permission set ${name}, which is neither described here nor in the index: describe it in permissionSets.`));
  for (const o of (env.design.dataModel?.objects ?? []).filter((o) => o.status === "new" && !s.sharing.some((x) => same(x.object, o.name))))
    findings.push(warning(o.name, `New object ${o.name} has no sharing entry: give its internal (and external) default.`));
  for (const x of s.sharing.filter((x) => x.external === "public read/write"))
    findings.push(warning(x.object, `External users get read/write access to every ${x.object} record: check that is meant.`));
  findings.push(...language(env, s, "security"));
  return findings;
}

export function checkDdTests(s: DdTestsSection, env: Env): Finding[] {
  const findings: Finding[] = [];
  const scope = env.design.scope;
  if (scope) {
    const criteria = new Map(scope.stories.map((st) => [st.ref, new Set(st.acceptanceCriteria.map((a) => a.id))]));
    const tested = new Set(s.acceptance.map((a) => `${a.story} ${a.criterion}`));
    for (const a of s.acceptance) {
      const of = criteria.get(a.story);
      if (!of) findings.push(error(`${a.story} ${a.criterion}`, `${a.story} is not a story in scope.`));
      else if (!of.has(a.criterion)) findings.push(error(`${a.story} ${a.criterion}`, `${a.story} has no criterion ${a.criterion}.`));
    }
    for (const st of scope.stories)
      for (const ac of st.acceptanceCriteria)
        if (!tested.has(`${st.ref} ${ac.id}`)) findings.push(error(`${st.ref} ${ac.id}`, `No test is mapped to ${st.ref} ${ac.id}: add one to acceptance.`));
  }
  const classes = new Set(s.apex.map((t) => t.testClass.toLowerCase()));
  for (const a of (env.design.automation?.apex ?? []).filter((a) => a.status === "new" || a.status === "changed"))
    if (!classes.has(a.testClass.toLowerCase())) findings.push(warning(a.id, `${a.testClass}, the test class of ${a.name}, has no entry in apex: give its scenarios (bulk, negative, permissions).`));
  const flowTests = new Set(s.flows.map((t) => t.flow.toLowerCase()));
  for (const f of (env.design.automation?.flows ?? []).filter((f) => f.kind === "record-triggered" && (f.status === "new" || f.status === "changed")))
    if (!flowTests.has(f.name.toLowerCase())) findings.push(info(f.id, `No flow test for ${f.name}: add one, or say how it is tested.`));
  findings.push(...language(env, s, "tests"));
  return findings;
}

/** The components the other sections add, change or retire, as "type name". */
export function ddComponents(d: DetailedDesign): { type: string; name: string; where: string }[] {
  const out: { type: string; name: string; where: string }[] = [];
  for (const o of d.dataModel?.objects ?? []) {
    if (o.status !== "existing") out.push({ type: "CustomObject", name: o.name, where: o.name });
    for (const f of o.fields.filter((f) => f.status !== "existing")) out.push({ type: "CustomField", name: `${o.name}.${fieldName(o.name, f.name)}`, where: o.name });
    for (const r of o.recordTypes.filter((r) => r.status !== "existing")) out.push({ type: "RecordType", name: `${o.name}.${r.name}`, where: o.name });
    for (const v of o.validationRules.filter((v) => v.status !== "existing")) out.push({ type: "ValidationRule", name: `${o.name}.${v.name}`, where: o.name });
  }
  for (const f of (d.automation?.flows ?? []).filter((f) => f.status !== "existing")) out.push({ type: "Flow", name: f.name, where: f.id });
  for (const a of (d.automation?.apex ?? []).filter((a) => a.status !== "existing")) {
    out.push({ type: a.kind === "trigger" ? "ApexTrigger" : "ApexClass", name: a.name, where: a.id });
    if (a.status !== "retired") out.push({ type: "ApexClass", name: a.testClass, where: a.id });
  }
  for (const c of (d.userInterface?.components ?? []).filter((c) => c.status !== "existing" && c.kind === "lwc")) out.push({ type: "LightningComponentBundle", name: c.name, where: c.name });
  for (const p of (d.security?.permissionSets ?? []).filter((p) => p.status !== "existing")) out.push({ type: "PermissionSet", name: p.name, where: p.name });
  for (const c of d.security?.customPermissions ?? []) out.push({ type: "CustomPermission", name: c.name, where: c.name });
  return out;
}

export function checkDdDeployment(s: DdDeploymentSection, env: Env): Finding[] {
  const findings: Finding[] = [];
  for (const c of s.components) findings.push(...storyFindings(env, `${c.type} ${c.name}`, c.stories));
  if (!env.lookup) findings.push(info("components", "Nothing is indexed, so the impact on the existing org cannot be checked: say so in the risks."));
  else
    for (const c of s.components.filter((c) => c.change !== "add" && !env.impactChecked?.(c.type, c.name)))
      findings.push(error(`${c.type} ${c.name}`, `Run metadata_impact on ${c.type} ${c.name} (${c.change}) first, and carry its weak links into notes or the risks.`));
  // Every component the design adds, changes or retires has a deployment entry.
  const listed = new Set(s.components.map((c) => `${indexedType(c.type) ?? c.type.toLowerCase()}|${c.name.trim().toLowerCase()}`));
  const missing = ddComponents(env.design).filter((c) => !listed.has(`${indexedType(c.type) ?? c.type.toLowerCase()}|${c.name.trim().toLowerCase()}`));
  for (const m of missing.slice(0, 30)) findings.push(warning(m.where, `${m.type} ${m.name} has no deployment entry.`));
  if (missing.length > 30) findings.push(warning("components", `And ${missing.length - 30} more components have no deployment entry.`));
  findings.push(...language(env, s, "deployment"));
  return findings;
}

/** The stories in scope that no part of the design builds. */
export function unbuiltStories(d: DetailedDesign, items: readonly { stories: string[] }[]): string[] {
  const built = new Set(items.flatMap((i) => i.stories));
  return (d.scope?.stories ?? []).map((s) => s.ref).filter((r) => !built.has(r) && STORY_REF.test(r));
}
