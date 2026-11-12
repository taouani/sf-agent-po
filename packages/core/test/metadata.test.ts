import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { apexCode, classify, detectWithRules, isNameValue, readCustomMetadataRecord, HIDDEN_SECRET, hideCodeSecrets, classifyFile, Database, formulaCode, formulaFields, linkObjects, MAX_APEX_LENGTH, MAX_MARKUP_LENGTH, MetadataIndex, packagePath, parseMetadataXml, readApex, readFlow, readMarkup, MAX_OUTLINE_LENGTH, reportColumnRef, scanProject, soqlFields, type ParsedComponent } from "../src/index.js";

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
    expect(out("Sales/Weekly")).toEqual(["reads CustomField:Policy__c.Status__c", "reads Report:Sales/Pipeline"]);
    // A joined report's blocks, its summary formula, a cross filter and a report type's lookup.
    expect(out("Sales/Claims_Joined")).toEqual([
      "reads CustomField:Account.Id",
      "reads CustomField:Account.Segment__c",
      "reads CustomField:Policy__c.Holder__c",
      "reads CustomField:Policy__c.Premium__c",
      "reads CustomField:Policy__c.Status__c",
      "reads CustomObject:Policy__c",
    ]);
    expect(out("Policies_with_Claims")).toEqual(["reads CustomField:Policy__c.Premium__c", "reads CustomObject:Policy__c"]);
    const report = components.find((c) => c.name === "Sales/Pipeline")!;
    expect(report).toMatchObject({ label: "Pipeline", attrs: { reportType: "Policies_with_Claims__c", format: "Summary", filterFields: ["Policy__c$Status__c"] } });
    expect(components.find((c) => c.type === "ReportType")).toMatchObject({ label: "Policies with Claims", attrs: { baseObject: "Policy__c", joins: ["Claims__r (with or without)"], fields: 2 } });
    const kept = JSON.stringify(components.filter((c) => ["Report", "Dashboard", "ReportType"].includes(c.type)));
    for (const secret of ["Acme Holdings", "Bob Smith", "jane.doe@example.com"]) expect(kept).not.toContain(secret);
    expect(components.find((c) => c.type === "Dashboard")?.attrs).toEqual({ reportCount: 1, dashboardType: "SpecifiedUser", filterFields: ["Policy__c$Status__c"] });
  });

  it("reads integrations: hosts only, and never a secret, a key, a username or an email", async () => {
    const { components, edges } = await scanProject(join(fixtures, "source"));
    const out = (name: string) => edges.filter((e) => e.from.name === name).map((e) => `${e.kind} ${e.to.type}:${e.to.name}`).sort();
    expect(out("ERP")).toEqual(["references ExternalCredential:ERP_Auth"]);
    // An auth provider is linked only when the project has it: an org's are not retrieved.
    expect(out("ERP_Auth")).toEqual([]);
    expect(out("Weather")).toEqual(["references NamedCredential:ERP"]);
    expect(out("Sync_Policy")).toEqual(["part_of PlatformEventChannel:Sync__chn", "reads CustomObject:Policy__ChangeEvent"]);
    expect(out("Policy__c.Notify_ERP")).toEqual(["part_of Workflow:Policy__c", "reads CustomField:Policy__c.Id", "reads CustomField:Policy__c.Status__c"]);
    // Apex: a callout through a named credential, a literal endpoint's host (not a commented one), a published event.
    expect(out("ErpClient")).toEqual(expect.arrayContaining(["calls NamedCredential:ERP", "writes CustomObject:Policy_Sync__e"]));
    const byName = (n: string) => components.find((c) => c.name === n)!;
    expect(byName("ErpClient").attrs.calloutHosts).toEqual(["api.partner.example"]);
    expect(byName("ERP").attrs).toMatchObject({ host: "erp.example.com", type: "SecuredEndpoint" });
    expect(byName("ERP_Auth").attrs).toMatchObject({ authProvider: "Okta" });
    expect(byName("Legacy").attrs).toEqual({ host: "legacy.example.com", active: true, protocolSecurityDisabled: false });
    expect(byName("Mobile").attrs).toMatchObject({ scopes: ["Api", "RefreshToken"], callbackHosts: ["app.example.com"] });
    expect(byName("Policy__c.Notify_ERP").attrs).toEqual({ host: "erp.example.com", fields: ["Id", "Status__c"], includeSessionId: false });
    // The code of a class is kept apart (masked when shown), with its secrets hidden.
    const kept = JSON.stringify(components.filter((c) => c.file && !c.file.includes("/objects/")).map(({ body: _, ...c }) => c));
    for (const secret of ["SECRET", "jane.doe@example.com", "for/acme", "/hook", "/orders"]) expect(kept).not.toContain(secret);
    expect(byName("ErpClient").body).toContain("v1?apikey=HIDDEN_SECRET'");
    expect(JSON.stringify(components)).not.toContain("K1_SECRET");
  });

  it("names the field a report column reads", () => {
    expect(reportColumnRef("Policy__c$Premium__c")).toEqual({ kind: "reads", object: "Policy__c", path: "Premium__c" });
    expect(reportColumnRef("Policy__c.Claims__r$Amount__c")).toEqual({ kind: "reads", field: "Amount__c" });
    expect(reportColumnRef("Policy__c.Claims__r$Name")).toBeUndefined();
    // Through a lookup, and a standard lookup named by its relationship.
    expect(reportColumnRef("Policy__c$Holder__c.Segment__c")).toEqual({ kind: "reads", object: "Policy__c", path: "Holder__r.Segment__c" });
    expect(reportColumnRef("Opportunity$Account.Industry")).toEqual({ kind: "reads", object: "Opportunity", path: "Account.Industry" });
    expect(reportColumnRef("Account$Owner")).toEqual({ kind: "reads", object: "Account", path: "OwnerId" });
    // Historical trending columns, which no index holds.
    expect(reportColumnRef("Policy__hd$Premium__c__hst")).toBeUndefined();
    expect(reportColumnRef("Account.Segment__c")).toEqual({ kind: "reads", object: "Account", path: "Segment__c" });
    expect(reportColumnRef("FK_$Account.Segment__c")).toEqual({ kind: "reads", object: "Account", path: "Segment__c" });
    for (const standard of ["ACCOUNT.NAME", "CUST_NAME", "AMOUNT", "FK_ACC_NAME", "a$b$"]) expect(reportColumnRef(standard), standard).toBeUndefined();
  });

  it("indexes every other type by name and file", async () => {
    const { components } = await scanProject(join(fixtures, "source"));
    const others = components.filter((c) => !["CustomObject", "CustomField", "RecordType", "ValidationRule", "Flow"].includes(c.type) && !c.missing);
    expect(others.map((c) => `${c.type}:${c.name}`).sort()).toEqual([
      "ApexClass:ErpClient",
      "ApexClass:RenewalNotifier",
      "ApexClass:RenewalService",
      "ApexTrigger:PolicyTrigger",
      "ConnectedApp:Mobile",
      "Dashboard:Sales/Weekly",
      "DashboardFolder:Sales",
      "ExternalCredential:ERP_Auth",
      "ExternalServiceRegistration:Weather",
      "Layout:Policy__c-Policy Layout",
      "LightningComponentBundle:policyCard",
      "ListView:Policy__c.All",
      "NamedCredential:ERP",
      "PermissionSet:Policy_Manager",
      "PermissionSetGroup:Renewals",
      "PlatformEventChannel:Sync__chn",
      "PlatformEventChannelMember:Sync_Policy",
      "RemoteSiteSetting:Legacy",
      "Report:Sales/Claims_Joined",
      "Report:Sales/Pipeline",
      "ReportFolder:Sales",
      "ReportType:Policies_with_Claims",
      "Workflow:Policy__c",
      "WorkflowOutboundMessage:Policy__c.Notify_ERP",
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

describe("flow logic", () => {
  const flow = (xml: string) => readFlow("Case_Sharing", (parseMetadataXml(`<Flow>${xml}</Flow>`) as { Flow: Record<string, unknown> }).Flow, "flows/Case_Sharing.flow-meta.xml");

  it("is kept as an outline in the order the flow runs, with conditions, filters and secrets hidden", () => {
    const f = flow(`
      <label>Case Sharing</label><processType>AutoLaunchedFlow</processType><status>Active</status><apiVersion>62.0</apiVersion>
      <start><object>Case</object><triggerType>RecordAfterSave</triggerType><recordTriggerType>CreateAndUpdate</recordTriggerType>
        <filterLogic>1 AND (2 OR 3)</filterLogic>
        <filters><field>RecordTypeId</field><operator>EqualTo</operator><value><elementReference>Care_RT</elementReference></value></filters>
        <filters><field>CareZone__c</field><operator>IsChanged</operator><value><booleanValue>true</booleanValue></value></filters>
        <filters><field>Store__c</field><operator>IsNull</operator><value><booleanValue>false</booleanValue></value></filters>
        <connector><targetReference>Check_Zone</targetReference></connector></start>
      <recordUpdates><name>Unreached</name><object>Case</object></recordUpdates>
      <actionCalls><name>Share</name><label>Share</label><actionName>CARE_CaseSharing</actionName><actionType>apex</actionType>
        <inputParameters><name>caseIds</name><value><elementReference>$Record.Id</elementReference></value></inputParameters>
        <faultConnector><targetReference>Log_Error</targetReference></faultConnector></actionCalls>
      <decisions><name>Check_Zone</name><label>Check zone</label>
        <rules><name>Is_EU</name><conditionLogic>and</conditionLogic>
          <conditions><leftValueReference>$Record.CareZone__c</leftValueReference><operator>EqualTo</operator><rightValue><stringValue>EU</stringValue></rightValue></conditions>
          <conditions><leftValueReference>$Record.Owner:User.Email</leftValueReference><operator>NotEqualTo</operator><rightValue><stringValue>it's karim.benali@example.com</stringValue></rightValue></conditions>
          <connector><targetReference>Get_Group</targetReference></connector></rules>
        <defaultConnectorLabel>Other zones</defaultConnectorLabel></decisions>
      <recordLookups><name>Get_Group</name><object>Group</object><getFirstRecordOnly>true</getFirstRecordOnly>
        <filterLogic>and</filterLogic>
        <filters><field>DeveloperName</field><operator>EqualTo</operator><value><stringValue>Care_CentralTeam_EU</stringValue></value></filters>
        <queriedFields>Id</queriedFields>
        <connector><targetReference>Share</targetReference></connector></recordLookups>
      <recordCreates><name>Log_Error</name><object>Error_Log__c</object>
        <inputAssignments><field>Message__c</field><value><elementReference>$Flow.FaultMessage</elementReference></value></inputAssignments></recordCreates>
      <constants><name>apiKey</name><dataType>String</dataType><value><stringValue>k_9f8e7d6c</stringValue></value></constants>
      <formulas><name>Zone</name><dataType>String</dataType><expression>TEXT(
        {!$Record.CareZone__c})</expression></formulas>`);
    const lines = f.body!.split("\n");
    expect(lines[0]).toBe('FLOW Case_Sharing "Case Sharing" (AutoLaunchedFlow, Active, API 62.0)');
    expect(f.body).toContain("START after save on Case, when a record is created or updated");
    expect(f.body).toContain("  only when 1 AND (2 OR 3):\n    1: RecordTypeId EqualTo {!Care_RT}\n    2: CareZone__c IsChanged true\n    3: Store__c IsNull false\n");
    expect(f.body).toContain("  outcome Is_EU when all of:\n    {!$Record.CareZone__c} EqualTo 'EU'\n    {!$Record.Owner:User.Email} NotEqualTo 'it\\'s karim.benali@example.com'\n    -> Get_Group");
    expect(f.body).toContain('otherwise "Other zones" -> (end)');
    expect(f.body).toContain("  where:\n    DeveloperName EqualTo 'Care_CentralTeam_EU'");
    expect(f.body).toContain("input caseIds = {!$Record.Id}");
    expect(f.body).toContain("on error -> Log_Error");
    expect(f.body).toContain("formula Zone = TEXT( {!$Record.CareZone__c}) (String)");
    // In the order the flow runs: the start, the decision, the lookup, the action, its fault path.
    const at = (s: string) => lines.findIndex((l) => l.startsWith(s));
    const order = ["START", "DECISION Check_Zone", "GET RECORDS Get_Group", "ACTION Share", "CREATE RECORDS Log_Error", "-- Not reached", "UPDATE RECORDS Unreached"].map(at);
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!))).toBe(true);
    // A secret among the values is hidden before the outline is kept.
    expect(f.body).toContain("constant apiKey = 'HIDDEN_SECRET'");
    expect(f.body).not.toContain("k_9f8e7d6c");
    expect(f.attrs.lines).toBe(lines.length);
  });

  it("hides secrets wherever a flow holds a value, and keeps every name maskable", () => {
    const f = flow(`
      <start><object>Case</object><triggerType>RecordAfterSave</triggerType>
        <scheduledPaths><pathType>AsyncAfterCommit</pathType><connector><targetReference>Call</targetReference></connector></scheduledPaths>
        <connector><targetReference>Check</targetReference></connector></start>
      <decisions><name>Check</name><rules><name>R</name><label>Owner's rule</label>
        <conditions><leftValueReference>x</leftValueReference><operator>EqualTo</operator><rightValue><stringValue>apikey=supersecret123</stringValue></rightValue></conditions>
        <connector><targetReference>Get_Acc</targetReference></connector></rules></decisions>
      <recordLookups><name>Get_Acc</name><object>Account</object>
        <outputAssignments><assignToReference>acctName</assignToReference><field>Name</field></outputAssignments>
        <connector><targetReference>Call</targetReference></connector></recordLookups>
      <actionCalls><name>Call</name><actionName>Pricing.price</actionName><actionType>externalService</actionType>
        <inputParameters><name>apiKey</name><value><stringValue>k_9f8e7d6c5b4a</stringValue></value></inputParameters>
        <inputParameters><name>amount</name><value><formulaDataType>Number</formulaDataType><formulaExpression>{!x} * 2</formulaExpression></value></inputParameters>
        <connector><targetReference>Sub</targetReference></connector></actionCalls>
      <subflows><name>Sub</name><flowName>Child</flowName>
        <inputAssignments><name>password</name><value><stringValue>hunter2hunter2</stringValue></value></inputAssignments>
        <outputAssignments><assignToReference>result</assignToReference><name>out</name></outputAssignments></subflows>
      <variables><name>authToken</name><dataType>String</dataType><value><stringValue>tok_abcdef123456</stringValue></value></variables>
      <formulas><name>Url</name><dataType>String</dataType><expression>"https://api.example.com/v1?apikey=formulasecret123" &amp; {!x}</expression></formulas>
      <textTemplates><name>Mail</name><text>Regards,
Karim Benali</text></textTemplates>`);
    for (const secret of ["supersecret123", "k_9f8e7d6c5b4a", "hunter2hunter2", "tok_abcdef123456", "formulasecret123"]) expect(f.body, secret).not.toContain(secret);
    expect(f.body).toContain('outcome R "Owner’s rule" when:');
    expect(f.body).toContain("{!acctName} = field Name");
    expect(f.body).toContain("input amount = formula {!x} * 2");
    expect(f.body).toContain("{!result} = output out");
    expect(f.body).toContain("path (unnamed): runs asynchronously, after the save -> Call");
    // A template keeps one literal per line: a name at the start of a line stays a word of its own.
    expect(f.body).toContain("text template Mail =\n    'Regards,'\n    'Karim Benali'");
    expect(flow("<textTemplates><name>T</name><text>Hi</text></textTemplates><constants><name>C</name><value><stringValue>a\nBenali</stringValue></value></constants>").body).toContain("constant C = 'a\\n Benali'");
  });

  it("is cut, not dropped, when a flow is too large", () => {
    const rules = Array.from({ length: 30 }, (_, i) => `<conditions><leftValueReference>v${i}</leftValueReference><operator>EqualTo</operator><rightValue><stringValue>${"x".repeat(100)}</stringValue></rightValue></conditions>`).join("");
    const decisions = Array.from({ length: 400 }, (_, i) => `<decisions><name>D${i}</name><rules><name>R</name>${rules}</rules></decisions>`).join("");
    const f = flow(decisions);
    expect(f.body!.length).toBeLessThanOrEqual(MAX_OUTLINE_LENGTH + 100);
    expect(f.body).toMatch(/\n\n-- The outline stops here: the flow is too large to keep all of it\.$/);
    expect(f.attrs.tooLarge).toBeUndefined();
  });

  it("follows loops and waits, and keeps flows with no start element", () => {
    const f = flow(`
      <startElementReference>Each</startElementReference>
      <loops><name>Each</name><collectionReference>Cases</collectionReference><nextValueConnector><targetReference>Add</targetReference></nextValueConnector><noMoreValuesConnector><targetReference>Wait_Day</targetReference></noMoreValuesConnector></loops>
      <assignments><name>Add</name><assignmentItems><assignToReference>Ids</assignToReference><operator>Add</operator><value><elementReference>Each.Id</elementReference></value></assignmentItems><connector><targetReference>Each</targetReference></connector></assignments>
      <waits><name>Wait_Day</name><waitEvents><name>Tomorrow</name><connector><targetReference>Done</targetReference></connector></waitEvents></waits>
      <recordDeletes><name>Done</name><inputReference>Cases</inputReference></recordDeletes>
      <variables><name>Cases</name><dataType>SObject</dataType><objectType>Case</objectType><isCollection>true</isCollection><isInput>true</isInput></variables>`);
    expect(f.body).toContain("START\n  -> Each");
    expect(f.body).toContain("LOOP Each\n  over {!Cases}\n  each -> Add\n  then -> Wait_Day");
    expect(f.body).toContain("{!Ids} Add {!Each.Id}");
    expect(f.body).toContain("WAIT Wait_Day\n  event Tomorrow -> Done\n  otherwise -> (end)");
    expect(f.body).toContain("DELETE RECORDS Done\n  on {!Cases}");
    expect(f.body).toContain("variable Cases (Case, collection, input)");
    expect(f.body).not.toContain("Not reached");
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
    // Comments are not read: they can name people, and what they mention is not used. They stay
    // in the code, which a tool masks before it shows it.
    expect(JSON.stringify({ ...service, body: undefined })).not.toContain("Dupont");
    expect(service.body).toContain("Dupont");
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
  it("lists components by type and finds what names a host", async () => {
    const index = fresh();
    const c = (type: string, name: string, attrs: Record<string, unknown>, extra: Partial<ParsedComponent> = {}): ParsedComponent => ({ type, name, file: `${name}.x`, attrs, text: "", ...extra });
    const snap = await index.build({ source: "s", kind: "repo" }, async () => ({
      components: [
        c("ApexClass", "A", { calloutHosts: ["api.example.com"] }),
        c("ApexClass", "B", {}),
        c("RemoteSiteSetting", "Site", { host: "api.example.com" }),
        c("ConnectedApp", "App", { callbackHosts: ["api.example.com"] }),
        c("NamedCredential", "Gone", {}, { missing: true }),
        // A field whose attrs name the host is not of a type that carries hosts.
        c("CustomField", "Account.Url__c", { host: "api.example.com" }),
      ],
      edges: [],
      skipped: [],
    }));
    expect(index.ofTypes(snap.id, ["ApexClass"]).map((x) => x.name)).toEqual(["A", "B"]);
    expect(index.ofTypes(snap.id, ["ApexClass"], { attr: "calloutHosts" }).map((x) => x.name)).toEqual(["A"]);
    expect(index.ofTypes(snap.id, ["ApexClass"], { limit: 1 }).map((x) => x.name)).toEqual(["A"]);
    expect(index.ofTypes(snap.id, ["NamedCredential"])).toEqual([]);
    expect(index.ofTypes(snap.id, ["NamedCredential"], { missing: true }).map((x) => x.name)).toEqual(["Gone"]);
    expect(() => index.ofTypes(snap.id, ["ApexClass"], { attr: "x') OR 1=1 --" })).toThrow(/Not an attribute name/);
    expect(index.withHost(snap.id, " API.example.com ").map((x) => `${x.type}:${x.name}`)).toEqual(["ApexClass:A", "ConnectedApp:App", "RemoteSiteSetting:Site"]);
    expect(index.withHost(snap.id, "(an IP address)")).toEqual([]);
    expect(index.withHost(snap.id, "other.example.com")).toEqual([]);
  });

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
      "in reads Sales/Claims_Joined",
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

  it("reads integrations in every layout: split outbound messages, change events, unreadable files", async () => {
    write("workflows/Account/workflowOutboundMessages/Notify.workflowOutboundMessage-meta.xml",
      "<WorkflowOutboundMessage><endpointUrl>https://erp.example.com/hook?key=abc</endpointUrl><fields>Name</fields><integrationUser>jane.doe@example.com</integrationUser><name>Notify</name></WorkflowOutboundMessage>");
    write("workflows/Account.workflow-meta.xml", "<Workflow/>");
    write("platformEventChannelMembers/Account_CDC.platformEventChannelMember-meta.xml",
      "<PlatformEventChannelMember><eventChannel>ChangeEvents</eventChannel><selectedEntity>AccountChangeEvent</selectedEntity></PlatformEventChannelMember>");
    // A file the reader refuses is still the project's, by name: the flow that calls it does not find it missing.
    write("externalServiceRegistrations/Big.externalServiceRegistration-meta.xml", '<!DOCTYPE x><ExternalServiceRegistration/>');
    write("remoteSiteSettings/Ip.remoteSite-meta.xml",
      "<RemoteSiteSetting><url>https://10.0.0.5:8443/</url><description>See https://wiki.example.com/page?token=abc123 for details</description><isActive>true</isActive></RemoteSiteSetting>");
    write("namedCredentials/Old.namedCredential-meta.xml",
      "<NamedCredential><endpoint>https://old.example.com/api</endpoint><authProvider>Okta</authProvider><username>jane.doe@example.com</username><principalType>NamedUser</principalType></NamedCredential>");
    write("classes/Client.cls", [
      "public class Client {",
      "  void a(HttpRequest r) { r.setEndpoint('https://api.example.com/it\\'s'); }",
      "  void b(HttpRequest r) { r.setEndpoint('CALLOUT:Billing/v1'); }",
      "  void c(HttpRequest r, String h) { r.setEndpoint('https://' + h + '/x'); }",
      "}",
    ].join("\n"));
    const { components, edges, skipped } = await scanProject(tmp);
    const out = (name: string) => edges.filter((e) => e.from.name === name).map((e) => `${e.kind} ${e.to.type}:${e.to.name}`).sort();
    const byName = (n: string) => components.find((c) => c.name === n)!;
    expect(byName("Account.Notify")).toMatchObject({ type: "WorkflowOutboundMessage", parent: "Account", parentType: "Workflow", attrs: { host: "erp.example.com", fields: ["Name"] } });
    expect(out("Account.Notify")).toEqual(["part_of Workflow:Account", "reads CustomField:Account.Name"]);
    expect(out("Account_CDC")).toEqual(["reads CustomObject:AccountChangeEvent"]);
    expect(byName("Big")).toMatchObject({ type: "ExternalServiceRegistration", file: "externalServiceRegistrations/Big.externalServiceRegistration-meta.xml" });
    expect(byName("Big").missing).toBeUndefined();
    expect(skipped.map((s) => s.file)).toEqual(["externalServiceRegistrations/Big.externalServiceRegistration-meta.xml"]);
    expect(byName("Ip").attrs.host).toBe("(an IP address)");
    expect(byName("Ip").text).toBe("See wiki.example.com for details");
    expect(byName("Old").attrs).toMatchObject({ host: "old.example.com", authProvider: "Okta" });
    // An escaped quote ends no literal; a URL put together at run time has no host to keep.
    expect(byName("Client").attrs.calloutHosts).toEqual(["api.example.com"]);
    expect(out("Client")).toContain("calls NamedCredential:Billing");
    const kept = JSON.stringify(components);
    for (const secret of ["jane.doe", "10.0.0.5", "token=", "key=abc", "/hook", "/page"]) expect(kept).not.toContain(secret);
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
    // Policy__c after FROM and Policy__c.SObjectType are the object, not Claim__c's lookup; Status__c,
    // on two objects, is Policy__c's in the query built in a string, which is a weaker link. The
    // managed Invoice__c is not in the project: a query built in strings makes no placeholder.
    expect(from("ApexClass", "Untyped")).toEqual([
      "may_read CustomField:Policy__c.Status__c",
      "reads CustomField:Account.LifetimeSpent__pc",
      "reads CustomObject:Policy__c",
      "reads FieldSet:Account.Card",
    ]);
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

describe("Apex code in the index", () => {
  it("hides the secrets written in strings and comments, and keeps the rest", () => {
    const H = HIDDEN_SECRET;
    const cases: [string, string][] = [
      ["String apiKey = 'k_9f8e7d';", `String apiKey = '${H}';`],
      ["private static final String CLIENT_SECRET='abc123def';", `private static final String CLIENT_SECRET='${H}';`],
      ["req.setHeader('Authorization', 'Bearer eyabcdef.ghi');", `req.setHeader('Authorization', 'Bearer ${H}');`],
      ["req.setHeader('Authorization', 'dXNlcjpwd2Q=');", `req.setHeader('Authorization', '${H}');`],
      ["req.setHeader('x-api-key', 'zz99zz99');", `req.setHeader('x-api-key', '${H}');`],
      ["req.setHeader('Ocp-Apim-Subscription-Key', 'abcdabcd');", `req.setHeader('Ocp-Apim-Subscription-Key', '${H}');`],
      ["req.setHeader('X-Auth', 'abcdabcd');", `req.setHeader('X-Auth', '${H}');`],
      ["req.setHeader('Cookie', 'sid=00Dabc!xyz');", `req.setHeader('Cookie', 'sid=${H}');`],
      ["String h = 'Authorization: Bearer abc123def';", `String h = 'Authorization: Bearer ${H}';`],
      ["Blob cryptoKey = EncodingUtil.base64Decode('mRMjHmlC1C+1L/Dkz8EJuw==');", `Blob cryptoKey = EncodingUtil.base64Decode('${H}');`],
      ["String pw = 'hunterhunter';", `String pw = '${H}';`],
      ["String secretKey = 'correct horse battery staple';", `String secretKey = '${H}';`],
      ["m.put('access_token', 'abc123');", `m.put('access_token', '${H}');`],
      [
        "req.setBody('grant_type=password&client_id=abc&client_secret=s3cr3t&password=hunter22');",
        `req.setBody('grant_type=password&client_id=abc&client_secret=${H}&password=${H}');`,
      ],
      ["u = 'https://x.example/v1?apikey=K1&q=1';", `u = 'https://x.example/v1?apikey=${H}&q=1';`],
      [`b = '{"password":"hunterhunter","user":"x"}';`, `b = '{"password":"${H}","user":"x"}';`],
      ["b = '<password>HunterHunter</password>';", `b = '<password>${H}</password>';`],
      ["Blob c = Blob.valueOf('svcuser:Winter2024!');", `Blob c = Blob.valueOf('svcuser:${H}');`],
      [
        "req.setHeader('Authorization',\n  'Basic ' +\n  EncodingUtil.base64Encode(Blob.valueOf(USER + ':' + 'Hunter2024')));",
        `req.setHeader('Authorization',\n  'Basic ' +\n  EncodingUtil.base64Encode(Blob.valueOf(USER + ':' + '${H}')));`,
      ],
      // Commented-out code.
      ["/* req.setHeader('Authorization', 'Bearer abcDEF123'); */", `/* req.setHeader('Authorization', 'Bearer ${H}'); */`],
      ["// req.setHeader('x-api-key', 'zz99zz99');\nx = 1;", `// req.setHeader('x-api-key', '${H}');\nx = 1;`],
    ];
    for (const [code, hidden] of cases) expect(hideCodeSecrets(code)).toBe(hidden);
    // Not secrets: names, messages, queries, objects named near a secret, prose in comments.
    for (const code of [
      "String body = 'client_secret=' + secret;",
      "String passwordHint = 'Enter your password';",
      "req.setEndpoint('callout:ERP/token');",
      "String q = 'SELECT Id FROM Account WHERE Token__c = :t';",
      "String TOKEN_FIELD = 'Access_Token__c';",
      "String t = (String) m.get('access_token');",
      "if (token == null) objName = 'Account';",
      "// token\nString obj = 'Contact';",
      "String e = 'Token expired for this user';",
      "// don't change it, it's used by the batch\nString s = 'Status__c';",
      "String s = 'it\\'s fine'; Integer token = 3;",
      "String unclosed = 'abc\nString tokenName = 'x';",
    ])
      expect(hideCodeSecrets(code)).toBe(code);
    // The placeholder is shown as it is by the masking rules.
    expect(detectWithRules(`String password = '${H}';\nreq.setHeader('Authorization', 'Bearer ${H}');`)).toEqual([]);
  });

  it("keeps a class's code, comments included, apart from its searchable text", async () => {
    const src = "public class Mapper {\n  // Reads the field named in custom metadata\n  String q = 'SELECT ' + f + ' FROM Account';\n}";
    const c = readApex("ApexClass", "Mapper", src, "classes/Mapper.cls");
    expect(c.body).toBe(src);
    expect(c.text).toBe("");
    expect(readApex("ApexClass", "Big", "x".repeat(MAX_APEX_LENGTH + 1), "classes/Big.cls").body).toBeUndefined();

    const db = new Database(":memory:");
    open.push(db);
    const index = new MetadataIndex(db);
    const run = () => index.build({ source: "s", kind: "repo" }, async () => ({ components: [c, { type: "CustomObject", name: "Account", file: "o", attrs: {}, text: "" }], edges: [], skipped: [] }));
    const first = await run();
    const mapper = index.component(first.id, "ApexClass", "Mapper")!;
    expect(index.body(mapper.id)).toBe(src);
    expect(index.body(index.component(first.id, "CustomObject", "Account")!.id)).toBeUndefined();
    // The code is not searched: a word only found in a comment finds nothing.
    expect(index.search(first.id, "custom metadata")).toEqual([]);

    // A new snapshot replaces the old one, and the old code goes with it.
    const second = await run();
    expect(index.body(mapper.id)).toBeUndefined();
    expect(index.body(index.component(second.id, "ApexClass", "Mapper")!.id)).toBe(src);
    expect(db.db.prepare("SELECT count(*) AS n FROM component_body").get()).toEqual({ n: 1 });
  });
});

describe("queries built in strings", () => {
  const object = (name: string): ParsedComponent => ({ type: "CustomObject", name, file: "o", attrs: {}, text: "" });
  const field = (o: string, name: string): ParsedComponent => ({ type: "CustomField", name: `${o}.${name}`, parent: o, file: "f", attrs: {}, text: "" });
  /** The project: Account, Contact, Lead and Policy__c with a few fields. */
  const project = [
    object("Account"), field("Account", "Id"), field("Account", "Name"), field("Account", "Industry"), field("Account", "Segment__c"), field("Account", "Status__c"),
    object("Contact"), field("Contact", "Id"), field("Contact", "AccountId"), field("Contact", "Region__c"),
    object("Lead"), field("Lead", "Id"),
    object("Policy__c"), field("Policy__c", "Premium__c"),
  ];
  const link = (src: string) =>
    linkObjects([readApex("ApexClass", "Q", src, "classes/Q.cls"), ...project])
      .edges.filter((e) => e.from.name === "Q" && e.to.type !== "ApexClass")
      .map((e) => `${e.kind} ${e.to.name}`)
      .sort();

  it("reads them as weaker links, with constants and variables put back", () => {
    const src = [
      "public class Q {",
      "  private static final String OBJECT_NAME = 'Account';",
      "  @TestVisible static final String FIELDS = 'Id, Name, Segment__c';",
      "  public List<SObject> run(String status, List<String> extra) {",
      "    String q = 'SELECT ' + FIELDS + ', ' + String.join(extra, ',') + ' FROM ' + OBJECT_NAME;",
      "    q += ' WHERE Status__c = :status AND Name = \\'' + OBJECT_NAME + '\\'';",
      "    List<SObject> a = Database.query(q);",
      "    return Database.query('SELECT Id FROM Contact WHERE AccountId IN (SELECT Id FROM Account WHERE Industry = \\'x\\')');",
      "  }",
      "}",
    ].join("\n");
    const c = readApex("ApexClass", "Q", src, "classes/Q.cls");
    expect(c.attrs).toMatchObject({ builtQueries: 2, dynamic: ["query built from a string"] });
    // Only what the project has: no placeholder for a guess (the value 'Account' put in quotes is
    // not a field). A custom field one object alone has is linked by its name, as before.
    expect(link(src)).toEqual([
      "may_read Account",
      "may_read Account.Id",
      "may_read Account.Industry",
      "may_read Account.Name",
      "may_read Contact",
      "may_read Contact.AccountId",
      "may_read Contact.Id",
      "reads Account.Segment__c",
      "reads Account.Status__c",
    ]);
  });

  it("keeps a certain read over a weaker one, and never hides one", () => {
    expect(link("public class Q { void m() { Account a = [SELECT Name FROM Account LIMIT 1]; String q = 'SELECT Name, Industry FROM Account'; } }")).toEqual([
      "may_read Account.Industry",
      "reads Account",
      "reads Account.Name",
    ]);
    // A field the code reads by name stays a certain read beside a built query that names it.
    expect(link("Decimal p = helper().Premium__c; String q = 'SELECT Id FROM Policy__c WHERE Premium__c > 0';")).toEqual([
      "may_read Policy__c",
      "reads Policy__c.Premium__c",
    ]);
    // An object the query cannot be sure of (Lead or Contact) does not take the field from the one that has it.
    expect(link("String q = 'SELECT Id, Region__c FROM ' + (b ? 'Lead' : 'Contact');")).toEqual(["reads Contact.Region__c"]);
  });

  it("reads nothing from messages, values in inline queries or strings that are not queries", () => {
    for (const src of [
      "throw new MyException('Please select a contact from Account page');",
      "List<Account> a = [SELECT Id FROM Account WHERE Name = 'select Id from User'];",
      "String t = 'Hello'; String u = 'from Account select';",
    ])
      expect(readApex("ApexClass", "Q", src, "x").attrs.builtQueries).toBeUndefined();
  });

  it("reads a query rebuilt after a reassignment, and stays linear on long code", () => {
    expect(link("String q = 'SELECT Id FROM Lead'; q = 'SELECT Id FROM Contact';")).toEqual(["may_read Contact", "may_read Contact.Id", "may_read Lead", "may_read Lead.Id"]);
    const cases = [
      "q += 'SELECT a FROM b ' + x;\n".repeat(30_000),
      "String c" + "x".repeat(10) + " = 'v';\n".repeat(30_000) + "q = " + "c + ".repeat(50_000) + "'';",
      // A value repeated past any string's length, and many "select" with no FROM.
      `String a = '${"x".repeat(19_000)}'; String q = ${"a+".repeat(40_000)}'';`,
      `String a = '${"select ".repeat(2_700)}';\n` + "b = a;\n".repeat(20_000),
    ];
    for (const src of cases) {
      const start = performance.now();
      readApex("ApexClass", "Q", src, "x");
      expect(performance.now() - start).toBeLessThan(3_000);
    }
  });
});

describe("custom metadata mapping records", () => {
  const tmps: string[] = [];
  const dbs: Database[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const d of dbs.splice(0)) d.close();
  });
  const record = (values: Record<string, string | null>) =>
    `<?xml version="1.0" encoding="UTF-8"?><CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><label>Jeanne Dupont's mapping</label><protected>false</protected>` +
    Object.entries(values).map(([f, v]) => `<values><field>${f}</field>${v === null ? `<value xsi:nil="true"/>` : `<value xsi:type="xsd:string">${v}</value>`}</values>`).join("") +
    `</CustomMetadata>`;
  const project = () => {
    const root = mkdtempSync(join(tmpdir(), "sfpo-mdt-"));
    tmps.push(root);
    const w = (rel: string, c: string) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), c);
    };
    const field = (name: string) => `<CustomField><fullName>${name}</fullName><type>Text</type></CustomField>`;
    for (const [o, f] of [["Account", "Industry"], ["Account", "Segment__c"], ["Account", "Type"], ["Contact", "Segment__c"], ["Contact", "Email"], ["Lead", "Email"], ["Lead", "Rating"], ["Lead", "Industry"], ["Event", "Type"], ["Policy__c", "Premium__c"]])
      w(`objects/${o}/fields/${f}.field-meta.xml`, field(f!));
    w("objects/CIM_Client_Field__mdt/CIM_Client_Field__mdt.object-meta.xml", `<CustomObject><label>Client field</label></CustomObject>`);
    w("objects/ns__Cfg__mdt/ns__Cfg__mdt.object-meta.xml", `<CustomObject><label>Config</label></CustomObject>`);
    // A value naming the object, then its field alone; a full name; a custom field one object has.
    w("customMetadata/CIM_Client_Field.Industry.md-meta.xml", record({ Object__c: "Account", Field__c: "Industry", Target__c: "Client_Sector", Active__c: "true" }));
    w("customMetadata/CIM_Client_Field.Rating.md-meta.xml", record({ Source__c: "Lead.Rating", Note__c: "Call jane.doe@example.com", Empty__c: null }));
    w("customMetadata/CIM_Client_Field.Premium.md-meta.xml", record({ Field__c: "Premium__c", Other__c: "Segment__c", Missing__c: "Nope.Nothing__c" }));
    // A conversion table: the same field name on two objects, in one record and across records.
    w("customMetadata/CIM_Client_Field.Convert.md-meta.xml", record({ Source_Field__c: "Lead.Email", Target_Field__c: "Contact.Email" }));
    w("customMetadata/CIM_Client_Field.Ind2.md-meta.xml", record({ Source_Field__c: "Lead.Industry" }));
    // Metadata format and a namespace; common words in fields that do not name objects are not links.
    w("customMetadata/ns__Cfg.ns__Main.md", record({ Kind__c: "Type", Trigger__c: "Event", Key__c: "AKIAIOSFODNN7EXAMPLE", Owner__c: "Dupont" }));
    w("classes/ClientSync.cls", "public class ClientSync { void run() { for (CIM_Client_Field__mdt m : CIM_Client_Field__mdt.getAll().values()) { Object v = rec.get(m.Field__c); } } }");
    return root;
  };

  it("link the fields and objects their values name to their type, which code reads", async () => {
    const root = project();
    const { components, edges } = await scanProject(root);
    const out = (type: string) => edges.filter((e) => e.from.name === type && e.kind === "may_read").map((e) => `${e.to.type}:${e.to.name}`).sort();
    expect(out("CIM_Client_Field__mdt")).toEqual([
      "CustomField:Account.Industry",
      "CustomField:Contact.Email",
      "CustomField:Lead.Email",
      "CustomField:Lead.Industry",
      "CustomField:Lead.Rating",
      "CustomField:Policy__c.Premium__c",
      "CustomObject:Account",
    ]);
    expect(out("ns__Cfg__mdt")).toEqual([]);
    // No record is kept: only how many a type has.
    expect(components.filter((c) => c.type === "CustomMetadata")).toEqual([]);
    expect(components.find((c) => c.name === "CIM_Client_Field__mdt")!.attrs.records).toBe(5);
    expect(JSON.stringify(components)).not.toMatch(/Dupont|jane|Client_Sector|AKIA|Convert/);
  });

  it("keep no record and no value in the index or its parse cache, and reach the code through the type", async () => {
    const root = project();
    const db = new Database(":memory:");
    dbs.push(db);
    const index = new MetadataIndex(db);
    const run = () => index.build({ source: "repo:mdt", kind: "repo" }, (_lease, cache) => scanProject(root, { cache }));
    await run();
    const snap = await run();
    const stored = JSON.stringify([db.db.prepare("SELECT * FROM metadata_file").all(), db.db.prepare("SELECT name, label, attrs, text FROM component").all()]);
    expect(stored).not.toMatch(/Dupont|jane|Client_Sector|AKIA|CIM_Client_Field\.Industry/);
    // The second run, from the cache, still has the links.
    const industry = index.component(snap.id, "CustomField", "Account.Industry")!;
    const deps = index.dependents([industry.id]).map((d) => `${d.depth} ${d.kind} ${d.component.type}:${d.component.name}`);
    expect(deps).toEqual(expect.arrayContaining(["1 may_read CustomObject:CIM_Client_Field__mdt", "2 reads ApexClass:ClientSync"]));
  });

  it("know a name from a key, a token or a person", () => {
    for (const v of ["Account", "Account.Industry", "Segment__c", "ns__Field__c", "AccountId", "Lead.Email"]) expect(isNameValue(v)).toBe(true);
    for (const v of ["AKIAIOSFODNN7EXAMPLE", "k_9f8e7d", "true", "jane.doe@example.com", "abc123", "Two words", "x".repeat(90)]) expect(isNameValue(v)).toBe(false);
    expect(readCustomMetadataRecord({ values: [{ field: "Owner__c", value: "Dupont" }, { field: "Kind__c", value: "Event" }] })).toEqual([]);
  });
});

describe("record access: sharing rules, roles, groups and queues", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const project = () => {
    const root = mkdtempSync(join(tmpdir(), "sfpo-sharing-"));
    tmps.push(root);
    const w = (rel: string, c: string) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), c);
    };
    const field = (name: string) => `<CustomField><fullName>${name}</fullName><type>Text</type></CustomField>`;
    w("objects/Case/Case.object-meta.xml", "<CustomObject><sharingModel>Private</sharingModel></CustomObject>");
    for (const f of ["CareZone__c", "Origin", "Store__c"]) w(`objects/Case/fields/${f}.field-meta.xml`, field(f));
    w(
      "sharingRules/Case.sharingRules-meta.xml",
      `<?xml version="1.0"?><SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
        <sharingCriteriaRules><fullName>Care_EU</fullName><accessLevel>Edit</accessLevel><label>Care EU</label>
          <sharedTo><group>Care_CentralTeam_EU</group></sharedTo>
          <booleanFilter>1 AND 2</booleanFilter>
          <criteriaItems><field>CareZone__c</field><operation>equals</operation><value>EU</value></criteriaItems>
          <criteriaItems><field>Origin</field><operation>notEqual</operation><value>Karim Benali's line</value></criteriaItems>
        </sharingCriteriaRules>
        <sharingCriteriaRules><fullName>Managers</fullName><accessLevel>Read</accessLevel><label>Managers</label>
          <sharedTo><managers>jane.doe@acme.example.com</managers><managerSubordinates>john.roe@acme.example.com</managerSubordinates><guestUser>site.guest@acme.example.com</guestUser><groups><group>Care_CentralTeam_EU</group></groups></sharedTo>
          <criteriaItems><field>Store__c</field><operation>notEqual</operation><value></value></criteriaItems>
        </sharingCriteriaRules>
        <sharingOwnerRules><fullName>Stores_To_All</fullName><accessLevel>Read</accessLevel><label>Stores</label>
          <sharedTo><allInternalUsers></allInternalUsers></sharedTo>
          <sharedFrom><roleAndSubordinatesInternal>Store_Manager</roleAndSubordinatesInternal></sharedFrom>
        </sharingOwnerRules>
      </SharingRules>`,
    );
    w("roles/CEO.role-meta.xml", "<Role><name>CEO</name><caseAccessLevel>Edit</caseAccessLevel></Role>");
    w("roles/Store_Manager.role-meta.xml", "<Role><name>Store manager</name><parentRole>CEO</parentRole><caseAccessLevel>Read</caseAccessLevel><description>For stores</description></Role>");
    w("groups/Care_CentralTeam_EU.group-meta.xml", "<Group><name>Care central team EU</name><doesIncludeBosses>true</doesIncludeBosses></Group>");
    w(
      "queues/Care_Store_Paris.queue-meta.xml",
      `<Queue><name>Care store Paris</name><queueSobject><sobjectType>Case</sobjectType></queueSobject>
        <queueMembers><publicGroups><publicGroup>Care_CentralTeam_EU</publicGroup></publicGroups><roleAndSubordinates><roleAndSubordinate>Store_Manager</roleAndSubordinate></roleAndSubordinates><users><user>karim.benali@example.com</user></users></queueMembers></Queue>`,
    );
    return root;
  };
  const edge = (from: string, kind: string, to: string) => (e: { from: { type: string; name: string }; to: { type: string; name: string }; kind: string }) =>
    `${e.from.type}:${e.from.name}` === from && e.kind === kind && `${e.to.type}:${e.to.name}` === to;

  it("links rules to the fields they test, the object they share and the groups and roles they share with", async () => {
    const { components, edges } = await scanProject(project());
    const rules = components.find((c) => c.type === "SharingRules")!;
    expect(rules).toMatchObject({ name: "Case", parent: "Case", attrs: { object: "Case", counts: { criteria: 2, owner: 1 } } });
    // Users are named by their username: only words are kept.
    expect((rules.attrs.rules as { name: string; to: string }[]).find((r) => r.name === "Managers")!.to).toBe("a manager group, a manager and subordinates group, the site guest user, group Care_CentralTeam_EU");
    expect(JSON.stringify(rules)).not.toMatch(/jane|john|site\.guest/);
    (rules.attrs.rules as unknown[]).splice(1, 1);
    expect(rules.attrs.rules).toEqual([
      { name: "Care_EU", kind: "criteria", label: "Care EU", access: "Edit", to: "group Care_CentralTeam_EU", criteria: "1 AND 2 where 1: CareZone__c equals 'EU'; 2: Origin notEqual 'Karim Benali\\'s line'" },
      { name: "Stores_To_All", kind: "owner", label: "Stores", access: "Read", to: "all internal users", from: "role and internal subordinates Store_Manager" },
    ]);
    expect(rules.body).toContain("CRITERIA RULE Care_EU \"Care EU\"\n  records where 1 AND 2 where 1: CareZone__c equals 'EU'");
    expect(rules.body).toContain("  shared with group Care_CentralTeam_EU: Edit");
    expect(rules.body).toContain("OWNER RULE Stores_To_All \"Stores\"\n  records owned by role and internal subordinates Store_Manager\n  shared with all internal users: Read");
    for (const [kind, to] of [["reads", "CustomField:Case.CareZone__c"], ["reads", "CustomField:Case.Origin"], ["part_of", "CustomObject:Case"], ["references", "Group:Care_CentralTeam_EU"], ["references", "Role:Store_Manager"]])
      expect(edges.some(edge("SharingRules:Case", kind!, to!)), `${kind} ${to}`).toBe(true);
    expect(edges.some(edge("Role:Store_Manager", "references", "Role:CEO"))).toBe(true);
    expect(components.find((c) => c.type === "Role" && c.name === "Store_Manager")).toMatchObject({ label: "Store manager", attrs: { parentRole: "CEO", caseAccessLevel: "Read" }, text: "For stores" });
    expect(components.find((c) => c.type === "Group")).toMatchObject({ name: "Care_CentralTeam_EU", attrs: { doesIncludeBosses: "true" } });
    const queue = components.find((c) => c.type === "Queue")!;
    expect(queue.attrs).toEqual({ objects: ["Case"], members: { group: ["Care_CentralTeam_EU"], "role and subordinates": ["Store_Manager"] } });
    for (const to of ["CustomObject:Case", "Group:Care_CentralTeam_EU", "Role:Store_Manager"]) expect(edges.some(edge("Queue:Care_Store_Paris", "references", to)), to).toBe(true);
    // A queue's users are never kept.
    expect(JSON.stringify(queue)).not.toContain("karim");
  });
});
