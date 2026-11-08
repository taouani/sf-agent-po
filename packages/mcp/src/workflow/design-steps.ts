// The high-level design as steps (phase 4, decision D2): one step per section of the template,
// each answered as JSON, masked, and checked on its own; then a last step that puts the
// sections together, checks every Must requirement is addressed, and saves the design.

import type { Requirement, SourceDocument } from "@sf-agent-po/core";
import { z } from "zod";
import { industryBlock } from "../agents/industries.js";
import { SA_PRINCIPLES } from "../agents/solution-architect.js";
import { saveArtifact } from "../artifacts.js";
import type { Finding } from "../backlog.js";
import { checkRules, contextLanguage } from "../checks.js";
import {
  checkAutomation,
  checkContext,
  checkCurrentState,
  checkDataModel,
  checkDecisions,
  checkImpact,
  checkIntegrations,
  checkSecurity,
  checkSolution,
  impactKey,
  unaddressed,
  type DesignCheckEnv,
} from "../design/checks.js";
import { maskDeep } from "../design/mask.js";
import { renderHighLevelDesign, type RequirementGap } from "../design/render.js";
import {
  automationSection,
  contextSection,
  currentStateSection,
  dataModelSection,
  decisionsSection,
  impactSection,
  integrationsSection,
  securitySection,
  solutionSection,
  type HighLevelDesign,
} from "../design/schema.js";
import { pick, readySources } from "../metadata-tools.js";
import { requirementsToText } from "../requirements.js";
import { storedScope } from "../scope-tools.js";
import type { StepDefinition, StepOutcome, StepState } from "./engine.js";

type SectionKey = Exclude<keyof HighLevelDesign, "title">;

interface SectionSpec<T> {
  id: string;
  key: SectionKey;
  title: string;
  schema: z.ZodType<T>;
  shape: string;
  /** What to write, after "Write the ... section". */
  guidance: string;
  /** The design principles (by their bold heading) that apply. */
  principles?: string[];
  /** Whether the industry guidance applies. */
  industry?: boolean;
  /** Whether its items cite requirement ids. */
  traces?: boolean;
  /** The earlier sections it builds on, shown in full. */
  uses?: SectionKey[];
  check(section: T, env: DesignCheckEnv): Finding[];
  summary(section: T): string;
}

/** Step ids by section, in the template's order. */
export const HLD_SECTION_STEPS: Record<string, SectionKey> = {
  context: "context",
  "current-state": "currentState",
  solution: "solution",
  "data-model": "dataModel",
  automation: "automation",
  integrations: "integrations",
  security: "security",
  impact: "impact",
  decisions: "decisions",
};

/** One principle of SA_PRINCIPLES, by its bold heading. */
function principle(heading: string): string {
  const line = SA_PRINCIPLES.split("\n").find((l) => l.startsWith(`- **${heading}`));
  if (!line) throw new Error(`No design principle "${heading}".`);
  return line;
}

const docLine = (d: SourceDocument) => `- [${d.id}] ${d.kind}: ${d.title}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cites = (ids: readonly string[]) => {
  const unique = [...new Set(ids)];
  return unique.length ? ` Addresses ${unique.join(", ")}.` : "";
};

/** The sections earlier steps saved in a run. */
export function designSoFar(run: StepState["run"]): HighLevelDesign {
  const design: HighLevelDesign = { title: "" };
  for (const s of run.steps) {
    const key = HLD_SECTION_STEPS[s.step];
    if (key && s.answer !== undefined && (s.status === "passed" || s.status === "warned")) (design as unknown as Record<string, unknown>)[key] = s.answer;
  }
  return design;
}

const confirmedOf = (s: StepState): Requirement[] => s.kit.requirements.list(s.context).filter((r) => r.status === "confirmed");

/** What the checks need: the requirements, the design so far, the index and what metadata_impact looked at in this run. */
function checkEnv(s: StepState): DesignCheckEnv {
  const { kit, context, run } = s;
  const env: DesignCheckEnv = { requirements: confirmedOf(s), design: designSoFar(run), rules: checkRules(contextLanguage(kit.contexts, context)) };
  const index = kit.index;
  if (index && readySources(index).length) {
    // The source the user confirmed the scope in, or the newest one.
    const stored = storedScope(kit.contexts, context);
    const snap = readySources(index).find((x) => x.source === stored?.source) ?? pick(index, undefined);
    env.lookup = (type, name) => index.component(snap.id, type, kit.masker.unmask(context, name).text);
    const checked = (kit.contexts.get(context)?.settings.impactChecked ?? {}) as Record<string, string>;
    env.impactChecked = (type, name) => (checked[impactKey(type, name)] ?? "") >= run.createdAt;
  }
  return env;
}

const SECTIONS: SectionSpec<any>[] = [
  {
    id: "context",
    key: "context",
    title: "Context and scope",
    schema: contextSection,
    industry: true,
    shape:
      '{"goals": ["..."], "inScope": ["..."], "outOfScope": ["..."], "assumptions": ["..."],\n' +
      ' "personas": [{"name": "Renewals agent", "internal": true, "does": "...", "licence": "Sales Cloud Enterprise", "count": 40}]}',
    guidance:
      "the business goals, what is in and out of scope, and the assumptions, from the inputs and the confirmed requirements. " +
      "List each persona: a role, not \"user\"; whether they are employees (internal) or customers, partners or the public; what they do; and the licence that implies.",
    check: checkContext,
    summary: (s) => `${plural(s.goals.length, "goal")}, ${plural(s.personas.length, "persona")}.`,
  },
  {
    id: "current-state",
    key: "currentState",
    title: "Current state",
    schema: currentStateSection,
    principles: ["Technical debt"],
    shape:
      '{"summary": "...", "components": [{"type": "CustomObject", "name": "Policy__c", "notes": "..."}, {"type": "Flow", "name": "Policy_Renewal", "notes": "..."}],\n' +
      ' "debt": [{"component": "Policy_Renewal", "issue": "Process Builder process: migrate to a record-triggered flow"}]}',
    guidance:
      "what exists that the work touches: the objects, automation, code and integrations relevant to it, each with its Metadata API type and its API name exactly as the index has it, and the technical debt. " +
      "Read the scope with scope_show, and each component with metadata_component. Every component you list is checked against the index. " +
      "If nothing is indexed and no org document shows the org, say the current state is unknown and list nothing.",
    check: checkCurrentState,
    summary: (s) => `${plural(s.components.length, "component")}, ${plural(s.debt.length, "debt item")}.`,
  },
  {
    id: "solution",
    key: "solution",
    title: "Solution overview",
    schema: solutionSection,
    principles: ["Standard first", "Delivery"],
    industry: true,
    traces: true,
    uses: ["context", "currentState"],
    shape:
      '{"overview": "...", "orgStrategy": "Existing org, because ...",\n' +
      ' "components": [{"id": "C1", "name": "Renewal console", "type": "Lightning app", "status": "new" | "existing" | "changed" | "retired", "purpose": "...", "requirementIds": ["R1"]}],\n' +
      ' "userExperience": "Lightning apps and pages, Dynamic Forms, LWC, Experience Cloud, mobile",\n' +
      ' "reporting": "reports, dashboards and KPIs; CRM Analytics or Data Cloud only if needed",\n' +
      ' "diagram": {"nodes": [{"id": "sf", "label": "Salesforce", "kind": "salesforce" | "external" | "user" | "data"}], "edges": [{"from": "agent", "to": "sf", "label": "works renewals"}]}}',
    guidance:
      "the solution at architecture level: the capabilities, mapped to Salesforce clouds, products, features and components, and the org strategy. " +
      "Give each component an id (C1, C2...) and cite the requirement ids it addresses. For an existing, changed or retired metadata component, use its type and API name as the index has them. " +
      "Add the user experience, the reporting, and a diagram of the main components, people and systems.",
    check: checkSolution,
    summary: (s) =>
      `${plural(s.components.length, "component")} (${s.components.filter((c: { status: string }) => c.status === "new").length} new, ${s.components.filter((c: { status: string }) => c.status === "changed").length} changed).${cites(s.components.flatMap((c: { requirementIds: string[] }) => c.requirementIds))}`,
  },
  {
    id: "data-model",
    key: "dataModel",
    title: "Data model",
    schema: dataModelSection,
    principles: ["Standard first", "Bulk and limits"],
    industry: true,
    uses: ["solution"],
    shape:
      '{"objects": [{"name": "Policy__c", "label": "Policy", "status": "new" | "existing" | "changed" | "retired", "whyNotStandard": "for a new custom object", "volume": "200,000, +5,000 a month",\n' +
      '  "recordTypes": ["..."], "fields": [{"name": "Renewal_Date__c", "type": "Date", "status": "new", "description": "..."}],\n' +
      '  "relationships": [{"field": "Account__c", "to": "Account", "kind": "lookup" | "master-detail", "reason": "..."}]}]}\n' +
      'or, when the work adds or changes no object: {"objects": []}',
    guidance:
      "the objects the work adds or changes, standard ones first, with their new and changed fields (API name and Metadata API type), record types, relationships and expected volumes. " +
      "Keep it at the level of a high-level design: the fields that matter to the solution, not every field. Existing objects and fields are checked against the index.",
    check: checkDataModel,
    summary: (s) => {
      const fields = s.objects.flatMap((o: { fields: { status: string }[] }) => o.fields).filter((f: { status: string }) => f.status !== "existing").length;
      return `${plural(s.objects.length, "object")} (${s.objects.filter((o: { status: string }) => o.status === "new").length} new), ${plural(fields, "new or changed field")}.`;
    },
  },
  {
    id: "automation",
    key: "automation",
    title: "Automation and business logic",
    schema: automationSection,
    principles: ["Flow or Apex", "Bulk and limits", "Technical debt"],
    traces: true,
    uses: ["currentState", "dataModel"],
    shape:
      '{"automations": [{"id": "A1", "name": "Policy_Renewal_Reminder", "type": "record-triggered flow" | "screen flow" | "scheduled flow" | "autolaunched flow" | "apex trigger" | "apex class" | "batch apex" | "platform event" | "other",\n' +
      '  "status": "new", "object": "Policy__c", "event": "before-save" | "after-save" | "delete" | "schedule" | "event" | "user", "order": 1, "what": "...", "why": "Flow, because ...", "requirementIds": ["R2"]}]}\n' +
      'or, when there is none: {"automations": []}',
    guidance:
      "each automation the work adds, changes or retires, and the existing ones it must work with on the same objects: its type, the object and event it runs on, its order among the others there, what it does, and why Flow or Apex. " +
      "Check the existing triggers and flows on each object with metadata_component. Give each an id (A1, A2...) and cite the requirement ids it addresses.",
    check: checkAutomation,
    summary: (s) => `${plural(s.automations.length, "automation")}.${cites(s.automations.flatMap((a: { requirementIds: string[] }) => a.requirementIds))}`,
  },
  {
    id: "integrations",
    key: "integrations",
    title: "Integrations",
    schema: integrationsSection,
    principles: ["Integrations"],
    industry: true,
    traces: true,
    uses: ["solution"],
    shape:
      '{"integrations": [{"id": "I1", "system": "Billing", "direction": "inbound" | "outbound" | "both",\n' +
      '  "pattern": "request and reply" | "fire and forget" | "batch data sync" | "remote call-in" | "ui update from data changes" | "data virtualisation",\n' +
      '  "mechanism": "Named Credential and External Service", "volume": "...", "frequency": "...", "errorHandling": "retries, logging, who is told", "requirementIds": ["R4"]}]}\n' +
      'or, when there is none: {"integrations": []}',
    guidance: "each system Salesforce exchanges data with: direction, pattern, mechanism, volume and frequency, and error handling. Give each an id (I1, I2...) and cite the requirement ids it addresses.",
    check: checkIntegrations,
    summary: (s) => `${plural(s.integrations.length, "integration")}.${cites(s.integrations.flatMap((i: { requirementIds: string[] }) => i.requirementIds))}`,
  },
  {
    id: "security",
    key: "security",
    title: "Security, sharing and non-functional requirements",
    schema: securitySection,
    principles: ["Security and sharing", "Bulk and limits"],
    industry: true,
    traces: true,
    uses: ["context", "dataModel"],
    shape:
      '{"sharing": [{"object": "Policy__c", "internal": "private" | "public read only" | "public read/write" | "controlled by parent", "external": "private", "notes": "..."}],\n' +
      ' "accessByPersona": "...",\n' +
      ' "measures": [{"id": "S1", "measure": "Field audit trail on Policy__c for 10 years", "requirementIds": ["R5"]}],\n' +
      ' "nonFunctional": [{"topic": "Performance", "target": "The renewal page opens in under 2 seconds", "requirementIds": ["R6"]}]}',
    guidance:
      "the sharing model of each object the work touches (internal and external defaults), access by persona, and the security and compliance measures (encryption, authentication, audit, retention, data residency), each with an id (S1, S2...) and the requirement ids it meets. " +
      "Every compliance requirement needs a measure. Then the non-functional targets (performance, volumes and limits, availability, retention and archiving, backup and restore), each citing its requirement ids.",
    check: checkSecurity,
    summary: (s) =>
      `${plural(s.measures.length, "measure")}, ${plural(s.sharing.length, "sharing setting")}, ${plural(s.nonFunctional.length, "target")}.${cites([...s.measures, ...s.nonFunctional].flatMap((m: { requirementIds: string[] }) => m.requirementIds))}`,
  },
  {
    id: "impact",
    key: "impact",
    title: "Impact on the existing org and delivery",
    schema: impactSection,
    principles: ["Delivery"],
    uses: ["dataModel", "automation"],
    shape:
      '{"changes": [{"type": "CustomField", "name": "Policy__c.Status__c", "change": "add" | "modify" | "delete", "risk": "low" | "medium" | "high", "notes": "what metadata_impact found"}],\n' +
      ' "delivery": "environments, DevOps, data migration, release sequencing, phases or MVP"}',
    guidance:
      "every component the design adds, changes or deletes, with its Metadata API type, its API name, the change and its risk. " +
      "Run metadata_impact on the changes first, in this run: a change or delete it did not look at is sent back. Carry its weak links into the notes, or into the risks at the next step. Then the delivery approach.",
    check: checkImpact,
    summary: (s) => `${plural(s.changes.length, "change")}, ${s.changes.filter((c: { risk: string }) => c.risk === "high").length} high risk.`,
  },
  {
    id: "decisions",
    key: "decisions",
    title: "Decisions, risks and open questions",
    schema: decisionsSection,
    traces: true,
    uses: ["solution"],
    shape:
      '{"decisions": [{"id": "D1", "title": "Flow or Apex for the renewal reminder", "options": ["Record-triggered flow", "Apex trigger"], "choice": "Record-triggered flow", "reason": "...", "requirementIds": ["R2"]}],\n' +
      ' "risks": [{"risk": "...", "mitigation": "..."}],\n' +
      ' "openQuestions": [{"question": "...", "owner": "Business owner"}]}',
    guidance:
      "the main decisions, each with the options considered, the choice and why (D1, D2...); the risks, with the weak links metadata_impact found; and the open questions, each with the role who should answer it. " +
      "Record every conflict between inputs as an open question that names both sources.",
    check: checkDecisions,
    summary: (s) => `${plural(s.decisions.length, "decision")}, ${plural(s.risks.length, "risk")}, ${plural(s.openQuestions.length, "open question")}.`,
  },
];

/** A section as the brief shows it: its JSON, cut when it is very long. */
function sectionJson(value: unknown): string {
  const json = JSON.stringify(value);
  return json.length > 20_000 ? `${json.slice(0, 20_000)}... (cut: read the rest with workflow_status)` : json;
}

function sectionStep<T>(spec: SectionSpec<T>): StepDefinition<T> {
  return {
    id: spec.id,
    title: spec.title,
    shape: spec.shape,
    schema: spec.schema,
    brief(s) {
      const confirmed = confirmedOf(s);
      const design = designSoFar(s.run);
      const open = unaddressed(design, confirmed).filter((r) => r.priority === "must");
      const docs = s.kit.contexts.documents(s.context);
      const earlier = (spec.uses ?? []).filter((k) => design[k] !== undefined);
      return [
        `Write the "${spec.title}" section of the high-level design: ${spec.guidance}`,
        ...(spec.principles?.length ? [spec.principles.map(principle).join("\n")] : []),
        ...(spec.industry ? [industryBlock(s.industry).trim()].filter(Boolean) : []),
        confirmed.length
          ? `Confirmed requirements${spec.traces ? " (cite the ids each item addresses; only these)" : ""}:\n${requirementsToText(confirmed)}`
          : "No requirement is confirmed: base the section on the inputs.",
        ...(spec.traces && open.length ? [`Must requirements no section addresses yet: ${open.map((r) => r.id).join(", ")}.`] : []),
        ...earlier.map((k) => `The ${k} section, as saved:\n${sectionJson(design[k])}`),
        `Context documents (read them with context_get):\n${docs.length ? docs.map(docLine).join("\n") : "- none"}`,
        "Write only what the inputs, the index or the earlier sections support; mark the rest as an assumption or an open question. Give API names as the index has them. Leave out an optional field rather than filling it with a placeholder.",
      ].join("\n\n");
    },
    async submit(answer, s): Promise<StepOutcome> {
      const masked = await maskDeep(s.kit.masker, s.context, answer);
      const findings = spec.check(masked, checkEnv(s));
      if (findings.some((f) => f.level === "error")) return { kind: "retry", attempt: true, findings };
      return { kind: "passed", findings, summary: spec.summary(masked), saved: masked };
    },
  };
}

export const hldSectionSteps: StepDefinition[] = SECTIONS.map((s) => sectionStep(s) as StepDefinition);

const gapSchema = z.object({ requirementId: z.string().regex(/^R[1-9]\d{0,5}$/, "use a requirement id such as R1"), reason: z.string().trim().min(3).max(500) }).strict();
type AssembleAnswer = { title: string; gaps: RequirementGap[] };

/** The last step: the sections put together, checked for coverage, rendered and saved. */
export const assembleStep: StepDefinition<AssembleAnswer> = {
  id: "assemble",
  title: "Assemble and save the design",
  shape:
    '{"title": "Policy renewals: high-level design",\n' +
    ' "gaps": [{"requirementId": "R7", "reason": "why no section addresses it: out of scope, or waiting on an open question"}]}',
  schema: z.object({ title: z.string().trim().min(3).max(200), gaps: z.array(gapSchema).max(60).default([]) }).strict() as z.ZodType<AssembleAnswer>,
  brief(s) {
    const design = designSoFar(s.run);
    const confirmed = confirmedOf(s);
    const open = unaddressed(design, confirmed);
    const missing = s.run.steps.filter((x) => HLD_SECTION_STEPS[x.step] && !design[HLD_SECTION_STEPS[x.step]!]).map((x) => x.step);
    return [
      "Give the design its title. The server puts the sections together in the template, with the traceability table computed from the requirement ids they cite, and saves it.",
      open.length
        ? `Confirmed requirements no section addresses:\n${requirementsToText(open)}\nFor each Must, give the reason in gaps (out of scope, waiting on an open question...): a Must left out without a reason is sent back. Give the reason for the others too.`
        : "Every confirmed requirement is addressed.",
      ...(missing.length ? [`These sections failed their checks and are left out of the design: ${missing.join(", ")}. Tell the user.`] : []),
    ].join("\n\n");
  },
  async submit(answer, s): Promise<StepOutcome> {
    const { kit, context, run } = s;
    const masked = await maskDeep(kit.masker, context, answer);
    const confirmed = confirmedOf(s);
    const design: HighLevelDesign = { ...designSoFar(run), title: masked.title };
    const findings: Finding[] = [];
    const known = new Set(confirmed.map((r) => r.id));
    const gaps = new Map(masked.gaps.map((g) => [g.requirementId, g.reason]));
    for (const id of gaps.keys()) if (!known.has(id)) findings.push({ level: "error", where: id, message: `${id} is not a confirmed requirement.` });
    for (const r of unaddressed(design, confirmed).filter((r) => !gaps.has(r.id)))
      findings.push(
        r.priority === "must"
          ? { level: "error", where: r.id, message: `Must requirement ${r.id} is addressed by no section: give the reason in gaps, or tell the user the design misses it.` }
          : { level: "warning", where: r.id, message: `${r.priority === "should" ? "Should" : r.priority === "could" ? "Could" : "Won't"} requirement ${r.id} is addressed by no section.` },
      );
    const failed = run.steps.filter((x) => x.status === "failed" && HLD_SECTION_STEPS[x.step]);
    for (const f of failed) findings.push({ level: "warning", where: f.step, message: `The ${f.step} section failed its checks and is left out of the design.` });
    if (findings.some((f) => f.level === "error")) return { kind: "retry", attempt: true, findings };
    const gapList = masked.gaps.filter((g) => known.has(g.requirementId));
    const content = renderHighLevelDesign(design, confirmed, gapList);
    const docs = new Set(kit.contexts.documents(context).map((d) => d.id));
    const sourceIds = [...new Set(confirmed.flatMap((r) => r.sourceIds))].filter((id) => docs.has(id));
    const doc = saveArtifact(kit.contexts, context, { kind: "design", title: design.title, content, artifactType: "high-level", sourceIds, extra: { design: { ...design, gaps: gapList } } });
    const version = doc.metadata.version;
    return { kind: "passed", findings, summary: `Saved as ${doc.id}, version ${version}: ${doc.title}.`, saved: { artifactId: doc.id, version } };
  },
};
