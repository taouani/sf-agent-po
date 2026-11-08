import type { IndexedComponent, Requirement } from "@sf-agent-po/core";
import { describe, expect, it } from "vitest";
import {
  automationSection,
  checkDataModel,
  checkSecurity,
  dataModelSection,
  impactKey,
  checkAutomation,
  checkCurrentState,
  checkImpact,
  checkIntegrations,
  checkRules,
  checkSolution,
  contextSection,
  currentStateSection,
  integrationsSection,
  renderHighLevelDesign,
  solutionSection,
  type DesignCheckEnv,
} from "../src/index.js";

const requirement = (id: string, kind: Requirement["kind"], priority: Requirement["priority"] = "must"): Requirement => ({
  context: "c",
  id,
  kind,
  statement: `Statement ${id}`,
  priority,
  status: "confirmed",
  origin: "agent",
  sourceIds: ["doc-000000000a"],
  createdAt: "",
  updatedAt: "",
});

const component = (type: string, name: string, attrs: Record<string, unknown> = {}) => ({ id: 1, type, name, attrs, missing: false }) as unknown as IndexedComponent;

/** An index holding these components, by "type:name". */
function env(components: IndexedComponent[] = [], extra: Partial<DesignCheckEnv> = {}): DesignCheckEnv {
  const byKey = new Map(components.map((c) => [`${c.type}:${c.name}`.toLowerCase(), c]));
  return {
    requirements: [requirement("R1", "functional"), requirement("R2", "compliance")],
    design: { title: "" },
    rules: checkRules("en"),
    lookup: (type, name) => byKey.get(`${type}:${name}`.toLowerCase()),
    ...extra,
  };
}

const lines = (findings: { level: string; where: string; message: string }[]) => findings.map((f) => `${f.level} ${f.where}: ${f.message}`);

describe("design section checks", () => {
  it("flag Process Builder and Workflow Rules left out of the debt, and only say a standard object may be missing", () => {
    const index = [component("Flow", "Old_Process", { processType: "Workflow" }), component("WorkflowRule", "Policy__c.Notify"), component("Flow", "New_Flow", { processType: "AutoLaunchedFlow" })];
    const s = currentStateSection.parse({
      summary: "What exists.",
      components: [
        { type: "Flow", name: "Old_Process" },
        { type: "WorkflowRule", name: "Policy__c.Notify" },
        { type: "Flow", name: "New_Flow" },
        { type: "CustomObject", name: "Account" },
      ],
      debt: [{ component: "Policy__c.Notify", issue: "Workflow Rule" }],
    });
    expect(lines(checkCurrentState(s, env(index)))).toEqual([
      "warning Old_Process: Old_Process is a Process Builder process, which reached end of support: list it under debt, to migrate to Flow.",
      "info Account: CustomObject Account is not in the index, as standard components often are not: check it exists in the org.",
    ]);
    expect(lines(checkCurrentState(s, env([], { lookup: undefined })))[0]).toContain("Nothing is indexed");
  });

  it("check the solution's ids, diagram and existing components, but not products", () => {
    const s = solutionSection.parse({
      overview: "Overview.",
      orgStrategy: "Existing org.",
      components: [
        { id: "C1", name: "Sales Cloud", type: "Sales Cloud", status: "existing", purpose: "CRM", requirementIds: ["R1"] },
        { id: "C1", name: "Renewal_Flow", type: "Flow", status: "changed", purpose: "Renewals" },
      ],
      diagram: { nodes: [{ id: "sf", label: "Salesforce" }], edges: [{ from: "sf", to: "erp" }] },
    });
    expect(lines(checkSolution(s, env()))).toEqual([
      "error C1: Two components have the id C1: give each its own.",
      "error C1: Flow Renewal_Flow is not in the metadata index: check its API name with metadata_search, or mark it new.",
      'error diagram: An edge goes from or to "erp", which is not a node of the diagram.',
    ]);
  });

  it("ask for the order of automations on the same object and event, and an object that exists", () => {
    const flow = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Flow_${id}`, type: "record-triggered flow", status: "new", object: "Policy__c", event: "after-save", what: "Does it.", why: "Flow.", ...extra });
    const s = automationSection.parse({ automations: [flow("A1"), flow("A2", { order: 2 }), flow("A3", { object: "Claim__c", why: undefined }), { id: "A4", name: "Nightly", type: "apex trigger", status: "new", what: "x", why: "y" }] });
    const found = lines(checkAutomation(s, env([component("CustomObject", "Policy__c")])));
    expect(found).toContain("warning A1, A2: 2 automations run on Policy__c after-save: give each its order, or merge them.");
    expect(found).toContain("warning A3: CustomObject Claim__c is not in the metadata index: check its API name with metadata_search, or mark it new.");
    expect(found).toContain("warning A3: Say why Flow for Flow_A3.");
    expect(found).toContain("error A4: An apex trigger runs on an object and an event: give both.");
    // An object the data model adds is known.
    const modelled = env([], { design: { title: "", dataModel: { objects: [{ name: "Claim__c", status: "new", recordTypes: [], fields: [], relationships: [] }] } } });
    expect(lines(checkAutomation(automationSection.parse({ automations: [flow("A3", { object: "Claim__c" })] }), modelled)).filter((l) => l.startsWith("error"))).toEqual([]);
  });

  it("ask integrations for error handling and volume, and say nothing is indexed for the impact", () => {
    const s = integrationsSection.parse({ integrations: [{ id: "I1", system: "Billing", direction: "outbound", pattern: "fire and forget", mechanism: "Platform Events", requirementIds: ["R1"] }] });
    expect(lines(checkIntegrations(s, env()))).toEqual(["warning I1: Say how Billing errors are handled: retries, logging, who is told.", "warning I1: Give the volume for Billing, even as an estimate."]);
    const impact = checkImpact({ changes: [{ type: "Flow", name: "X", change: "delete", risk: "high" }] }, env([], { lookup: undefined }));
    expect(lines(impact)).toEqual(["info changes: Nothing is indexed, so the impact on the existing org cannot be checked: say so under delivery or in the risks."]);
  });

  it("warn when a section reads as another language than the context's", () => {
    const s = contextSection.parse({
      goals: ["Les clients renouvellent leur contrat à temps et le conseiller envoie la lettre de renouvellement avant la date de fin du contrat"],
      inScope: ["Les lettres de renouvellement"],
      personas: [{ name: "Conseiller", internal: true, does: "envoie les lettres" }],
    });
    const fr = lines(checkSolution(solutionSection.parse({ overview: s.goals[0], orgStrategy: "L'org existante.", components: [{ id: "C1", name: "Flux", type: "Flow", status: "new", purpose: "Envoie la lettre.", requirementIds: ["R1"] }] }), env()));
    expect(fr).toContain("warning solution: This reads as French, but the context's output language is English: write it in English.");
  });
});

describe("high-level design rendering", () => {
  it("fills every section, says which are missing, and escapes tables and diagram labels", () => {
    const md = renderHighLevelDesign(
      {
        title: "Renewals",
        solution: solutionSection.parse({
          overview: "A flow | and a page.",
          orgStrategy: "Existing org.",
          components: [{ id: "C1", name: "Renewal page", type: "LWC", status: "new", purpose: "Shows\nrenewals", requirementIds: ["R1"] }],
          diagram: { nodes: [{ id: "sf", label: 'The "core" [org]' }, { id: "erp", label: "ERP", kind: "external" }], edges: [{ from: "sf", to: "erp", label: "sends" }] },
        }),
      },
      [requirement("R1", "functional"), requirement("R2", "compliance")],
      [{ requirementId: "R2", reason: "Waiting on legal." }],
    );
    for (let n = 1; n <= 16; n++) expect(md).toMatch(new RegExp(`^## ${n}\\. `, "m"));
    expect(md).toContain("## 1. Context and scope\n\n_Not written: this step failed its checks or was left out._");
    expect(md).toContain("| C1 | Renewal page | LWC | new | Shows renewals | R1 |");
    expect(md).toContain('  n1["The #quot;core#quot; [org]"]');
    expect(md).toContain('  n2[["ERP"]]');
    expect(md).toContain('  n1 -->|"sends"| n2');
    expect(md).toContain("## 7. User experience\n\nNothing stated.");
    expect(md).toContain("| R1 | must | Statement R1 | doc-000000000a | Solution: C1 Renewal page |");
    expect(md).toContain("| R2 | must | Statement R2 | doc-000000000a | Not addressed: Waiting on legal. |");
  });
});

describe("design checks review fixes", () => {
  it("read metadata types and field types as people write them, and leave other types unchecked", () => {
    const index = [component("CustomObject", "Policy__c"), component("CustomField", "Policy__c.Status__c")];
    const state = currentStateSection.parse({
      summary: "x",
      components: [{ type: "Custom Object", name: "Account" }, { type: "customobject", name: "Policy__c" }, { type: "Integration", name: "SAP ERP" }],
    });
    expect(lines(checkCurrentState(state, env(index)))).toEqual([
      "info Account: CustomObject Account is not in the index, as standard components often are not: check it exists in the org.",
      "info components: Not checked against the index, which holds no such type: Integration.",
    ]);
    const model = dataModelSection.parse({
      objects: [
        {
          name: "Policy__c",
          status: "changed",
          fields: [
            { name: "Policy__c.Status__c", type: "Text Area", status: "existing" },
            { name: "Account__c", type: "Lookup Relationship", status: "new" },
            { name: "Amount__c", type: "Number(18,0)", status: "new" },
            { name: "Size__c", type: "Huge", status: "new" },
          ],
        },
      ],
    });
    expect(lines(checkDataModel(model, env(index))).filter((l) => l.startsWith("error")).map((l) => l.split(":")[0])).toEqual(["error Policy__c.Size__c"]);
    expect(lines(checkImpact({ changes: [] }, env(index, { design: { title: "", dataModel: model } })))[0]).toBe(
      "warning changes: The design changes Policy__c, Policy__c.Account__c, Policy__c.Amount__c, Policy__c.Size__c, not listed here.",
    );
  });

  it("refuse unknown keys in nested items instead of dropping them", () => {
    const r = contextSection.safeParse({ goals: ["g"], inScope: ["s"], personas: [{ name: "Agent", internal: true, does: "x", license: "Sales Cloud" }] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toContain("license");
  });

  it("only warn about an automation's object when the data model step failed, and know objects the solution adds", () => {
    const flow = { id: "A1", name: "F", type: "record-triggered flow", status: "new", object: "Letter__c", event: "after-save", what: "x", why: "y" };
    const s = automationSection.parse({ automations: [flow] });
    expect(lines(checkAutomation(s, env()))).toEqual(["warning A1: CustomObject Letter__c is not in the metadata index: check its API name with metadata_search, or mark it new."]);
    const withModel = env([], { design: { title: "", dataModel: { objects: [] } } });
    expect(lines(checkAutomation(s, withModel))[0]).toMatch(/^error A1/);
    const solution = solutionSection.parse({ overview: "o", orgStrategy: "s", components: [{ id: "C1", name: "Letter__c", type: "Custom Object", status: "new", purpose: "p" }] });
    expect(checkAutomation(s, env([], { design: { title: "", dataModel: { objects: [] }, solution } }))).toEqual([]);
  });

  it("ask a measure of Must and Should compliance requirements, warn for a Could, and leave a Won't", () => {
    const reqs = [requirement("R1", "compliance", "must"), requirement("R2", "compliance", "could"), requirement("R3", "compliance", "wont")];
    expect(lines(checkSecurity({ sharing: [], measures: [], nonFunctional: [] }, env([], { requirements: reqs })))).toEqual([
      "error R1: Compliance requirement R1 has no security measure: add the measure that meets it, citing R1.",
      "warning R2: Compliance requirement R2 has no security measure: add the measure that meets it, citing R2.",
    ]);
  });

  it("key what metadata_impact looked at on the type and real name, never in clear", () => {
    expect(impactKey("CustomObject", "Policy__c")).toBe(impactKey("Custom Object", " policy__c "));
    expect(impactKey("CustomObject", "Policy__c")).not.toContain("olicy");
    expect(impactKey("CustomField", "Policy__c")).not.toBe(impactKey("CustomObject", "Policy__c"));
  });

  it("keep pseudonyms in diagrams, and leave out an ER diagram whose names hold one", () => {
    const md = renderHighLevelDesign(
      {
        title: "T",
        solution: solutionSection.parse({
          overview: "o",
          orgStrategy: "s",
          components: [{ id: "C1", name: "n", type: "t", status: "new", purpose: "p" }],
          diagram: { nodes: [{ id: "end", label: "[ORG_1] portal" }, { id: "b", label: "B" }], edges: [{ from: "end", to: "b", label: "read | write" }] },
        }),
        dataModel: dataModelSection.parse({ objects: [{ name: "[ORG_1]__c", status: "new", relationships: [{ field: "Account__c", to: "Account", kind: "lookup" }] }] }),
      },
      [],
    );
    expect(md).toContain('  n1["[ORG_1] portal"]');
    expect(md).toContain('  n1 -->|"read #124; write"| n2');
    expect(md).not.toContain("erDiagram");
  });
});

