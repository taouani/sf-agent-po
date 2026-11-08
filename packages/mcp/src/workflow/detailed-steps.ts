// The detailed design as steps (phase 4, PR 5): the stories in scope first, then one step per
// section of the template, each answered as JSON, masked and checked on its own; then a last
// step that checks every story is built, renders the design and saves it.

import type { StepDefinition, StepOutcome } from "./engine.js";
import { z } from "zod";
import { saveArtifact } from "../artifacts.js";
import type { Finding } from "../backlog.js";
import { checkDecisions } from "../design/checks.js";
import {
  checkDdAutomation,
  checkDdDataModel,
  checkDdDeployment,
  checkDdIntegrations,
  checkDdScope,
  checkDdSecurity,
  checkDdTests,
  checkDdUserInterface,
  unbuiltStories,
} from "../design/detailed-checks.js";
import { renderDetailedDesign, type StoryGap } from "../design/detailed-render.js";
import {
  APEX_KINDS,
  ddAutomationSection,
  ddDataModelSection,
  ddDeploymentSection,
  ddIntegrationsSection,
  ddScopeSection,
  ddSecuritySection,
  ddTestsSection,
  ddUserInterfaceSection,
  STORY_REF,
  storyItems,
  type DetailedDesign,
} from "../design/detailed-schema.js";
import { maskDeep } from "../design/mask.js";
import { decisionsSection, FIELD_TYPES } from "../design/schema.js";
import { undeployed } from "../design/detailed-checks.js";
import { cites, confirmedOf, plural, sectionsSoFar, sectionStep, type DesignKind, type SectionSpec } from "./design-steps.js";

/** Section keys by step id, in the template's order. */
export const DD_SECTION_STEPS: Record<string, Exclude<keyof DetailedDesign, "title">> = {
  stories: "scope",
  "data-model": "dataModel",
  automation: "automation",
  "user-interface": "userInterface",
  integrations: "integrations",
  security: "security",
  tests: "tests",
  deployment: "deployment",
  decisions: "decisions",
};

export const detailedSoFar = (run: Parameters<typeof sectionsSoFar>[0]): DetailedDesign => sectionsSoFar<DetailedDesign>(run, DD_SECTION_STEPS);

const DD: DesignKind<DetailedDesign> = {
  name: "detailed design",
  steps: DD_SECTION_STEPS,
  openNote(design) {
    const open = unbuiltStories(design, storyItems(design));
    return open.length ? `Stories no section builds yet: ${open.join(", ")}. Cite each story in what builds it.` : undefined;
  },
};

const storiesOf = (ids: readonly { stories: string[] }[]) => {
  const all = [...new Set(ids.flatMap((i) => i.stories))];
  return all.length ? ` Builds ${all.join(", ")}.` : "";
};

const SECTIONS: SectionSpec<any, DetailedDesign>[] = [
  {
    id: "stories",
    key: "scope",
    title: "Stories in scope",
    schema: ddScopeSection,
    shape:
      '{"summary": "...", "highLevelDesignId": "doc-...", "backlogId": "doc-...",\n' +
      ' "stories": [{"ref": "S1" | "PROJ-12", "summary": "...", "requirementIds": ["R1"], "acceptanceCriteria": [{"id": "AC1", "text": "Given ..., when ..., then ..."}]}]}',
    guidance:
      "the stories or epics this design covers, and what it refines. Name the high-level design by its id, and the backlog the stories come from. " +
      "Give each story the id it has in that backlog, or its Jira key (read Jira issues with context_add_jira); with neither, give it a short id of your own (such as S1) and say where it comes from. " +
      "For each story, give its acceptance criteria in order as AC1, AC2...: every one gets a test later, and the stories of a backlog are checked against it.",
    check: checkDdScope,
    summary: (s) => `${plural(s.stories.length, "story", "stories")}, ${plural(s.stories.flatMap((x: { acceptanceCriteria: unknown[] }) => x.acceptanceCriteria).length, "acceptance criterion", "acceptance criteria")}.`,
  },
  {
    id: "data-model",
    key: "dataModel",
    title: "Data model changes",
    schema: ddDataModelSection,
    principles: ["Standard first", "Bulk and limits"],
    industry: true,
    openNote: true,
    uses: ["scope"],
    shape:
      '{"objects": [{"name": "Policy__c", "status": "changed", "stories": ["S1"],\n' +
      '  "fields": [{"name": "Renewal_Date__c", "label": "Renewal date", "type": "Date", "status": "new", "required": true, "helpText": "...",\n' +
      '    "classification": {"sensitivity": "internal", "compliance": []}, "access": [{"permissionSet": "Renewals_Agent", "read": true, "edit": true}]},\n' +
      '   {"name": "Channel__c", "label": "Channel", "type": "Picklist", "status": "new", "picklistValues": ["Email", "Letter"] (or "valueSet": "a global value set"), ...},\n' +
      '   {"name": "Reference__c", "label": "Reference", "type": "Text", "length": 40, "externalId": true, "unique": true, "defaultValue": "...", ...},\n' +
      '   {"name": "Premium__c", "label": "Premium", "type": "Currency", "precision": 16, "scale": 2, ...},\n' +
      '   {"name": "Days_Left__c", "label": "Days left", "type": "Formula", "returnType": "Number", "formula": "Renewal_Date__c - TODAY()", ...},\n' +
      '   {"name": "Account__c", "label": "Account", "type": "Lookup", "status": "new", "relationship": {"to": "Account", "kind": "lookup", "reason": "..."}, ...}],\n' +
      '  "recordTypes": [{"name": "...", "status": "new"}], "validationRules": [{"name": "...", "status": "new", "condition": "the error condition formula, in words or as a formula", "message": "..."}], "layouts": "..."}]}\n' +
      'or, when no object changes: {"objects": []}',
    guidance:
      "each object the stories add or change, with a field table: API name, label, type with its length or precision and scale, required, default, picklist values or a global value set, external ID and unique, help text, " +
      "data classification (sensitivity and compliance categories) and field-level security by permission set. Then the record types, validation rules and layout or Dynamic Forms changes. " +
      `Field types: ${FIELD_TYPES.join(", ")}. Give a field's name without its object. Existing objects, fields, record types and rules are checked against the index.`,
    check: checkDdDataModel,
    summary: (s) => {
      const fields = s.objects.flatMap((o: { fields: { status: string }[] }) => o.fields).filter((f: { status: string }) => f.status !== "existing").length;
      return `${plural(s.objects.length, "object")}, ${plural(fields, "new or changed field")}.${storiesOf(s.objects)}`;
    },
  },
  {
    id: "automation",
    key: "automation",
    title: "Automation",
    schema: ddAutomationSection,
    principles: ["Flow or Apex", "Bulk and limits", "Technical debt"],
    traces: true,
    uses: ["scope", "dataModel"],
    shape:
      '{"flows": [{"id": "F1", "name": "Policy_Renewal_Reminder", "kind": "record-triggered" | "screen" | "scheduled" | "autolaunched" | "platform event-triggered", "status": "new",\n' +
      '  "object": "Policy__c", "event": "create" | "update" | "create or update" | "delete", "timing": "before-save" | "after-save" | "async", "entryCriteria": "...",\n' +
      '  "runAs": "user" | "system with sharing" | "system without sharing", "steps": ["..."], "faultHandling": "...", "order": 1, "requirementIds": ["R1"], "stories": ["S1"]}],\n' +
      ` "apex": [{"id": "AP1", "name": "RenewalService", "kind": ${APEX_KINDS.map((k) => `"${k}"`).join(" | ")}, "status": "new", "object": "Policy__c",\n` +
      '  "events": ["after update"], "responsibility": "...", "sharing": "with sharing" | "without sharing" | "inherited sharing", "userMode": true, "async": false,\n' +
      '  "bulk": "how it handles 200 records", "testClass": "RenewalServiceTest", "why": "why Apex", "requirementIds": ["R2"], "stories": ["S1"]}],\n' +
      ' "orderNotes": "how this runs with the existing triggers and flows on the same objects"}',
    guidance:
      "each flow (kind, object, event and timing, entry criteria, run context, main steps, fault handling) and each Apex class or trigger (responsibility, entry point, sharing, user mode, sync or async, bulk behaviour, test class). " +
      "Check the existing triggers and flows on each object with metadata_component, and say how the new automation fits in their order. Keep one trigger per object, with the logic in a handler. " +
      "An existing flow, class or trigger listed only for the order needs no more than its id, name, kind, status, object and events.",
    check: checkDdAutomation,
    summary: (s) => `${plural(s.flows.length, "flow")}, ${plural(s.apex.length, "Apex class or trigger", "Apex classes or triggers")}.${cites([...s.flows, ...s.apex].flatMap((x: { requirementIds: string[] }) => x.requirementIds))}`,
  },
  {
    id: "user-interface",
    key: "userInterface",
    title: "User interface",
    schema: ddUserInterfaceSection,
    openNote: true,
    uses: ["scope"],
    shape:
      '{"pages": [{"name": "Policy record page", "kind": "record page" | "app page" | "home page" | "experience page" | "utility bar", "status": "changed", "object": "Policy__c", "content": "...", "stories": ["S1"]}],\n' +
      ' "components": [{"name": "renewalPanel", "kind": "lwc" | "aura" | "quick action" | "list view" | "flow screen" | "visualforce" | "other", "status": "new", "purpose": "...", "inputs": ["recordId"], "events": ["renewalsent"], "stories": ["S1"]}]}\n' +
      'or, when nothing changes: {"pages": [], "components": []}',
    guidance: "the Lightning pages, components (Lightning web components with their inputs and events), quick actions, list views and Experience Cloud pages the stories add or change.",
    check: checkDdUserInterface,
    summary: (s) => `${plural(s.pages.length, "page")}, ${plural(s.components.length, "component")}.`,
  },
  {
    id: "integrations",
    key: "integrations",
    title: "Integrations",
    schema: ddIntegrationsSection,
    principles: ["Integrations"],
    industry: true,
    traces: true,
    uses: ["scope"],
    shape:
      '{"integrations": [{"id": "I1", "system": "Billing", "direction": "outbound", "pattern": "fire and forget", "endpoint": "...", "namedCredential": "Billing_API", "externalCredential": "...",\n' +
      '  "authentication": "OAuth 2.0 client credentials", "integrationUser": "...", "mapping": "...", "errorHandling": "...", "retries": "...", "logging": "...", "limits": "...", "requirementIds": [], "stories": ["S2"]}]}\n' +
      'or, when there is none: {"integrations": []}',
    guidance:
      "per interface: endpoint and authentication (Named and External Credentials), the integration user (a dedicated API-only user with least-privilege permission sets), the payload mapping, error and retry handling, logging and limits.",
    check: checkDdIntegrations,
    summary: (s) => `${plural(s.integrations.length, "integration")}.`,
  },
  {
    id: "security",
    key: "security",
    title: "Security",
    schema: ddSecuritySection,
    principles: ["Security and sharing"],
    industry: true,
    openNote: true,
    uses: ["scope", "dataModel"],
    shape:
      '{"permissionSets": [{"name": "Renewals_Agent", "status": "new", "purpose": "...", "grants": ["Policy__c: read, edit", "Policy__c.Renewal_Date__c: edit", "Apex class RenewalService"], "group": "Renewals", "stories": ["S1"]}],\n' +
      ' "sharing": [{"object": "Letter__c", "internal": "controlled by parent", "external": "private", "rules": ["..."]}],\n' +
      ' "customPermissions": [{"name": "Send_Renewal", "status": "new", "purpose": "...", "stories": ["S1"]}], "guestAccess": "..."}',
    guidance:
      "the permission sets and permission set groups to create or change (every one the field tables name), the internal and external org-wide defaults, sharing rules, custom permissions, and guest-user access for public Experience Cloud pages.",
    check: checkDdSecurity,
    summary: (s) => `${plural(s.permissionSets.length, "permission set")}, ${plural(s.sharing.length, "sharing setting")}.`,
  },
  {
    id: "tests",
    key: "tests",
    title: "Test approach",
    schema: ddTestsSection,
    uses: ["scope", "automation"],
    shape:
      '{"apex": [{"testClass": "RenewalServiceTest", "covers": ["RenewalService"], "scenarios": ["200 policies at once", "a user without the permission set"]}],\n' +
      ' "flows": [{"flow": "Policy_Renewal_Reminder", "scenarios": ["..."]}],\n' +
      ' "acceptance": [{"story": "S1", "criterion": "AC1", "kind": "manual" | "apex" | "flow test" | "ui automation", "test": "..."}], "data": "how the test data is made"}',
    guidance:
      "the Apex tests (each class's scenarios: bulk, negative, permissions), the Flow tests, and one acceptance test or more for every acceptance criterion of every story in scope, with the test data.",
    check: checkDdTests,
    summary: (s) => `${plural(s.acceptance.length, "acceptance test")}, ${plural(s.apex.length, "Apex test class", "Apex test classes")}.`,
  },
  {
    id: "deployment",
    key: "deployment",
    title: "Deployment",
    schema: ddDeploymentSection,
    principles: ["Delivery"],
    uses: ["scope"],
    extra(design) {
      const list = undeployed(design);
      return list.length
        ? `What the other sections add or change, each needing a deployment entry:\n${list.map((c) => `- ${c.type} ${c.name}`).join("\n")}`
        : "The other sections add or change no metadata component.";
    },
    shape:
      '{"components": [{"type": "CustomField", "name": "Policy__c.Renewal_Date__c", "change": "add" | "modify" | "delete", "stories": ["S1"], "notes": "..."}],\n' +
      ' "preSteps": ["..."], "postSteps": ["..."], "dataLoads": ["..."], "rollback": "..."}',
    guidance:
      "every metadata component to deploy, with its Metadata API type and API name (each one listed below, and any other), the stories it builds, the pre- and post-deployment steps, the data loads, and the rollback. " +
      "Run metadata_impact on the components you change or delete first, in this run.",
    check: checkDdDeployment,
    summary: (s) => `${plural(s.components.length, "component")} to deploy.${storiesOf(s.components)}`,
  },
  {
    id: "decisions",
    key: "decisions",
    title: "Open questions and risks",
    schema: decisionsSection,
    traces: true,
    openNote: false,
    uses: ["scope"],
    shape:
      '{"decisions": [{"id": "D1", "title": "...", "options": ["...", "..."], "choice": "...", "reason": "...", "requirementIds": []}],\n' +
      ' "risks": [{"risk": "...", "mitigation": "..."}], "openQuestions": [{"question": "...", "owner": "Business owner"}]}',
    guidance: "the decisions this design takes (options, choice and why), the risks with the weak links metadata_impact found, and the open questions with the role who should answer each.",
    check: checkDecisions,
    summary: (s) => `${plural(s.decisions.length, "decision")}, ${plural(s.risks.length, "risk")}, ${plural(s.openQuestions.length, "open question")}.`,
  },
];

export const ddSectionSteps: StepDefinition[] = SECTIONS.map((s) => sectionStep(s, DD) as StepDefinition);

const gapSchema = z.strictObject({ story: z.string().regex(STORY_REF, "use a story in scope, such as S1 or PROJ-12"), reason: z.string().trim().min(3).max(500) });
type AssembleAnswer = { title: string; gaps: StoryGap[] };

/** The last step: the sections put together, checked for stories nothing builds, rendered and saved. */
export const ddAssembleStep: StepDefinition<AssembleAnswer> = {
  id: "assemble",
  title: "Assemble and save the design",
  shape: '{"title": "Renewal letters: detailed design",\n "gaps": [{"story": "S3", "reason": "why no section builds it: configuration only, or waiting on an open question"}]}',
  schema: z.strictObject({ title: z.string().trim().min(3).max(200), gaps: z.array(gapSchema).max(40).default([]) }) as z.ZodType<AssembleAnswer>,
  brief(s) {
    const design = detailedSoFar(s.run);
    const open = unbuiltStories(design, storyItems(design));
    const missing = s.run.steps.filter((x) => DD_SECTION_STEPS[x.step] && !design[DD_SECTION_STEPS[x.step]!]).map((x) => x.step);
    return [
      "Give the design its title. The server puts the sections together in the template, with the story traceability computed from what each part cites, and saves it.",
      open.length ? `Stories no section builds: ${open.join(", ")}. Give the reason for each in gaps, or the step is sent back.` : "Every story in scope is built by some part of the design.",
      ...(missing.length ? [`These sections failed their checks and are left out of the design: ${missing.join(", ")}. Tell the user.`] : []),
    ].join("\n\n");
  },
  async submit(answer, s): Promise<StepOutcome> {
    const { kit, context, run } = s;
    const masked = await maskDeep(kit.masker, context, answer);
    const design: DetailedDesign = { ...detailedSoFar(run), title: masked.title };
    const findings: Finding[] = [];
    const inScope = new Set((design.scope?.stories ?? []).map((x) => x.ref));
    const gaps = new Map(masked.gaps.map((g) => [g.story, g.reason]));
    for (const ref of gaps.keys()) if (!inScope.has(ref)) findings.push({ level: "error", where: ref, message: `${ref} is not a story in scope.` });
    for (const ref of unbuiltStories(design, storyItems(design)).filter((r) => !gaps.has(r)))
      findings.push({ level: "error", where: ref, message: `No section builds ${ref}: give the reason in gaps, or tell the user the design misses it.` });
    for (const f of run.steps.filter((x) => x.status === "failed" && DD_SECTION_STEPS[x.step]))
      findings.push({ level: "warning", where: f.step, message: `The ${f.step} section failed its checks and is left out of the design.` });
    if (!design.scope) findings.push({ level: "warning", where: "stories", message: "The stories step failed, so nothing ties the design to its stories." });
    if (findings.some((f) => f.level === "error")) return { kind: "retry", attempt: true, findings };
    const confirmed = confirmedOf(s);
    const gapList = masked.gaps.filter((g) => inScope.has(g.story));
    const content = renderDetailedDesign(design, confirmed, gapList);
    const docs = new Set(kit.contexts.documents(context).map((d) => d.id));
    const cited = new Set((design.scope?.stories ?? []).flatMap((x) => x.requirementIds));
    const sourceIds = [
      ...new Set([design.scope?.highLevelDesignId, design.scope?.backlogId, ...confirmed.filter((r) => cited.has(r.id)).flatMap((r) => r.sourceIds)].filter((id): id is string => Boolean(id))),
    ].filter((id) => docs.has(id));
    const doc = saveArtifact(kit.contexts, context, { kind: "design", title: design.title, content, artifactType: "detailed", sourceIds, extra: { design: { ...design, gaps: gapList } } });
    return { kind: "passed", findings, summary: `Saved as ${doc.id}, version ${doc.metadata.version}: ${doc.title}.`, saved: { artifactId: doc.id, version: doc.metadata.version } };
  },
};
