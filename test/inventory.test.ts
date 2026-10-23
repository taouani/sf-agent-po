import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildInventory, inventoryToMarkdown } from "../src/metadata/inventory.js";

const project = path.join(import.meta.dirname, "fixtures", "sfdx-project");

describe("buildInventory", () => {
  it("summarises an SFDX project", async () => {
    const inv = await buildInventory(project);
    expect(inv.packageDirectories).toEqual(["force-app"]);

    expect(inv.objects).toHaveLength(1);
    const policy = inv.objects[0];
    expect(policy).toMatchObject({ name: "Policy__c", label: "Policy", custom: true });
    expect(policy.fields).toEqual([
      { name: "Account__c", label: "Policyholder", type: "Lookup", referenceTo: "Account", required: true },
      { name: "Premium__c", label: "Annual Premium", type: "Currency", referenceTo: undefined, required: undefined },
    ]);

    expect(inv.flows).toEqual([
      {
        name: "Policy_Renewal",
        label: "Policy Renewal",
        processType: "AutoLaunchedFlow",
        status: "Active",
        triggerObject: "Policy__c",
        triggerType: "Update",
      },
    ]);
    expect(inv.apexClasses.map((c) => [c.name, c.isTest])).toEqual([
      ["PolicyService", false],
      ["PolicyServiceTest", true],
    ]);
    expect(inv.triggers).toEqual([{ name: "PolicyTrigger", object: "Policy__c", events: ["before insert", "after update"] }]);
    expect(inv.lwc).toEqual(["policyCard"]);
    expect(inv.permissionSets).toEqual(["Policy_Admin"]);
  });

  it("renders Markdown for the requirement context", async () => {
    const md = inventoryToMarkdown(await buildInventory(project));
    expect(md).toContain("### Policy__c (Policy)");
    expect(md).toContain("- Account__c: Lookup -> Account, required");
    expect(md).toContain("- Policy_Renewal: AutoLaunchedFlow on Policy__c (Update), Active");
  });
});
