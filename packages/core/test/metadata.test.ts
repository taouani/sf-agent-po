import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { apexCode, classify, classifyFile, Database, formulaCode, formulaFields, linkObjects, MAX_APEX_LENGTH, MAX_MARKUP_LENGTH, MetadataIndex, packagePath, parseMetadataXml, readApex, readFlow, readMarkup, reportColumnRef, scanProject, soqlFields, type ParsedComponent } from "../src/index.js";

const fixtures = join(import.meta.dirname, "fixtures", "metadata");
const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});
const fresh = () => {
  const db = new Database(":memory:");
  open.push(db);
  return new MetadataIndex(db);
};

describe("classify", () => {
  it("knows object files and their children in both formats", () => {
    expect(classify("force-app/main/default/objects/Account/Account.object-meta.xml")).toEqual({ kind: "object", object: "Account" });
    expect(classify("x/objects/Account/fields/Industry.field-meta.xml")).toEqual({ kind: "field", object: "Account", child: "Industry" });
    expect(classify("x/objects/Account/validationRules/V.validationRule-meta.xml")).toEqual({ kind: "validationRule", object: "Account", child: "V" });
    expect(classify("src/objects/Claim__c.object")).toEqual({ kind: "mdapiObject", object: "Claim__c" });
    expect(classify("x/objects/Account/listViews/All.listView-meta.xml")).toBeUndefined();
    expect(classify("x/classes/Foo.cls")).toEqual({ kind: "apexClass", object: "Foo" });
    expect(classify("x/classes/Foo.cls-meta.xml")).toBeUndefined();
    expect(classify("x/profiles/Admin.profile")).toEqual({ kind: "profile", object: "Admin" });
    expect(classify("x/layouts/Account-Account Layout.layout-meta.xml")).toEqual({ kind: "layout", object: "Account-Account Layout" });
  });
});

describe("scanProject", () => {
  it("reads objects, fields, record types and rules in source format", async () => {
    const { components, edges, skipped } = await scanProject(join(fixtures, "source"));
    const byName = new Map(components.map((c) => [`${c.type}:${c.name}`, c]));

    const policy = byName.get("CustomObject:Policy__c")!;
    expect(policy).toMatchObject({ label: "Policy", file: "force-app/main/default/objects/Policy__c/Policy__c.object-meta.xml" });
    expect(policy.attrs).toMatchObject({ custom: true, sharingModel: "ReadWrite", nameField: { label: "Policy Number", type: "AutoNumber" } });
    // Free text, with entities decoded, goes to text, never to attrs.
    expect(policy.text).toBe("Insurance policy sold by Jeanne Dupont's team");

    expect(byName.get("CustomField:Policy__c.Holder__c")).toMatchObject({ parent: "Policy__c", attrs: { type: "Lookup", referenceTo: ["Account"] } });
    const status = byName.get("CustomField:Policy__c.Status__c")!;
    // Picklist values can name clients: they are free text, and attrs only count them.
    expect(status.attrs).toMatchObject({ type: "Picklist", required: true, restricted: true, picklistValues: 2 });
    expect(JSON.stringify(status.attrs)).not.toContain("Lapsed");
    expect(status.text).toBe("Active\nLapsed");
    expect(byName.get("RecordType:Policy__c.Motor")).toMatchObject({ label: "Motor", attrs: { active: true } });
    expect(byName.get("ValidationRule:Policy__c.Premium_Required")!.text).toBe("An active policy needs a premium");

    // Account has only a field folder: it is in the project, without an object file.
    expect(byName.get("CustomObject:Account")).toMatchObject({ file: "force-app/main/default/objects/Account", attrs: { custom: false } });
    expect(byName.get("CustomObject:Account")!.missing).toBeUndefined();
    // Referenced but outside the project: placeholders.
    expect(byName.get("CustomObject:User")?.missing).toBe(true);
    expect(byName.get("CustomField:Account.Industry")).toMatchObject({ missing: true, parent: "Account" });

    expect(skipped).toEqual([{ file: "force-app/main/default/objects/Account/fields/Broken__c.field-meta.xml", reason: "a document type declaration is not read" }]);

    const has = (from: string, kind: string, to: string) => edges.some((e) => `${e.from.type}:${e.from.name}` === from && e.kind === kind && `${e.to.type}:${e.to.name}` === to);
    expect(has("CustomField:Policy__c.Holder__c", "references", "CustomObject:Account")).toBe(true);
    expect(has("CustomField:Policy__c.Holder__c", "part_of", "CustomObject:Policy__c")).toBe(true);
    expect(has("ValidationRule:Policy__c.Premium_Required", "reads", "CustomField:Policy__c.Status__c")).toBe(true);
    expect(has("ValidationRule:Policy__c.Premium_Required", "reads", "CustomField:Policy__c.Premium__c")).toBe(true);
    // Through the lookup to Account, then the standard Owner relationship to User.
    expect(has("CustomField:Policy__c.Holder_Industry__c", "reads", "CustomField:Account.Industry")).toBe(true);
    expect(has("CustomField:Policy__c.Holder_Industry__c", "reads", "CustomField:Account.OwnerId")).toBe(true);
    expect(has("CustomField:Policy__c.Holder_Industry__c", "reads", "CustomField:User.Email")).toBe(true);
    // Function names, literals and $User are not fields.
    expect(edges.some((e) => /ISPICKVAL|ISBLANK|Active|Alias|admin/.test(e.to.name))).toBe(false);
  });

  it("reads children inside .object files in metadata format", async () => {
    const { components, edges, skipped } = await scanProject(join(fixtures, "mdapi"));
    expect(skipped).toEqual([]);
    const names = components.filter((c) => !c.missing).map((c) => `${c.type}:${c.name}`).sort();
    expect(names).toEqual([
      "ApexClass:ClaimService",
      "CustomField:Claim__c.Amount__c",
      "CustomField:Claim__c.Policy__c",
      "CustomObject:Claim__c",
      "Flow:Claim_Intake",
      "RecordType:Claim__c.Theft",
      "ValidationRule:Claim__c.Amount_Positive",
    ]);
    expect(components.find((c) => c.name === "Claim__c.Amount__c")!.file).toBe("src/objects/Claim__c.object");
    expect(edges).toContainEqual({ from: { type: "ValidationRule", name: "Claim__c.Amount_Positive" }, to: { type: "CustomField", name: "Claim__c.Amount__c" }, kind: "reads" });
    expect(components.find((c) => c.name === "Policy__c")).toMatchObject({ type: "CustomObject", missing: true });
  });
});

describe("classifyFile (the metadata type registry)", () => {
  /** What a file holds, without the folder it was found in. */
  const what = (rel: string) => {
    const m = classifyFile(rel);
    if (!m) return m;
    const { home: _, ...rest } = m;
    return rest;
  };
  it("knows types in both formats, bundles, folders and children", () => {
    expect(classifyFile("force-app/main/default/classes/Foo.cls-meta.xml")).toEqual({ type: "ApexClass", name: "Foo", home: "force-app/main/default/classes" });
    expect(what("src/classes/Foo.cls")).toEqual({ type: "ApexClass", name: "Foo" });
    expect(what("x/lwc/policyCard/policyCard.html")).toEqual({ type: "LightningComponentBundle", name: "policyCard" });
    expect(classifyFile("x/lwc/policyCard/policyCard.html")?.home).toBe("x/lwc");
    // Tests and mocks sit in a bundle's folder but are not part of it.
    expect(what("x/lwc/policyCard/__tests__/a.test.js")).toBeUndefined();
    expect(what("x/lwc/jsconfig.json")).toBeUndefined();
    expect(what("x/lwc/__mocks__/m.js")).toBeUndefined();
    expect(what("x/reports/Sales/Q1/Pipeline.report-meta.xml")).toEqual({ type: "Report", name: "Sales/Q1/Pipeline" });
    expect(what("x/reports/Sales.reportFolder-meta.xml")).toEqual({ type: "ReportFolder", name: "Sales" });
    expect(what("x/reports/Sales/Q1.reportFolder-meta.xml")).toEqual({ type: "ReportFolder", name: "Sales/Q1" });
    expect(what("x/objects/Account/listViews/All.listView-meta.xml")).toEqual({ type: "ListView", name: "Account.All", parent: "Account", parentType: "CustomObject" });
    expect(what("x/layouts/Account-Account Layout.layout-meta.xml")).toEqual({ type: "Layout", name: "Account-Account Layout" });
    expect(what("x/settings/Case.settings-meta.xml")).toEqual({ type: "Settings", name: "Case" });
    expect(what("x/bots/Helper/Helper.bot-meta.xml")).toEqual({ type: "Bot", name: "Helper" });
    expect(what("README.md")).toBeUndefined();
    // Source format lets a class sit in a subfolder, or any folder.
    expect(classifyFile("x/classes/nested/Foo.cls-meta.xml")).toEqual({ type: "ApexClass", name: "Foo", home: "x/classes/nested" });
    expect(what("x/services/Foo.cls")).toEqual({ type: "ApexClass", name: "Foo" });
    expect(what("x/notes/Foo.txt")).toBeUndefined();
  });

  it("knows sites, documents, folders in metadata format, territories and top-level children", () => {
    expect(what("x/experiences/MySite1.site-meta.xml")).toEqual({ type: "ExperienceBundle", name: "MySite1" });
    expect(what("x/experiences/MySite1/config/mySite1.json")).toEqual({ type: "ExperienceBundle", name: "MySite1" });
    expect(what("x/digitalExperiences/site/MySite1/MySite1.digitalExperience-meta.xml")).toEqual({ type: "DigitalExperienceBundle", name: "site/MySite1" });
    expect(what("x/digitalExperiences/site/MySite1/sfdc_cms__view/home/content.json")).toEqual({ type: "DigitalExperienceBundle", name: "site/MySite1" });
    // A report or email folder's own file in metadata format has no suffix.
    expect(what("src/reports/Sales-meta.xml")).toEqual({ type: "ReportFolder", name: "Sales" });
    expect(what("src/reports/Sales/Q1-meta.xml")).toEqual({ type: "ReportFolder", name: "Sales/Q1" });
    expect(what("src/email/Letters-meta.xml")).toMatchObject({ name: "Letters" });
    // Documents, in either format, and their folders.
    for (const f of ["x/documents/Brand/logo.png", "x/documents/Brand/logo.document-meta.xml", "src/documents/Brand/logo.png-meta.xml"]) {
      expect(what(f)).toEqual({ type: "Document", name: "Brand/logo" });
    }
    expect(what("x/documents/Brand.documentFolder-meta.xml")).toEqual({ type: "DocumentFolder", name: "Brand" });
    expect(what("src/documents/Brand-meta.xml")).toEqual({ type: "DocumentFolder", name: "Brand" });
    // Territories are named after their model, so two models can hold the same name.
    expect(what("x/territory2Models/M1/territories/T1.territory2-meta.xml")).toEqual({ type: "Territory2", name: "M1.T1" });
    expect(what("x/territory2Models/M1/rules/R1.territory2Rule-meta.xml")).toEqual({ type: "Territory2Rule", name: "M1.R1" });
    expect(what("x/territory2Models/M1/M1.territory2Model-meta.xml")).toEqual({ type: "Territory2Model", name: "M1" });
    // Children written beside their parent's file.
    expect(what("x/bots/Helper/v1.botVersion-meta.xml")).toEqual({ type: "BotVersion", name: "Helper.v1", parent: "Helper", parentType: "Bot" });
    expect(what("x/objectTranslations/Account-en_US/Industry__c.fieldTranslation-meta.xml")).toMatchObject({
      type: "CustomFieldTranslation",
      name: "Account-en_US.Industry__c",
      parentType: "CustomObjectTranslation",
    });
  });

  it("reads an expanded static resource as one resource, whatever it holds", () => {
    expect(what("x/staticresources/lib/lwc/x/y.js")).toEqual({ type: "StaticResource", name: "lib" });
    expect(what("x/staticresources/lib/classes/Foo.cls")).toEqual({ type: "StaticResource", name: "lib" });
    expect(what("x/staticresources/lib/pages/home.page")).toEqual({ type: "StaticResource", name: "lib" });
    expect(what("x/staticresources/lib.resource-meta.xml")).toEqual({ type: "StaticResource", name: "lib" });
    expect(what("x/staticresources/logo.png")).toEqual({ type: "StaticResource", name: "logo" });
  });
});

describe("flows", () => {
  it("reads what a flow triggers on, reads, writes and calls", async () => {
    const { components, edges } = await scanProject(join(fixtures, "source"));
    const flow = components.find((c) => c.type === "Flow")!;
    expect(flow).toMatchObject({
      name: "Policy_Renewal",
      label: "Policy Renewal",
      attrs: { processType: "AutoLaunchedFlow", status: "Active", triggerObject: "Policy__c", triggerType: "RecordAfterSave", recordTriggerType: "Update" },
      text: "Renews policies; ask Jeanne Dupont before changing",
    });
    expect(flow.attrs.elements).toEqual({ decisions: 1, recordLookups: 1, recordCreates: 1, recordUpdates: 1, actionCalls: 1, subflows: 1 });
    // The filter value names a client in other projects: entry conditions are not kept.
    expect(JSON.stringify(flow.attrs)).not.toContain("Lapsed");
    const out = edges.filter((e) => e.from.name === "Policy_Renewal").map((e) => `${e.kind} ${e.to.type}:${e.to.name}`).sort();
    expect(out).toEqual(
      [
        "calls ApexClass:RenewalService",
        "calls Flow:Notify_Holder",
        "reads CustomField:Account.Id",
        "reads CustomField:Account.Industry",
        "reads CustomField:Account.Segment__c",
        "reads CustomField:Policy__c.Holder__c",
        "reads CustomField:Policy__c.Id",
        // The entry condition: the field that decides whether the flow runs.
        "reads CustomField:Policy__c.Status__c",
        "reads CustomObject:Account",
        "triggers_on CustomObject:Policy__c",
        "writes CustomField:Claim__c.Policy__c",
        "writes CustomField:Policy__c.Status__c",
        "writes CustomObject:Claim__c",
        "writes CustomObject:Policy__c",
      ].sort(),
    );
  });

  it("reads reports, dashboards and report types: what they use, never filter values or running users", async () => {
    const { components, edges } = await scanProject(join(fixtures, "source"));
    const out = (name: string) => edges.filter((e) => e.from.name === name).map((e) => `${e.kind} ${e.to.type}:${e.to.name}`).sort();
    expect(out("Sales/Pipeline")).toEqual([
      "reads CustomField:Account.Segment__c",
      "reads CustomField:Policy__c.CreatedDate",
      "reads CustomField:Policy__c.Name",
      "reads CustomField:Policy__c.Premium__c",
      "reads CustomField:Policy__c.Status__c",
      "reads ReportType:Policies_with_Claims",
    ]);
    expect(out("Sales/Weekly")).toEqual(["reads Report:Sales/Pipeline"]);
    expect(out("Policies_with_Claims")).toEqual(["reads CustomField:Policy__c.Premium__c", "reads CustomObject:Policy__c"]);
    const report = components.find((c) => c.type === "Report")!;
    expect(report).toMatchObject({ label: "Pipeline", attrs: { reportType: "Policies_with_Claims__c", format: "Summary", filterFields: ["Policy__c$Status__c"] } });
    expect(components.find((c) => c.type === "ReportType")).toMatchObject({ label: "Policies with Claims", attrs: { baseObject: "Policy__c", joins: ["Claims__r (with or without)"], fields: 2 } });
    const kept = JSON.stringify(components.filter((c) => ["Report", "Dashboard", "ReportType"].includes(c.type)));
    for (const secret of ["Acme Holdings", "Bob Smith", "jane.doe@example.com"]) expect(kept).not.toContain(secret);
  });

  it("names the field a report column reads", () => {
    expect(reportColumnRef("Policy__c$Premium__c")).toEqual({ kind: "reads", object: "Policy__c", path: "Premium__c" });
    expect(reportColumnRef("Policy__c.Claims__r$Amount__c")).toEqual({ kind: "reads", field: "Amount__c" });
    expect(reportColumnRef("Policy__c.Claims__r$Name")).toBeUndefined();
    expect(reportColumnRef("Account.Segment__c")).toEqual({ kind: "reads", object: "Account", path: "Segment__c" });
    expect(reportColumnRef("FK_$Account.Segment__c")).toEqual({ kind: "reads", object: "Account", path: "Segment__c" });
    for (const standard of ["ACCOUNT.NAME", "CUST_NAME", "AMOUNT", "FK_ACC_NAME", "a$b$"]) expect(reportColumnRef(standard), standard).toBeUndefined();
  });

  it("indexes every other type by name and file", async () => {
    const { components } = await scanProject(join(fixtures, "source"));
    const others = components.filter((c) => !["CustomObject", "CustomField", "RecordType", "ValidationRule", "Flow"].includes(c.type) && !c.missing);
    expect(others.map((c) => `${c.type}:${c.name}`).sort()).toEqual([
      "ApexClass:RenewalNotifier",
      "ApexClass:RenewalService",
      "ApexTrigger:PolicyTrigger",
      "Dashboard:Sales/Weekly",
      "DashboardFolder:Sales",
      "Layout:Policy__c-Policy Layout",
      "LightningComponentBundle:policyCard",
      "ListView:Policy__c.All",
      "PermissionSet:Policy_Manager",
      "PermissionSetGroup:Renewals",
      "Report:Sales/Pipeline",
      "ReportFolder:Sales",
      "ReportType:Policies_with_Claims",
    ]);
    expect(others.find((c) => c.type === "ListView")).toMatchObject({ parent: "Policy__c", parentType: "CustomObject" });
    // The bundle's own file, not its test fixture.
    expect(others.find((c) => c.type === "LightningComponentBundle")?.file).toBe("force-app/main/default/lwc/policyCard/policyCard.js");
    // A subflow outside the project is a placeholder.
    expect(components.find((c) => c.name === "Notify_Holder")).toMatchObject({ type: "Flow", missing: true });

    const mdapi = await scanProject(join(fixtures, "mdapi"));
    expect(mdapi.components.find((c) => c.type === "Flow")).toMatchObject({ name: "Claim_Intake", attrs: { status: "Draft", elements: { recordCreates: 1, screens: 1 } } });
    expect(mdapi.edges).toContainEqual({ from: { type: "Flow", name: "Claim_Intake" }, to: { type: "CustomField", name: "Claim__c.Amount__c" }, kind: "writes" });
    expect(mdapi.components.filter((c) => c.type === "ApexClass").map((c) => c.name)).toEqual(["ClaimService"]);
  });
});

describe("flow references", () => {
  const edgesOf = (xml: string, others: ParsedComponent[] = []) => {
    const flow = readFlow("F", (parseMetadataXml(`<Flow>${xml}</Flow>`) as { Flow: Record<string, unknown> }).Flow, "flows/F.flow-meta.xml");
    return linkObjects([flow, ...others])
      .edges.filter((e) => e.from.name === "F")
      .map((e) => `${e.kind} ${e.to.type}:${e.to.name}`)
      .sort();
  };

  it("follows record variables, Get Records results and loops to the records they write", () => {
    const edges = edgesOf(`
      <variables><name>acc</name><dataType>SObject</dataType><objectType>Account</objectType><isCollection>false</isCollection></variables>
      <recordLookups><name>Get_Accs</name><object>Account</object><storeOutputAutomatically>true</storeOutputAutomatically></recordLookups>
      <loops><name>Each_Acc</name><collectionReference>Get_Accs</collectionReference></loops>
      <assignments><name>Set</name><assignmentItems><assignToReference>Each_Acc.Rating</assignToReference><value><elementReference>acc.Industry</elementReference></value></assignmentItems></assignments>
      <recordUpdates><name>Save</name><inputReference>Get_Accs</inputReference></recordUpdates>
      <recordCreates><name>Make</name><inputReference>acc</inputReference></recordCreates>`);
    expect(edges).toEqual(["reads CustomField:Account.Industry", "reads CustomObject:Account", "writes CustomField:Account.Rating", "writes CustomObject:Account"]);
  });

  it("writes the triggering record's fields in a before-save assignment, and a related record's through it", () => {
    const edges = edgesOf(`
      <start><object>Case</object><triggerType>RecordBeforeSave</triggerType>
        <filters><field>Priority</field><operator>IsChanged</operator></filters>
        <scheduledPaths><recordField>ClosedDate</recordField></scheduledPaths></start>
      <assignments><name>A</name><assignmentItems><assignToReference>$Record.Status</assignToReference></assignmentItems></assignments>
      <recordUpdates><name>U</name><inputReference>$Record.Account</inputReference><inputAssignments><field>Rating</field></inputAssignments></recordUpdates>`);
    expect(edges).toEqual([
      "reads CustomField:Case.AccountId",
      "reads CustomField:Case.ClosedDate",
      "reads CustomField:Case.Priority",
      "triggers_on CustomObject:Case",
      "writes CustomField:Account.Rating",
      "writes CustomField:Case.Status",
      "writes CustomObject:Account",
      "writes CustomObject:Case",
    ]);
  });

  it("reads processes, and the actions, plug-ins, stages and screen components a flow calls", () => {
    const process = edgesOf(`
      <processType>Workflow</processType>
      <processMetadataValues><name>ObjectType</name><value><stringValue>Account</stringValue></value></processMetadataValues>
      <variables><name>myVariable_current</name><dataType>SObject</dataType><objectType>Account</objectType></variables>
      <decisions><name>D</name><rules><conditions><leftValueReference>myVariable_current.Industry</leftValueReference></conditions></rules></decisions>`);
    expect(process).toEqual(["reads CustomField:Account.Industry", "triggers_on CustomObject:Account"]);

    const lwc: ParsedComponent = { type: "AuraDefinitionBundle", name: "legacyPicker", attrs: {}, text: "" };
    const calls = edgesOf(
      `
      <actionCalls><name>a</name><actionName>Case.Notify_Owner</actionName><actionType>emailAlert</actionType></actionCalls>
      <actionCalls><name>b</name><actionName>Case.LogACall</actionName><actionType>quickAction</actionType></actionCalls>
      <actionCalls><name>c</name><actionName>Payments.charge</actionName><actionType>externalService</actionType></actionCalls>
      <actionCalls><name>d</name><actionName>chatterPost</actionName><actionType>chatterPost</actionType></actionCalls>
      <apexPluginCalls><name>e</name><apexClass>LegacyPlugin</apexClass></apexPluginCalls>
      <orchestratedStages><name>s</name><stageSteps><name>t</name><actionName>Review_Step</actionName><actionType>stepInteractive</actionType></stageSteps></orchestratedStages>
      <variables><name>req</name><dataType>Apex</dataType><apexClass>QuoteRequest</apexClass></variables>
      <screens><name>S</name><fields><name>sec</name><fields><name>p</name><extensionName>c:policyCard</extensionName></fields><fields><name>q</name><extensionName>c:legacyPicker</extensionName></fields><fields><name>r</name><extensionName>flowruntime:address</extensionName></fields></fields></screens>`,
      [lwc],
    );
    expect(calls).toEqual([
      "calls ApexClass:LegacyPlugin",
      "calls AuraDefinitionBundle:legacyPicker",
      "calls ExternalServiceRegistration:Payments",
      "calls Flow:Review_Step",
      "calls LightningComponentBundle:policyCard",
      "calls QuickAction:Case.LogACall",
      "calls WorkflowAlert:Case.Notify_Owner",
      "references ApexClass:QuoteRequest",
    ]);
  });

  it("does not read field names out of descriptions and labels", () => {
    const edges = edgesOf(`
      <start><object>Case</object><triggerType>RecordAfterSave</triggerType></start>
      <description>Do not touch $Record.Secret_Field__c</description>
      <decisions><name>D</name><label>Check $Record.Other__c</label><rules><conditions><leftValueReference>$Record.Status</leftValueReference></conditions></rules></decisions>
      <formulas><name>f</name><expression>Account.Name &amp; {!$Record.Subject}</expression></formulas>`);
    expect(edges).toEqual(["reads CustomField:Case.Status", "reads CustomField:Case.Subject", "triggers_on CustomObject:Case"]);
  });
});

describe("Apex, permissions and layouts", () => {
  const out = (edges: { from: { name: string }; to: { type: string; name: string }; kind: string }[], name: string) =>
    edges
      .filter((e) => e.from.name === name)
      .map((e) => `${e.kind} ${e.to.type}:${e.to.name}`)
      .sort();

  it("reads what Apex queries, writes and calls, and what a trigger runs on", async () => {
    const { components, edges } = await scanProject(join(fixtures, "source"));
    const service = components.find((c) => c.name === "RenewalService")!;
    expect(service).toMatchObject({ type: "ApexClass", attrs: { kind: "class", sharing: "with", queries: 2, dml: 4 }, text: "" });
    // Comments are not read: they can name people, and what they mention is not used.
    expect(JSON.stringify(service)).not.toContain("Dupont");
    expect(out(edges, "RenewalService")).toEqual(
      [
        "calls ApexClass:RenewalNotifier",
        "calls Flow:Policy_Renewal",
        "reads CustomField:Account.Segment__c",
        "reads CustomField:Policy__c.Holder__c",
        "reads CustomField:Policy__c.Id",
        "reads CustomField:Policy__c.Name",
        "reads CustomField:Policy__c.Premium__c",
        "reads CustomField:Policy__c.Status__c",
        "reads CustomField:Task.ActivityDate",
        "reads CustomField:Task.Id",
        "reads CustomField:Task.WhatId",
        "reads CustomLabel:Renewal_Segment",
        "reads CustomObject:Policy__c",
        "reads CustomObject:Task",
        "writes CustomField:Account.Name",
        "writes CustomField:Account.Segment__c",
        "writes CustomField:Claim__c.Amount__c",
        "writes CustomField:Claim__c.Policy__c",
        "writes CustomField:Policy__c.Status__c",
        "writes CustomObject:Account",
        "writes CustomObject:Claim__c",
        "writes CustomObject:Policy__c",
        "writes CustomObject:Task",
        "reads CustomField:Account.Industry",
      ].sort(),
    );
    expect(components.find((c) => c.name === "PolicyTrigger")).toMatchObject({ type: "ApexTrigger", attrs: { object: "Policy__c", events: ["before insert", "after update"] } });
    expect(out(edges, "PolicyTrigger")).toEqual([
      "calls ApexClass:RenewalService",
      "reads CustomField:Policy__c.Premium__c",
      "triggers_on CustomObject:Policy__c",
      "writes CustomField:Policy__c.Premium__c",
      "writes CustomObject:Policy__c",
    ]);
  });

  it("reads what permission sets grant, what groups include and what layouts show", async () => {
    const { components, edges } = await scanProject(join(fixtures, "source"));
    const ps = components.find((c) => c.name === "Policy_Manager")!;
    expect(ps).toMatchObject({
      type: "PermissionSet",
      label: "Policy Manager",
      attrs: { activationRequired: false, objects: { Policy__c: "CRE" }, fields: { "Policy__c.Status__c": "edit", "Policy__c.Premium__c": "read" }, userPermissions: ["RunReports"] },
      text: "For the renewals team led by Jeanne Dupont",
    });
    expect(out(edges, "Policy_Manager")).toEqual([
      "grants ApexClass:RenewalService",
      "grants CustomField:Policy__c.Premium__c",
      "grants CustomField:Policy__c.Status__c",
      "grants CustomObject:Policy__c",
      "grants Flow:Policy_Renewal",
    ]);
    expect(out(edges, "Renewals")).toEqual(["includes PermissionSet:Policy_Manager"]);
    expect(components.find((c) => c.type === "Layout")).toMatchObject({ parent: "Policy__c", attrs: { object: "Policy__c", required: ["Name"], readonly: ["Premium__c"] } });
    expect(out(edges, "Policy__c-Policy Layout")).toEqual([
      "part_of CustomObject:Policy__c",
      "shows CustomField:Claim__c.Policy__c",
      "shows CustomField:Policy__c.Name",
      "shows CustomField:Policy__c.Premium__c",
      "shows CustomField:Policy__c.Status__c",
    ]);
  });

  it("scans Apex queries and code without being misled by strings, comments or keywords", () => {
    expect(soqlFields("SELECT Id, toLabel(Status), COUNT(Amount__c) total, (SELECT Id FROM Contacts) FROM Account WHERE Name LIKE :n AND CreatedDate = LAST_N_DAYS:7 ORDER BY Owner.Name DESC NULLS LAST")).toEqual({
      object: "Account",
      fields: ["Id", "Status", "Amount__c", "Name", "CreatedDate", "Owner.Name"],
      joins: [],
    });
    expect(apexCode("a = 'it\\'s // not'; // x\n/* y */b")).toBe("a = '            '; // x\n/* y */b".replace("// x", "    ").replace("/* y */", "       "));
    const c = readApex("ApexClass", "C", "public class C { void m(User u, Foo f) { return u; } void update(List<X> l) {} String s = 'insert acc;'; }", "classes/C.cls");
    // Only classes the project might have are named, and only linked if it has them.
    expect(c.refs!.every((r) => r.kind === "calls" && "known" in r && r.known)).toBe(true);
    expect(linkObjects([c]).edges).toEqual([]);
    const huge = readApex("ApexClass", "Big", "x".repeat(MAX_APEX_LENGTH + 1), "classes/Big.cls");
    expect(huge).toMatchObject({ attrs: { tooLarge: true } });
    expect(huge.refs).toBeUndefined();
  });
});

describe("Apex scanning, hard cases", () => {
  const edges = (src: string, others: ParsedComponent[] = []) =>
    linkObjects([readApex("ApexClass", "X", src, "classes/X.cls"), ...others])
      .edges.filter((e) => e.from.name === "X")
      .map((e) => `${e.kind} ${e.to.type}:${e.to.name}`)
      .sort();

  it("stays fast on long runs of whitespace, comments and unclosed constructs", () => {
    const started = Date.now();
    readApex("ApexClass", "T", "@IsTest\n" + "// old code that was commented out\n".repeat(6000) + "private class T {}", "x");
    readApex("ApexClass", "T", "@AuraEnabled\n/*" + " ".repeat(300_000) + "*/", "x");
    readApex("ApexClass", "T", "return [SELECT " + "Name, ".repeat(10_000) + "Id FROM Account];", "x");
    readApex("ApexClass", "T", "insert" + " ".repeat(100_000) + "as" + " ".repeat(100_000) + "x", "x");
    readApex("ApexClass", "T", "Database" + " ".repeat(100_000) + "." + " ".repeat(100_000) + "insert (", "x");
    readApex("ApexTrigger", "T", "trigger a on b (".repeat(20_000), "x");
    readApex("ApexClass", "T", "new Account(".repeat(20_000) + "[SELECT Id FROM X WHERE A = :".repeat(5_000) + "TYPEOF ".repeat(5_000), "x");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("reads each use of a variable as the type it was declared with nearest before it", () => {
    const e = edges("@IsTest class X { static void a(){ Contact c = new Contact(LastName='x'); insert c; } static void b(){ Case c = new Case(); c.Status='New'; c.Origin='Web'; insert c; } }");
    expect(e).toContain("writes CustomObject:Case");
    expect(e).toContain("writes CustomField:Case.Status");
    expect(e).not.toContain("writes CustomField:Contact.Status");
  });

  it("does not take bind expressions, TYPEOF, FIELDS() or locators for fields or writes", () => {
    expect(soqlFields("SELECT Id FROM Account WHERE Name = :String.escapeSingleQuotes(term) AND CreatedDate > :Date.newInstance(year, month, 1) AND Id = : byName.get(key).Id").fields).toEqual(["Id", "Name", "CreatedDate"]);
    expect(soqlFields("SELECT Id, TYPEOF What WHEN Account THEN Phone ELSE Name END FROM Event").fields).toEqual(["Id"]);
    expect(soqlFields("SELECT FIELDS(STANDARD) FROM Account USING SCOPE mine_and_my_groups").fields).toEqual([]);
    expect(soqlFields("SELECT Id FROM Account WHERE Id NOT IN (SELECT AccountId FROM Opportunity WHERE IsWon = true)")).toEqual({
      object: "Account",
      fields: ["Id"],
      joins: [{ object: "Opportunity", fields: ["AccountId", "IsWon"] }],
    });
    const batch = edges("class X { Database.QueryLocator start() { return Database.getQueryLocator([SELECT Id FROM Account]); } }");
    expect(batch).toEqual(["reads CustomField:Account.Id", "reads CustomObject:Account"]);
  });

  it("knows map initialisers, compound assignments, describes, nested calls and static field tokens", () => {
    expect(edges("class X { void m(Account acc) { Map<Id, Account> m = new Map<Id, Account>{ acc.Id => acc }; update m.values(); } }")).not.toContain("writes CustomField:Account.Id");
    expect(edges("class X { void m(Opportunity o) { o.Amount += 10; o.Probability++; } }")).toEqual([
      "writes CustomField:Opportunity.Amount",
      "writes CustomField:Opportunity.Probability",
      "writes CustomObject:Opportunity",
    ]);
    expect(edges("class X { String p = Schema.SObjectType.Account.keyPrefix; }")).toEqual(["reads CustomObject:Account"]);
    expect(edges("class X { void m() { insert new Account(Name = 'x', OwnerId = UserInfo.getUserId()); } }")).toEqual([
      "writes CustomField:Account.Name",
      "writes CustomField:Account.OwnerId",
      "writes CustomObject:Account",
    ]);
    expect(edges("class X { Account acc; void m(List<Account> accs) { this.acc.Name = 'x'; upsert accs Account.Fields.Ext_Id__c; switch on acc { when Account a { a.Rating = 'Hot'; } } } }")).toEqual([
      "reads CustomField:Account.Ext_Id__c",
      "writes CustomField:Account.Name",
      "writes CustomField:Account.Rating",
      "writes CustomObject:Account",
    ]);
    // A variable named label is not a custom label.
    expect(edges("class X { void m(Wrapper label) { label.value = 'x'; } }")).toEqual([]);
  });

  it("does not crash on folders named after object properties, nor read Apex inside a static resource", async () => {
    expect(classify("x/lwc/constructor/constructor.js")).toBeUndefined();
    expect(classify("x/objects/A/constructor/B.field-meta.xml")).toBeUndefined();
    expect(classify("x/staticresources/lib/classes/Foo.cls")).toBeUndefined();
    expect(classify("x/classes/services/Foo.cls")).toEqual({ kind: "apexClass", object: "Foo" });
  });
});

describe("formulaFields", () => {
  const fields = new Map<string, Map<string, ParsedComponent>>([
    ["case", new Map([["contract__c", { type: "CustomField", name: "Case.Contract__c", attrs: { referenceTo: ["Contract__c"] }, text: "" }]])],
    ["contract__c", new Map()],
  ]);
  const of = (o: string) => fields.get(o.toLowerCase());
  const objects: Record<string, string> = { case: "Case", contract__c: "Contract__c" };
  const named = (o: string) => objects[o.toLowerCase()];

  it("matches names without case and keeps the declared spelling", () => {
    expect(formulaFields("contract__R.owner.name", "Case", of, named).sort()).toEqual(["Case.Contract__c", "Contract__c.ownerId", "User.name"]);
  });

  it("knows where standard relationships lead, and stops where it cannot tell", () => {
    expect(formulaFields("Parent.Name", "Account", of).sort()).toEqual(["Account.Name", "Account.ParentId"]);
    expect(formulaFields("Who.Name & What.Name", "Task", of).sort()).toEqual(["Task.WhatId", "Task.WhoId"]);
    expect(formulaFields("Manager.Email & Foo.Bar", "User", of).sort()).toEqual(["User.Email", "User.FooId", "User.ManagerId"]);
    // Polymorphic syntax names the type; person account relationships end in __pr.
    expect(formulaFields("Owner:User.Email", "Case", of, named).sort()).toEqual(["Case.OwnerId", "User.Email"]);
    expect(formulaFields("Advisor__pr.Phone", "Account", of).sort()).toEqual(["Account.Advisor__pc"]);
  });

  it("leaves out numbers, and strips comments and strings in order", () => {
    expect(formulaFields("Amount__c * 1.5e3", "Case", of)).toEqual(["Case.Amount__c"]);
    expect(formulaFields('"a/*" & Amount__c & "*/" & Other__c', "Case", of).sort()).toEqual(["Case.Amount__c", "Case.Other__c"]);
    expect(formulaCode('A /* "x" */ & "/* y" & B')).toBe("A   &   & B");
  });

  it("stays fast on unclosed comments and strings, and on huge formulas", () => {
    const started = Date.now();
    formulaFields("/* ".repeat(40_000), "Case", of);
    formulaFields('"\\'.repeat(6_000), "Case", of);
    expect(formulaFields("A__c & ".repeat(5_000), "Case", of)).toEqual([]);
    expect(() => parseMetadataXml(`<a>${"<!--".repeat(200_000)}</a>`)).toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("follows custom and standard relationships", () => {
    expect(formulaFields("Contract__r.Owner.Name & Account.Name", "Case", of, named).sort()).toEqual(
      ["Account.Name", "Case.AccountId", "Case.Contract__c", "Contract__c.OwnerId", "User.Name"].sort(),
    );
  });

  it("leaves out functions, keywords, literals, comments and globals", () => {
    expect(formulaFields('IF( NOT(IsClosed), "Open: Status", TRUE ) /* Priority */ && $Profile.Name = \'x\'', "Case", of)).toEqual(["Case.IsClosed"]);
  });
});

describe("MetadataIndex", () => {
  it("stores a snapshot, finds components and walks the graph", async () => {
    const index = fresh();
    const snap = await index.build({ source: "repo:source", kind: "repo", revision: "abc123" }, () => scanProject(join(fixtures, "source")));
    expect(snap).toMatchObject({ status: "ready", revision: "abc123", stats: { counts: { CustomObject: 2, CustomField: 5, RecordType: 1, ValidationRule: 1 } } });
    expect(snap.stats.skipped).toHaveLength(1);
    expect(index.latest("repo:source")?.id).toBe(snap.id);

    // Part of an API name, a label with an accent folded, and a word of the free text.
    expect(index.search(snap.id, "Premium").map((c) => c.name)).toContain("Policy__c.Premium__c");
    expect(index.search(snap.id, "annuelle")[0]?.name).toBe("Policy__c.Premium__c");
    expect(index.search(snap.id, "reclame")).toEqual([]);
    expect(index.search(snap.id, "lapsed").map((c) => c.name)).toEqual(["Policy__c.Status__c"]);
    // An exact name comes first; types filter; short words match by substring.
    expect(index.search(snap.id, "policy__c")[0]?.name).toBe("Policy__c");
    expect(index.search(snap.id, "Policy", { types: ["RecordType"] }).map((c) => c.name)).toEqual(["Policy__c.Motor"]);
    expect(index.search(snap.id, "Id").map((c) => c.name)).toContain("Account.OwnerId");
    expect(index.search(snap.id, '"; DROP')).toEqual([]);

    expect(index.children(snap.id, "policy__c").map((c) => c.name)).toEqual([
      "Policy__c.Holder__c",
      "Policy__c.Holder_Industry__c",
      "Policy__c.Premium__c",
      "Policy__c.Status__c",
      "Policy__c-Policy Layout",
      "Policy__c.All",
      "Policy__c.Motor",
      "Policy__c.Premium_Required",
      // Standard fields only referenced come after what the project holds.
      "Policy__c.CreatedDate",
      "Policy__c.Id",
      "Policy__c.Name",
    ]);

    const premium = index.component(snap.id, "CustomField", "Policy__c.Premium__c")!;
    const near = index.related(premium.id);
    expect(near.map((r) => `${r.direction} ${r.kinds.join("+")} ${r.component.name}`)).toEqual([
      "out part_of Policy__c",
      "in reads RenewalService",
      "in writes+reads PolicyTrigger",
      "in shows Policy__c-Policy Layout",
      "in grants Policy_Manager",
      "in reads Sales/Pipeline",
      "in reads Policies_with_Claims",
      "in reads Policy__c.Premium_Required",
    ]);
    expect(near.find((r) => r.component.name === "PolicyTrigger")?.kind).toBe("writes");
    // Two hops out from the formula field: through Account to its owner field and User.
    const formula = index.component(snap.id, "CustomField", "Policy__c.Holder_Industry__c")!;
    const deep = index.related(formula.id, { depth: 2 }).filter((r) => r.direction === "out");
    expect(deep.find((r) => r.component.name === "User")).toMatchObject({ depth: 2, component: { missing: true } });
    expect(index.related(formula.id, { kinds: ["references"] })).toEqual([]);
  });

  it("keeps only the newest snapshot of a source, and the old one when a run fails", async () => {
    const index = fresh();
    const first = await index.build({ source: "s", kind: "repo" }, () => scanProject(join(fixtures, "mdapi")));
    await expect(index.build({ source: "s", kind: "repo" }, () => Promise.reject(new Error("disk gone")))).rejects.toThrow("disk gone");
    expect(index.latest("s")?.id).toBe(first.id);
    expect(index.snapshots()[0]).toMatchObject({ status: "failed", stats: { error: "disk gone" } });

    const second = await index.build({ source: "s", kind: "repo" }, () => scanProject(join(fixtures, "mdapi")));
    expect(index.snapshots().map((s) => s.id)).toEqual([second.id]);
    expect(index.search(second.id, "Claim").length).toBeGreaterThan(0);
    expect(index.search(first.id, "Claim")).toEqual([]);
  });
});

describe("scanProject on awkward projects", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sf-agent-meta-"));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const write = (rel: string, xml: string) => {
    mkdirSync(join(tmp, rel, ".."), { recursive: true });
    writeFileSync(join(tmp, rel), xml);
  };

  it("fails when the project folder or a package folder cannot be read", async () => {
    await expect(scanProject(join(tmp, "nope"))).rejects.toThrow(/the project folder cannot be read/);
    write("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    await expect(scanProject(tmp)).rejects.toThrow(/^force-app cannot be read: ENOENT/);
    write("sfdx-project.json", "{ not json");
    await expect(scanProject(tmp)).rejects.toThrow("sfdx-project.json is not valid JSON");
  });

  it("reports a component defined twice, and keeps a bot's versions apart from an object's children", async () => {
    write("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "a" }, { path: "b" }] }));
    write("a/classes/Foo.cls", "public class Foo {}");
    write("a/classes/Foo.cls-meta.xml", "<ApexClass/>");
    write("b/classes/Foo.cls", "public class Foo {}");
    write("a/bots/Helper/Helper.bot-meta.xml", "<Bot/>");
    write("a/bots/Helper/v1.botVersion-meta.xml", "<BotVersion/>");
    write("a/objects/Helper/listViews/All.listView-meta.xml", "<ListView/>");
    const parsed = await scanProject(tmp);
    expect(parsed.components.filter((c) => c.type === "ApexClass")).toMatchObject([{ name: "Foo", file: "a/classes/Foo.cls" }]);
    expect(parsed.skipped).toEqual([{ file: "b/classes/Foo.cls", reason: "ApexClass Foo is also defined in a/classes/Foo.cls" }]);

    const index = fresh();
    const snap = await index.build({ source: "s", kind: "repo" }, async () => parsed);
    expect(index.children(snap.id, "Helper").map((c) => c.name)).toEqual(["Helper.All"]);
    expect(index.children(snap.id, "Helper", "Bot")).toMatchObject([{ name: "Helper.v1", parent: "Helper", parentType: "Bot" }]);
  });

  it("matches names without case, and links roll-ups and dependent picklists", async () => {
    write("objects/Policy__c.object", `<CustomObject>
      <fields><fullName>Holder__c</fullName><type>Lookup</type><referenceTo>Account</referenceTo></fields>
      <fields><fullName>Region__c</fullName><type>Picklist</type></fields>
      <fields><fullName>City__c</fullName><type>Picklist</type><valueSet><controllingField>region__c</controllingField></valueSet></fields>
      <fields><fullName>Label__c</fullName><type>Text</type><formula>holder__r.Name &amp; HOLDER__C</formula></fields>
      <fields><fullName>Claims_Total__c</fullName><type>Summary</type><summarizedField>Claim__c.Amount__c</summarizedField><summaryForeignKey>Claim__c.Policy__c</summaryForeignKey><summaryOperation>sum</summaryOperation></fields>
    </CustomObject>`);
    write("objects/claim__c.object", `<CustomObject><fields><fullName>Amount__c</fullName><type>Currency</type></fields></CustomObject>`);
    const { components, edges } = await scanProject(tmp);
    const names = components.map((c) => `${c.type}:${c.name}`);
    // No placeholder next to the real field because of a different case.
    expect(names.filter((n) => n.toLowerCase() === "customfield:policy__c.holder__c")).toEqual(["CustomField:Policy__c.Holder__c"]);
    const reads = (from: string) => edges.filter((e) => e.from.name === from && e.kind === "reads").map((e) => e.to.name).sort();
    expect(reads("Policy__c.Label__c")).toEqual(["Account.Name", "Policy__c.Holder__c"]);
    expect(reads("Policy__c.City__c")).toEqual(["Policy__c.Region__c"]);
    // The roll-up reads the declared claim__c spelling, and the placeholder for Policy__c on it.
    expect(reads("Policy__c.Claims_Total__c")).toEqual(["claim__c.Amount__c", "claim__c.Policy__c"]);
    expect(components.find((c) => c.name === "claim__c.Policy__c")).toMatchObject({ missing: true, parent: "claim__c" });
  });

  it("reads pages, components, email templates and field sets, and fields code reaches without a type", async () => {
    const field = (name: string) => `<CustomField><fullName>${name}</fullName><type>Text</type></CustomField>`;
    write("objects/Contact/fields/LifetimeSpent__c.field-meta.xml", field("LifetimeSpent__c"));
    for (const o of ["Policy__c", "Claim__c"]) write(`objects/${o}/fields/Status__c.field-meta.xml`, field("Status__c"));
    write("objects/Claim__c/fields/Policy__c.field-meta.xml", field("Policy__c"));
    write("objects/Claim__c/fields/Invoice__c.field-meta.xml", field("Invoice__c"));
    write("objects/Claim__c/fields/Commented__c.field-meta.xml", field("Commented__c"));
    write("objects/Case/fields/Claim_No__c.field-meta.xml", field("Claim_No__c"));
    for (const o of ["Contact", "Lead"]) write(`objects/${o}/fields/Segment__c.field-meta.xml`, field("Segment__c"));
    write("objects/Account/fieldSets/Card.fieldSet-meta.xml", `<FieldSet><fullName>Card</fullName><label>Card</label>
      <displayedFields><field>LifetimeSpent__pc</field></displayedFields><availableFields><field>Owner.Email</field></availableFields></FieldSet>`);
    write("classes/Untyped.cls", `public class Untyped {
      public static Object spent(Map<Id, Account> byId, Id id, SObject rec) {
        // rec.get('Commented__c') is a comment
        Object a = byId.get(id).LifetimeSpent__pc;
        Object b = rec.get('LifetimeSpent__pc');
        List<SObject> rows = Database.query('SELECT Id, Status__c FROM Policy__c');
        List<SObject> invoices = Database.query('SELECT Id FROM Invoice__c');
        Object t = Schema.getGlobalDescribe().get('Invoice__c');
        Object c = Policy__c.SObjectType;
        return SObjectType.Account.FieldSets.Card.getFields();
      }
    }`);
    write("classes/Untyped.cls-meta.xml", "<ApexClass/>");
    // Invoice__c is an object somewhere else (a managed one): its name in a string is not Claim__c's lookup.
    write("classes/Managed.cls", "public class Managed { Object o = Invoice__c.SObjectType; }");
    write("pages/ClientCard.page", `<apex:page standardController="Account" extensions="Untyped">
      <!-- {!Account.Hidden__c} -->
      <apex:outputField value="{!Account.LifetimeSpent__pc}"/> {!wrapper.row.Status__c}
      <apex:repeat value="{!$ObjectType.Account.FieldSets.Card}" var="f"/> <c:Badge/> {!$Label.Spent_Title}
      {!IF(Account.Rating='Hot', 'Ask Account.Sarah later', '')} {!Account.Contacts} {!Account.Claims__r} {!$User.UITheme}
      <apex:include pageName="{!$Page.Footer}"/> <apex:composition template="Frame"/>
    </apex:page>`);
    write("pages/ClientCard.page-meta.xml", "<ApexPage><label>Card</label></ApexPage>");
    write("pages/Footer.page", "<apex:page/>");
    write("pages/Frame.page", "<apex:page/>");
    write("components/Badge.component", `<apex:component controller="Untyped">{!vm.rows[0].Commented__c}</apex:component>`);
    write("email/Clients/Thanks.email", "Dear Sarah Connor, you spent {!Contact.LifetimeSpent__c}. {{{Recipient.LifetimeSpent__c}}}");
    write("email/Clients/Thanks.email-meta.xml", "<EmailTemplate><name>Thanks Sarah</name><subject>Claim {!Case.Claim_No__c}</subject></EmailTemplate>");
    write("email/Clients/Segment.email", "{{{Recipient.Segment__c}}} {{{Sender.Name}}}");
    write("email/Clients/Summary.email", `<messaging:emailTemplate relatedToType="Account" recipientType="Contact" subject="x">{!relatedTo.LifetimeSpent__pc} {!recipient.Owner.Email}</messaging:emailTemplate>`);
    const { components, edges } = await scanProject(tmp);
    const from = (type: string, name: string) =>
      edges.filter((e) => e.from.type === type && e.from.name === name && e.kind !== "part_of").map((e) => `${e.kind} ${e.to.type}:${e.to.name}`).sort();

    expect(from("FieldSet", "Account.Card")).toEqual(["reads CustomField:Account.OwnerId", "shows CustomField:Account.LifetimeSpent__pc", "shows CustomField:User.Email"]);
    // Policy__c after FROM and Policy__c.SObjectType are the object, not Claim__c's lookup; Status__c is on two objects.
    expect(from("ApexClass", "Untyped")).toEqual(["reads CustomField:Account.LifetimeSpent__pc", "reads CustomObject:Policy__c", "reads FieldSet:Account.Card"]);
    // Words in strings, child relationships and $User properties are not fields.
    expect(from("ApexPage", "ClientCard")).toEqual([
      "calls ApexClass:Untyped",
      "calls ApexComponent:Badge",
      "calls ApexPage:Footer",
      "calls ApexPage:Frame",
      "reads CustomField:Account.LifetimeSpent__pc",
      "reads CustomLabel:Spent_Title",
      "reads CustomObject:Account",
      "reads FieldSet:Account.Card",
    ]);
    expect(from("ApexComponent", "Badge")).toEqual(["calls ApexClass:Untyped", "reads CustomField:Claim__c.Commented__c"]);
    // The subject, in the -meta.xml, holds merge fields too.
    expect(from("EmailTemplate", "Clients/Thanks")).toEqual(["reads CustomField:Case.Claim_No__c", "reads CustomField:Contact.LifetimeSpent__c"]);
    expect(from("EmailTemplate", "Clients/Summary")).toEqual(["reads CustomField:Account.LifetimeSpent__pc", "reads CustomObject:Account", "reads CustomObject:Contact"]);
    // A Lightning template's recipient is a contact, a lead or a user.
    expect(from("EmailTemplate", "Clients/Segment")).toEqual(["reads CustomField:Contact.Segment__c", "reads CustomField:Lead.Segment__c", "reads CustomObject:User"]);
    // The person account field is the contact field.
    expect(edges).toContainEqual({ from: { type: "CustomField", name: "Account.LifetimeSpent__pc" }, to: { type: "CustomField", name: "Contact.LifetimeSpent__c" }, kind: "references" });
    // No text of a template or page is kept, and their -meta.xml files are the same component.
    const thanks = components.filter((c) => c.type === "EmailTemplate" && c.name === "Clients/Thanks");
    expect(thanks).toMatchObject([{ file: "email/Clients/Thanks.email", text: "" }]);
    expect(JSON.stringify(components)).not.toContain("Sarah");
    expect(components.filter((c) => c.type === "ApexPage" && !c.missing)).toHaveLength(3);
    expect(components.some((c) => /sarah/i.test(c.name))).toBe(false);
  });

  it("reads unclosed comments, tags and merge fields in linear time", () => {
    const started = performance.now();
    for (const piece of ["<!-- ", "<apex:page ", "{!", "{{{", "<apex:include "]) readMarkup("ApexPage", "P", piece.repeat(400_000 / piece.length), "pages/P.page");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(readMarkup("ApexPage", "P", "x".repeat(MAX_MARKUP_LENGTH + 1), "pages/P.page")).toMatchObject({ attrs: { tooLarge: true } });
  });

  it("normalises package paths and refuses ones that leave the project", () => {
    expect(packagePath(".")).toBe("");
    expect(packagePath("./force-app/")).toBe("force-app");
    expect(packagePath("force-app\\main")).toBe("force-app/main");
    expect(packagePath("../other")).toBeUndefined();
    expect(packagePath("/abs")).toBeUndefined();
    expect(packagePath("C:/abs")).toBeUndefined();
  });
});

describe("MetadataIndex runs of the same source", () => {
  it("keeps the good snapshot when a scan fails, and lets one run at a time", async () => {
    const index = fresh();
    const good = await index.build({ source: "s", kind: "repo" }, () => scanProject(join(fixtures, "mdapi")));
    await expect(index.build({ source: "s", kind: "repo" }, () => scanProject(join(fixtures, "nope")))).rejects.toThrow(/cannot be read/);
    expect(index.latest("s")?.id).toBe(good.id);

    // A run under way holds the source; force goes ahead, and the one that finishes last wins.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = index.build({ source: "s", kind: "repo", revision: "slow" }, async () => {
      await gate;
      return scanProject(join(fixtures, "mdapi"));
    });
    await expect(index.build({ source: "s", kind: "repo" }, () => scanProject(join(fixtures, "mdapi")))).rejects.toThrow("s is already being indexed");
    const quick = await index.build({ source: "s", kind: "repo", revision: "quick" }, () => scanProject(join(fixtures, "mdapi")), { force: true });
    expect(index.latest("s")?.id).toBe(quick.id);
    release();
    const late = await slow;
    expect(index.latest("s")).toMatchObject({ id: late.id, revision: "slow" });
    expect(index.snapshots().map((s) => s.id)).toEqual([late.id]);
  });
});
