// The detailed design as JSON (phase 4, PR 5): one part per section of the template, each
// answered and checked in its own step. It starts from the stories in scope and their
// acceptance criteria; every part cites the stories it builds, so the tests mapped to each
// criterion, the deployment list and the Jira sub-tasks are computed from it.

import { z } from "zod";
import { INTEGRATION_PATTERNS, list, localId, requirementIds, SHARING, STATUS, text, type DecisionsSection } from "./schema.js";

/** A story in scope: a backlog id (S1) or a Jira key (PROJ-12). */
export const STORY_REF = /^(S[1-9]\d{0,3}|[A-Z][A-Z0-9_]+-[1-9]\d{0,6})$/;
const storyRef = z.string().trim().regex(STORY_REF, "use a backlog story id such as S1, or a Jira key such as PROJ-12");
const stories = z.array(storyRef).max(40).default([]);
const documentId = z.string().regex(/^doc-[0-9a-f]{10}$/, "use a document id such as doc-1a2b3c4d5e");

export const ddScopeSection = z.strictObject({
  summary: text(),
  highLevelDesignId: documentId.optional().describe("The high-level design this refines."),
  backlogId: documentId.optional().describe("The backlog the stories come from."),
  stories: list(
    z.strictObject({
      ref: storyRef,
      summary: text(300),
      requirementIds,
      acceptanceCriteria: list(z.strictObject({ id: localId("AC"), text: text(1_000) }), 30).min(1),
    }),
    40,
  ).min(1),
});

export const SENSITIVITY = ["public", "internal", "confidential", "restricted"] as const;

export const ddDataModelSection = z.strictObject({
  objects: list(
    z.strictObject({
      name: text(120),
      label: text(120).optional(),
      status: z.enum(STATUS),
      stories,
      fields: list(
        z.strictObject({
          name: text(120),
          label: text(120),
          type: text(60),
          status: z.enum(STATUS),
          length: z.number().int().positive().optional(),
          precision: z.number().int().positive().optional(),
          scale: z.number().int().nonnegative().optional(),
          required: z.boolean().default(false),
          defaultValue: text(300).optional(),
          picklistValues: list(text(255), 500).default([]),
          valueSet: text(120).optional().describe("A global value set, instead of picklistValues."),
          externalId: z.boolean().default(false),
          unique: z.boolean().default(false),
          helpText: text(510).optional(),
          description: text(1_000).optional(),
          classification: z.strictObject({ sensitivity: z.enum(SENSITIVITY), compliance: list(text(60), 10).default([]) }).optional(),
          access: list(z.strictObject({ permissionSet: text(120), read: z.boolean().default(true), edit: z.boolean().default(false) }), 30).default([]),
          relationship: z.strictObject({ to: text(120), kind: z.enum(["lookup", "master-detail"]), reason: text(500).optional() }).optional(),
        }),
        100,
      ).default([]),
      recordTypes: list(z.strictObject({ name: text(120), status: z.enum(STATUS), description: text(500).optional() }), 20).default([]),
      validationRules: list(z.strictObject({ name: text(120), status: z.enum(STATUS), condition: text(2_000), message: text(255) }), 40).default([]),
      layouts: text(2_000).optional().describe("Page layout or Dynamic Forms changes."),
    }),
    40,
  ),
});

export const FLOW_KINDS = ["record-triggered", "screen", "scheduled", "autolaunched", "platform event-triggered"] as const;
export const APEX_KINDS = ["trigger", "handler", "service", "selector", "queueable", "batch", "schedulable", "invocable", "rest resource", "platform event subscriber", "controller", "other"] as const;
export const TRIGGER_EVENTS = ["before insert", "before update", "before delete", "after insert", "after update", "after delete", "after undelete"] as const;

export const ddAutomationSection = z.strictObject({
  flows: list(
    z.strictObject({
      id: localId("F"),
      name: text(200),
      kind: z.enum(FLOW_KINDS),
      status: z.enum(STATUS),
      object: text(120).optional(),
      event: z.enum(["create", "update", "create or update", "delete"]).optional(),
      timing: z.enum(["before-save", "after-save", "async"]).optional(),
      entryCriteria: text(1_000).optional(),
      runAs: z.enum(["user", "system with sharing", "system without sharing"]),
      steps: list(text(500), 40).min(1),
      faultHandling: text(1_000).optional(),
      order: z.number().int().positive().optional(),
      requirementIds,
      stories,
    }),
    40,
  ).default([]),
  apex: list(
    z.strictObject({
      id: localId("AP"),
      name: text(200),
      kind: z.enum(APEX_KINDS),
      status: z.enum(STATUS),
      object: text(120).optional(),
      events: list(z.enum(TRIGGER_EVENTS), 7).default([]),
      responsibility: text(1_000),
      sharing: z.enum(["with sharing", "without sharing", "inherited sharing"]),
      userMode: z.boolean().describe("Database operations in user mode (WITH USER_MODE, AccessLevel.USER_MODE)."),
      async: z.boolean().default(false),
      bulk: text(500).describe("How it handles 200 records at once."),
      testClass: text(200),
      why: text(1_000).optional().describe("Why Apex rather than Flow, and why without sharing when it is."),
      requirementIds,
      stories,
    }),
    40,
  ).default([]),
  orderNotes: text(2_000).optional().describe("The order of execution with the existing automation on the same objects."),
});

export const ddUserInterfaceSection = z.strictObject({
  pages: list(
    z.strictObject({
      name: text(200),
      kind: z.enum(["record page", "app page", "home page", "experience page", "utility bar"]),
      status: z.enum(STATUS),
      object: text(120).optional(),
      content: text(2_000),
      stories,
    }),
    30,
  ).default([]),
  components: list(
    z.strictObject({
      name: text(200),
      kind: z.enum(["lwc", "aura", "quick action", "list view", "flow screen", "visualforce", "other"]),
      status: z.enum(STATUS),
      purpose: text(1_000),
      inputs: list(text(200), 30).default([]),
      events: list(text(200), 30).default([]),
      stories,
    }),
    40,
  ).default([]),
});

export const ddIntegrationsSection = z.strictObject({
  integrations: list(
    z.strictObject({
      id: localId("I"),
      system: text(200),
      direction: z.enum(["inbound", "outbound", "both"]),
      pattern: z.enum(INTEGRATION_PATTERNS),
      endpoint: text(500).optional(),
      namedCredential: text(120).optional(),
      externalCredential: text(120).optional(),
      authentication: text(500),
      integrationUser: text(200).optional().describe("A dedicated API-only user with least-privilege permission sets."),
      mapping: text(),
      errorHandling: text(1_000),
      retries: text(500).optional(),
      logging: text(500).optional(),
      limits: text(500).optional(),
      requirementIds,
      stories,
    }),
    30,
  ),
});

export const ddSecuritySection = z.strictObject({
  permissionSets: list(
    z.strictObject({
      name: text(120),
      status: z.enum(STATUS),
      purpose: text(500),
      grants: list(text(300), 60).min(1),
      group: text(120).optional().describe("The permission set group it belongs to."),
      stories,
    }),
    30,
  ).default([]),
  sharing: list(z.strictObject({ object: text(120), internal: z.enum(SHARING), external: z.enum(SHARING).optional(), rules: list(text(500), 20).default([]) }), 40).default([]),
  customPermissions: list(z.strictObject({ name: text(120), purpose: text(500), stories }), 30).default([]),
  guestAccess: text(2_000).optional(),
});

export const ddTestsSection = z.strictObject({
  apex: list(z.strictObject({ testClass: text(200), covers: list(text(200), 20).min(1), scenarios: list(text(500), 40).min(1) }), 40).default([]),
  flows: list(z.strictObject({ flow: text(200), scenarios: list(text(500), 40).min(1) }), 40).default([]),
  acceptance: list(
    z.strictObject({ story: storyRef, criterion: localId("AC"), kind: z.enum(["manual", "apex", "flow test", "ui automation"]), test: text(1_000) }),
    200,
  ).default([]),
  data: text(2_000).optional().describe("The test data and how it is created."),
});

export const ddDeploymentSection = z.strictObject({
  components: list(
    z.strictObject({ type: text(80), name: text(200), change: z.enum(["add", "modify", "delete"]), stories, notes: text(1_000).optional() }),
    200,
  ),
  preSteps: list(text(500), 30).default([]),
  postSteps: list(text(500), 30).default([]),
  dataLoads: list(text(500), 30).default([]),
  rollback: text(2_000),
});

export type DdScopeSection = z.infer<typeof ddScopeSection>;
export type DdDataModelSection = z.infer<typeof ddDataModelSection>;
export type DdAutomationSection = z.infer<typeof ddAutomationSection>;
export type DdUserInterfaceSection = z.infer<typeof ddUserInterfaceSection>;
export type DdIntegrationsSection = z.infer<typeof ddIntegrationsSection>;
export type DdSecuritySection = z.infer<typeof ddSecuritySection>;
export type DdTestsSection = z.infer<typeof ddTestsSection>;
export type DdDeploymentSection = z.infer<typeof ddDeploymentSection>;

/** A whole detailed design, as the last step puts it together. */
export interface DetailedDesign {
  title: string;
  scope?: DdScopeSection;
  dataModel?: DdDataModelSection;
  automation?: DdAutomationSection;
  userInterface?: DdUserInterfaceSection;
  integrations?: DdIntegrationsSection;
  security?: DdSecuritySection;
  tests?: DdTestsSection;
  deployment?: DdDeploymentSection;
  decisions?: DecisionsSection;
}

/** What builds each story, by section: each part and the stories it cites. */
export function storyItems(d: DetailedDesign): { section: string; item: string; stories: string[] }[] {
  return [
    ...(d.dataModel?.objects ?? []).map((o) => ({ section: "Data model", item: o.name, stories: o.stories })),
    ...(d.automation?.flows ?? []).map((f) => ({ section: "Automation", item: `${f.id} ${f.name}`, stories: f.stories })),
    ...(d.automation?.apex ?? []).map((a) => ({ section: "Automation", item: `${a.id} ${a.name}`, stories: a.stories })),
    ...(d.userInterface?.pages ?? []).map((p) => ({ section: "User interface", item: p.name, stories: p.stories })),
    ...(d.userInterface?.components ?? []).map((c) => ({ section: "User interface", item: c.name, stories: c.stories })),
    ...(d.integrations?.integrations ?? []).map((i) => ({ section: "Integrations", item: `${i.id} ${i.system}`, stories: i.stories })),
    ...(d.security?.permissionSets ?? []).map((p) => ({ section: "Security", item: p.name, stories: p.stories })),
    ...(d.security?.customPermissions ?? []).map((p) => ({ section: "Security", item: p.name, stories: p.stories })),
    ...(d.deployment?.components ?? []).map((c) => ({ section: "Deployment", item: `${c.type} ${c.name}`, stories: c.stories })),
  ];
}

/** What addresses requirements in a detailed design: automation and integrations, and through the stories. */
export function ddTracedItems(d: DetailedDesign): { section: string; item: string; requirementIds: string[] }[] {
  return [
    ...(d.automation?.flows ?? []).map((f) => ({ section: "Automation", item: `${f.id} ${f.name}`, requirementIds: f.requirementIds })),
    ...(d.automation?.apex ?? []).map((a) => ({ section: "Automation", item: `${a.id} ${a.name}`, requirementIds: a.requirementIds })),
    ...(d.integrations?.integrations ?? []).map((i) => ({ section: "Integrations", item: `${i.id} ${i.system}`, requirementIds: i.requirementIds })),
    ...(d.decisions?.decisions ?? []).map((x) => ({ section: "Decisions", item: `${x.id} ${x.title}`, requirementIds: x.requirementIds })),
  ];
}
