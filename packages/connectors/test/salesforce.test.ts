import { describe, expect, it } from "vitest";
import { SalesforceOrg, orgToMarkdown } from "../src/salesforce.js";

describe("SalesforceOrg", () => {
  const calls: string[][] = [];
  const sf = async (args: string[]) => {
    calls.push(args);
    if (args[1] === "display") return { alias: "dev", username: "sa@example.com", instanceUrl: "https://dev.my.salesforce.com", apiVersion: "64.0", id: "00D", accessToken: "SECRET" };
    if (args[1] === "list") return ["Product__c", "Boutique__c"];
    return {
      name: "Boutique__c",
      label: "Boutique",
      custom: true,
      fields: [
        { name: "Name", label: "Name", type: "string", custom: false, nillable: false },
        { name: "City__c", label: "City", type: "string", custom: true, nillable: true },
        { name: "Manager__c", label: "Manager", type: "reference", referenceTo: ["User"], custom: true, nillable: false },
      ],
      recordTypeInfos: [{ name: "Master", master: true }, { name: "Flagship", master: false }],
      childRelationships: [{}, {}],
    };
  };
  const org = new SalesforceOrg("dev", sf);

  it("reads org info without the access token", async () => {
    const info = await org.info();
    expect(info).toEqual({ alias: "dev", username: "sa@example.com", instanceUrl: "https://dev.my.salesforce.com", apiVersion: "64.0", orgId: "00D" });
    expect(JSON.stringify(info)).not.toContain("SECRET");
    expect(calls[0]).toEqual(["org", "display", "--target-org", "dev"]);
  });

  it("lists custom objects sorted and describes one", async () => {
    expect(await org.listCustomObjects()).toEqual(["Boutique__c", "Product__c"]);
    const d = await org.describe("Boutique__c");
    expect(d.recordTypes).toEqual(["Flagship"]);
    expect(d.childRelationships).toBe(2);
    expect(d.fields[0]).toEqual({ name: "Name", label: "Name", type: "string", referenceTo: [], custom: false, nillable: false });
  });

  it("summarises the org as Markdown with custom and lookup fields only", async () => {
    const md = orgToMarkdown(await org.info(), await org.listCustomObjects(), [await org.describe("Boutique__c")]);
    expect(md).toContain("# Salesforce org dev");
    expect(md).toContain("Record types: Flagship");
    expect(md).toContain('- City__c: string "City"');
    expect(md).toContain('- Manager__c: reference -> User, required "Manager"');
    expect(md).not.toContain("- Name:");
  });
});
