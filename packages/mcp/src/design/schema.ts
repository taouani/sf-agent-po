// The high-level design as JSON (phase 4, section 4 of the plan): one part per section of the
// template, each answered and checked in its own step. Components, automations, integrations,
// security measures and decisions carry the ids of the requirements they address, so the
// traceability is computed from them and never drifts. Stored masked, like every document.

import { z } from "zod";

const text = (max = 4_000) => z.string().trim().min(1).max(max);
const list = <T extends z.ZodTypeAny>(item: T, max = 60) => z.array(item).max(max);
const requirementIds = z.array(z.string().regex(/^R[1-9]\d{0,5}$/, "use requirement ids such as R1")).max(40).default([]);
const localId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[1-9]\\d{0,3}$`), `use an id such as ${prefix}1`);
const STATUS = ["existing", "new", "changed", "retired"] as const;
const SHARING = ["private", "public read only", "public read/write", "controlled by parent"] as const;

export const contextSection = z
  .object({
    goals: list(text(500), 20).min(1),
    inScope: list(text(500), 40).min(1),
    outOfScope: list(text(500), 40).default([]),
    assumptions: list(text(500), 40).default([]),
    personas: list(
      z.strictObject({
        name: text(120).describe('A role, e.g. "Renewals agent", not "user".'),
        internal: z.boolean().describe("true for employees, false for customers, partners or the public."),
        does: text(500),
        licence: text(200).optional().describe('e.g. "Sales Cloud Enterprise", "Customer Community Plus".'),
        count: z.number().int().nonnegative().optional(),
      }),
      30,
    ).min(1),
  });

export const currentStateSection = z
  .object({
    summary: text(),
    components: list(
      z.strictObject({
        type: text(80).describe('Metadata type, e.g. "CustomObject", "Flow", "ApexTrigger".'),
        name: text(200).describe("The API name, exactly as the index has it."),
        notes: text(500).optional(),
      }),
      100,
    ).default([]),
    debt: list(z.strictObject({ component: text(200), issue: text(500) }), 60).default([]),
  });

export const solutionSection = z
  .object({
    overview: text(),
    orgStrategy: text(1_000).describe("Existing org, new org or several, and why."),
    components: list(
      z.strictObject({
        id: localId("C"),
        name: text(200).describe("The product, feature or component; for an existing or changed one, its API name as the index has it."),
        type: text(80).describe('e.g. "Sales Cloud", "Experience Cloud site", "CustomObject", "Flow", "LWC", "ApexClass".'),
        status: z.enum(STATUS),
        purpose: text(1_000),
        requirementIds,
      }),
      60,
    ).min(1),
    userExperience: text().optional(),
    reporting: text().optional(),
    diagram: z
      .object({
        nodes: list(z.strictObject({ id: z.string().regex(/^[A-Za-z]\w{0,40}$/, "use letters, digits and underscores, such as sf or erp"), label: text(120), kind: z.enum(["salesforce", "external", "user", "data"]).default("salesforce") }), 40).min(1),
        edges: list(z.strictObject({ from: z.string(), to: z.string(), label: text(120).optional() }), 80).default([]),
      })
      .optional(),
  });

/** Salesforce field types, as the Metadata API names them. */
export const FIELD_TYPES = [
  "AutoNumber", "Checkbox", "Currency", "Date", "DateTime", "Email", "EncryptedText", "ExternalLookup", "Formula", "Geolocation", "Html", "IndirectLookup",
  "Location", "LongTextArea", "Lookup", "MasterDetail", "MetadataRelationship", "MultiselectPicklist", "Number", "Percent", "Phone", "Picklist", "Summary",
  "Text", "TextArea", "Time", "Url", "Hierarchy",
  // Standard fields only.
  "Address", "Id", "Name",
] as const;

export const dataModelSection = z
  .object({
    objects: list(
      z.strictObject({
        name: text(120).describe('API name: "Account" for a standard object, "Policy__c" for a custom one.'),
        label: text(120).optional(),
        status: z.enum(STATUS),
        whyNotStandard: text(1_000).optional().describe("For a new custom object: why no standard object fits."),
        volume: text(200).optional().describe('Expected records, e.g. "200,000, +5,000 a month".'),
        recordTypes: list(text(120), 20).default([]),
        fields: list(
          z.strictObject({
            name: text(120).describe('API name, e.g. "Renewal_Date__c".'),
            type: z.string().describe(`One of: ${FIELD_TYPES.join(", ")}.`),
            status: z.enum(STATUS),
            description: text(500).optional(),
          }),
          80,
        ).default([]),
        relationships: list(
          z.strictObject({
            field: text(120),
            to: text(120).describe("The object it points to."),
            kind: z.enum(["lookup", "master-detail"]),
            reason: text(500).optional(),
          }),
          20,
        ).default([]),
      }),
      40,
    ),
  });

export const AUTOMATION_TYPES = ["record-triggered flow", "screen flow", "scheduled flow", "autolaunched flow", "apex trigger", "apex class", "batch apex", "platform event", "other"] as const;

export const automationSection = z
  .object({
    automations: list(
      z.strictObject({
        id: localId("A"),
        name: text(200),
        type: z.enum(AUTOMATION_TYPES),
        status: z.enum(STATUS),
        object: text(120).optional().describe("The object it runs on, for record-triggered automation."),
        event: z.enum(["before-save", "after-save", "delete", "schedule", "event", "user"]).optional(),
        order: z.number().int().positive().optional().describe("Its place among automations on the same object and event."),
        what: text(1_000),
        why: text(1_000).optional().describe("Why Flow or Apex for this one."),
        requirementIds,
      }),
      60,
    ),
  });

/** The integration patterns of the SA principles. */
export const INTEGRATION_PATTERNS = ["request and reply", "fire and forget", "batch data sync", "remote call-in", "ui update from data changes", "data virtualisation"] as const;

export const integrationsSection = z
  .object({
    integrations: list(
      z.strictObject({
        id: localId("I"),
        system: text(200),
        direction: z.enum(["inbound", "outbound", "both"]),
        pattern: z.enum(INTEGRATION_PATTERNS),
        mechanism: text(300).describe("e.g. Named Credential and External Service, Platform Events, Bulk API, MuleSoft."),
        volume: text(300).optional(),
        frequency: text(300).optional(),
        errorHandling: text(1_000).optional(),
        requirementIds,
      }),
      40,
    ),
  });

export const securitySection = z
  .object({
    sharing: list(
      z.strictObject({
        object: text(120),
        internal: z.enum(SHARING),
        external: z.enum(SHARING).optional(),
        notes: text(500).optional(),
      }),
      40,
    ).default([]),
    accessByPersona: text().optional(),
    measures: list(z.strictObject({ id: localId("S"), measure: text(1_000), requirementIds }), 40).default([]),
    nonFunctional: list(z.strictObject({ requirementIds, topic: text(120), target: text(500) }), 40).default([]),
  });

export const impactSection = z
  .object({
    changes: list(
      z.strictObject({
        type: text(80),
        name: text(200),
        change: z.enum(["add", "modify", "delete"]),
        risk: z.enum(["low", "medium", "high"]),
        notes: text(1_000).optional(),
      }),
      100,
    ),
    delivery: text().optional().describe("Environments, DevOps, data migration, release sequencing, phases or MVP."),
  });

export const decisionsSection = z
  .object({
    decisions: list(
      z.strictObject({
        id: localId("D"),
        title: text(300),
        options: list(text(500), 6).min(2, "list at least two options considered"),
        choice: text(500),
        reason: text(1_000),
        requirementIds,
      }),
      40,
    ),
    risks: list(z.strictObject({ risk: text(500), mitigation: text(500).optional() }), 40).default([]),
    openQuestions: list(z.strictObject({ question: text(500), owner: text(120).optional() }), 40).default([]),
  });

export type ContextSection = z.infer<typeof contextSection>;
export type CurrentStateSection = z.infer<typeof currentStateSection>;
export type SolutionSection = z.infer<typeof solutionSection>;
export type DataModelSection = z.infer<typeof dataModelSection>;
export type AutomationSection = z.infer<typeof automationSection>;
export type IntegrationsSection = z.infer<typeof integrationsSection>;
export type SecuritySection = z.infer<typeof securitySection>;
export type ImpactSection = z.infer<typeof impactSection>;
export type DecisionsSection = z.infer<typeof decisionsSection>;

/** The schema's fixed words (statuses, patterns, kinds...): not text the agent wrote, so not language to check. */
export const FIXED_WORDS: ReadonlySet<string> = new Set<string>([
  ...STATUS, ...SHARING, ...AUTOMATION_TYPES, ...INTEGRATION_PATTERNS, ...FIELD_TYPES,
  "salesforce", "external", "user", "data", "lookup", "master-detail", "before-save", "after-save", "delete", "schedule", "event",
  "inbound", "outbound", "both", "add", "modify", "low", "medium", "high",
]);

/** A whole high-level design, as the last step puts it together. */
export interface HighLevelDesign {
  title: string;
  context?: ContextSection;
  currentState?: CurrentStateSection;
  solution?: SolutionSection;
  dataModel?: DataModelSection;
  automation?: AutomationSection;
  integrations?: IntegrationsSection;
  security?: SecuritySection;
  impact?: ImpactSection;
  decisions?: DecisionsSection;
}

/** What addresses requirements, by section: each item's id (or name) and the ids it cites. */
export function tracedItems(d: HighLevelDesign): { section: string; item: string; requirementIds: string[] }[] {
  return [
    ...(d.solution?.components ?? []).map((c) => ({ section: "Solution", item: `${c.id} ${c.name}`, requirementIds: c.requirementIds })),
    ...(d.automation?.automations ?? []).map((a) => ({ section: "Automation", item: `${a.id} ${a.name}`, requirementIds: a.requirementIds })),
    ...(d.integrations?.integrations ?? []).map((i) => ({ section: "Integrations", item: `${i.id} ${i.system}`, requirementIds: i.requirementIds })),
    ...(d.security?.measures ?? []).map((m) => ({ section: "Security", item: `${m.id} ${m.measure}`, requirementIds: m.requirementIds })),
    ...(d.security?.nonFunctional ?? []).map((n) => ({ section: "Non-functional", item: n.topic, requirementIds: n.requirementIds })),
    ...(d.decisions?.decisions ?? []).map((x) => ({ section: "Decisions", item: `${x.id} ${x.title}`, requirementIds: x.requirementIds })),
  ];
}
