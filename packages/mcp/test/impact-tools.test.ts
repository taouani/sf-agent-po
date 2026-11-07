import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BackgroundIndexer, indexProject } from "@sf-agent-po/connectors";
import { ContextRepository, Database, Masker, MetadataIndex, newVaultKey, readApex, Vault, type EntityDetector, type Span } from "@sf-agent-po/core";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, createServer } from "../src/index.js";

const fakeModel =
  (names: readonly string[]): EntityDetector =>
  async (text) => {
    const spans: Span[] = [];
    for (const name of names) for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) spans.push({ start: i, end: i + name.length, type: "PER", source: "ner" });
    return spans;
  };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Policy__c.Status__c is read by a rule, a formula, Apex and a draft flow, written by an active flow, and granted by a profile. */
function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "sf-agent-impact-"));
  dirs.push(root);
  const w = (rel: string, c: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), c);
  };
  w(
    "objects/Policy__c.object",
    `<?xml version="1.0"?><CustomObject><label>Policy</label>` +
      `<fields><fullName>Status__c</fullName><label>Status for Karim</label><type>Picklist</type></fields>` +
      `<fields><fullName>Status_Text__c</fullName><label>Status text</label><type>Text</type><formula>TEXT(Status__c)</formula></fields>` +
      `<fields><fullName>Notes__c</fullName><label>Notes</label><type>Text</type></fields>` +
      `<validationRules><fullName>Status_Required</fullName><active>true</active><errorConditionFormula>ISBLANK(TEXT(Status__c))</errorConditionFormula></validationRules></CustomObject>`,
  );
  w("objects/Claim__c.object", `<?xml version="1.0"?><CustomObject><label>Claim</label></CustomObject>`);
  w(
    "flows/Close_Policy.flow",
    `<?xml version="1.0"?><Flow><processType>AutoLaunchedFlow</processType><status>Active</status><start><object>Claim__c</object><triggerType>RecordAfterSave</triggerType><recordTriggerType>Update</recordTriggerType></start>` +
      `<recordUpdates><name>u</name><object>Policy__c</object><inputAssignments><field>Status__c</field></inputAssignments></recordUpdates></Flow>`,
  );
  w(
    "flows/Old_Check.flow",
    `<?xml version="1.0"?><Flow><processType>AutoLaunchedFlow</processType><status>Draft</status>` +
      `<recordLookups><name>l</name><object>Policy__c</object><queriedFields>Status__c</queriedFields></recordLookups></Flow>`,
  );
  w("classes/PolicyService.cls", "public class PolicyService { void x() { Policy__c p = [SELECT Status__c FROM Policy__c LIMIT 1]; } }");
  w("classes/PolicyService.cls-meta.xml", "<ApexClass/>");
  w("classes/PolicySearch.cls", "public class PolicySearch { void x(String q) { List<Policy__c> ps = [SELECT Id FROM Policy__c]; Database.query(q); } }");
  w("classes/PolicySearch.cls-meta.xml", "<ApexClass/>");
  w("classes/Factory.cls", "public class Factory { Object make(String n) { return Type.forName(n).newInstance(); } }");
  w("classes/Factory.cls-meta.xml", "<ApexClass/>");
  w("classes/NoteReader.cls", "public class NoteReader { void x() { Policy__c p = [SELECT Notes__c FROM Policy__c LIMIT 1]; Account a = [SELECT Industry FROM Account LIMIT 1]; } }");
  w("classes/NoteReader.cls-meta.xml", "<ApexClass/>");
  w("triggers/PolicyTrigger.trigger", "trigger PolicyTrigger on Policy__c (before update) { Util.go(); }");
  w("triggers/PolicyTrigger.trigger-meta.xml", "<ApexTrigger/>");
  w("classes/Util.cls", "public class Util { public static void go() { Boolean ok = Schema.sObjectType.Contact.fields.Name.getDescribe().isUpdateable(); } }");
  w("classes/Util.cls-meta.xml", "<ApexClass/>");
  w(
    "profiles/Admin.profile",
    `<?xml version="1.0"?><Profile><fieldPermissions><field>Policy__c.Status__c</field><readable>true</readable><editable>true</editable></fieldPermissions>` +
      `<classAccesses><apexClass>NoteReader</apexClass><enabled>true</enabled></classAccesses></Profile>`,
  );
  w(
    "permissionsets/Policy_Editor.permissionset",
    `<?xml version="1.0"?><PermissionSet><label>Policy editor</label><fieldPermissions><field>Policy__c.Status__c</field><readable>true</readable><editable>true</editable></fieldPermissions>` +
      `<objectPermissions><object>Policy__c</object><allowRead>true</allowRead><allowEdit>true</allowEdit></objectPermissions></PermissionSet>`,
  );
  return root;
}

async function connect() {
  const db = new Database(":memory:");
  const masker = new Masker({ vault: new Vault(db, newVaultKey()), model: fakeModel(["Karim"]) });
  const index = new MetadataIndex(db);
  const contexts = new ContextRepository(db);
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-agent-ws-"));
  dirs.push(workspace);
  const server = createServer({
    contexts,
    masker,
    approval: new ApprovalServer(),
    recognizer: async () => {
      throw new Error("no OCR here");
    },
    version: "1.0.0-next.0",
    metadata: { index, indexer: new BackgroundIndexer(index, { workspace }) },
  });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const info = await indexProject(index, project());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { ...r, text: r.content.map((c) => c.text ?? "").join("\n") };
  };
  return { call, contexts, source: info.source };
}

describe("dynamic Apex", () => {
  it("is flagged by what the index cannot follow, but not for inline queries", () => {
    expect(readApex("ApexClass", "A", "class A { void x(String q) { Database.query(q); Type.forName('X'); Schema.getGlobalDescribe(); } }", "a.cls").attrs.dynamic).toEqual([
      "query built from a string",
      "class named at run time",
      "describe calls",
    ]);
    expect(readApex("ApexClass", "B", "class B { void x() { Database.getQueryLocator( [SELECT Id FROM Account]); } }", "b.cls").attrs.dynamic).toBeUndefined();
    // Field and object checks on names the code spells out are not dynamic; cursors from strings are.
    expect(readApex("ApexClass", "C", "class C { Boolean x() { return Schema.sObjectType.Account.fields.Name.getDescribe().isAccessible(); } }", "c.cls").attrs.dynamic).toBeUndefined();
    expect(readApex("ApexClass", "D", "class D { void x(String q) { Database.getCursor(q); } }", "d.cls").attrs.dynamic).toEqual(["query built from a string"]);
  });
});

describe("metadata_impact", () => {
  it("lists what depends on a field and flags the weak links", async () => {
    const { call } = await connect();
    const r = await call("metadata_impact", { context: "acme", changes: [{ type: "CustomField", name: "Policy__c.Status__c" }] });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('## Change CustomField Policy__c.Status__c "Status for [PERSON_1]" [Picklist]');
    expect(r.text).toContain("- ValidationRule Policy__c.Status_Required (reads it)");
    expect(r.text).toContain('- CustomField Policy__c.Status_Text__c "Status text" [Text] (reads it)');
    expect(r.text).toContain("- ApexClass PolicyService (reads it)");
    expect(r.text).toContain("- Flow Close_Policy (writes it)");
    expect(r.text).toContain("- Flow Old_Check (reads it) [inactive: Draft]");
    expect(r.text).toContain("Access to it is given by 1 PermissionSet, 1 Profile");
    expect(r.text).toContain("1 inactive flow(s) depend on it");
    expect(r.text).toMatch(/component\(s\) save Policy__c records[^\n]*Flow Close_Policy/);
    expect(r.text).toContain("Apex that works on Policy__c also does what the index cannot follow, so it may use this unseen: ApexClass PolicySearch (query built from a string).");
    expect(r.text).toContain("1 other Apex class(es) or trigger(s) in the source");
    expect(r.text).toContain("no confirmed scope in this source");
    expect(r.text).not.toContain("Karim");
  });

  it("warns about saves a new rule can stop, deletes that break things, and what lies outside the scope", async () => {
    const { call, contexts, source } = await connect();
    contexts.updateSettings("acme", { scope: { source, objects: ["Claim__c"], confirmedAt: "2026-11-07T00:00:00.000Z" } });
    const r = await call("metadata_impact", {
      context: "acme",
      changes: [
        { type: "ValidationRule", name: "Policy__c.Closed_Needs_Reason", change: "add" },
        { type: "CustomField", name: "Policy__c.Status__c", change: "delete" },
        { type: "CustomField", name: "Policy__c.Statu__c" },
      ],
    });
    expect(r.text).toContain("## Add ValidationRule Policy__c.Closed_Needs_Reason");
    expect(r.text).toMatch(/## Add ValidationRule[^#]*component\(s\) save Policy__c records/);
    expect(r.text).toMatch(/## Delete CustomField[^#]*Deleting it breaks or changes \d+ component\(s\)/);
    expect(r.text).toMatch(/## Delete CustomField[^#]*dependent\(s\) are outside the scope the user confirmed/);
    expect(r.text).toContain("- ApexClass PolicyService (reads it) [outside the scope]");
    expect(r.text).toContain("## Change CustomField Policy__c.Statu__c\nNot in the index. Close matches:\n- CustomField Policy__c.Status__c");
    expect(r.text).toMatch(/## Delete CustomField[^#]*It is outside the scope the user confirmed\./);
  });

  it("counts only direct grants, lists only what depends on an object, prints shared facts once, and keeps typed names masked", async () => {
    const { call } = await connect();
    // The label "Status for Karim" gives Karim a pseudonym, which the model then uses in a new name.
    expect((await call("metadata_search", { context: "acme", query: "Status__c" })).text).toContain("[PERSON_1]");
    const r = await call("metadata_impact", {
      context: "acme",
      changes: [
        { type: "CustomField", name: "Policy__c.Notes__c" },
        { type: "CustomObject", name: "Policy__c" },
        { type: "CustomField", name: "[PERSON_1]__c.Foo__c", change: "add" },
      ],
    });
    const [, notes, object, added] = r.text.split(/^## /m);
    // NoteReader reads Notes__c and the profile grants NoteReader: that is not access to the field.
    expect(notes).toContain("No permission set or profile in the index gives access to it.");
    expect(notes).not.toContain("Access to it is given by");
    // The trigger runs on Policy__c; what the trigger calls (Util) does not depend on the object.
    expect(object).toContain("- ApexTrigger PolicyTrigger (runs on its records)");
    expect(object).not.toContain("ApexClass Util");
    expect(object).toContain("It holds 3 field(s), 1 validation rule(s), 0 record type(s)");
    expect(object).toContain("Access to it is given by 1 PermissionSet, 1 Profile");
    // Util's describe is a field check, not dynamic code.
    expect(r.text).not.toContain("ApexClass Util (");
    expect(object).toContain("The Apex the index cannot follow (listed above for Policy__c) may use it unseen.");
    expect(added).toContain("Add CustomField [PERSON_1]__c.Foo__c");
    expect(r.text).not.toContain("Karim");
  });

  it("knows a referenced-only field of a scope object is in the scope, and what a permission set gives", async () => {
    const { call, contexts, source } = await connect();
    contexts.updateSettings("acme", { scope: { source, objects: ["Account"], confirmedAt: "2026-11-07T00:00:00.000Z" } });
    const r = await call("metadata_impact", {
      context: "acme",
      changes: [
        { type: "CustomField", name: "Account.Industry" },
        { type: "PermissionSet", name: "Policy_Editor" },
      ],
    });
    const [, industry, ps] = r.text.split(/^## /m);
    expect(industry).toContain("It is only referenced");
    expect(industry).not.toContain("It is outside the scope");
    expect(industry).toContain("- ApexClass NoteReader (reads it)");
    expect(ps).toContain("It gives access to 1 CustomField, 1 CustomObject: whoever has it gains or loses that.");
    expect(ps).not.toContain("Apex class(es)");
  });
});
