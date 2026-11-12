import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BackgroundIndexer, indexProject } from "@sf-agent-po/connectors";
import { ContextRepository, Database, Masker, MAX_APEX_LENGTH, MetadataIndex, newVaultKey, Vault, type EntityDetector, type Span } from "@sf-agent-po/core";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, createServer } from "../src/index.js";
import { trimDetails } from "../src/metadata-tools.js";

const fakeModel =
  (names: readonly string[]): EntityDetector =>
  async (text) => {
    const spans: Span[] = [];
    for (const name of names) for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) spans.push({ start: i, end: i + name.length, type: "PER", source: "ner" });
    return spans;
  };

const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A small project: an object with a field, a flow that runs on it, a class, a report named after a person. */
function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "sf-agent-meta-"));
  dirs.push(root);
  const w = (rel: string, c: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), c);
  };
  w(
    "objects/Policy__c.object",
    `<?xml version="1.0"?><CustomObject><label>Policy</label><description>Owned by Karim Benali</description>` +
      `<fields><fullName>Status__c</fullName><label>Status for Karim</label><type>Picklist</type></fields>` +
      `<fields><fullName>Premium__c</fullName><label>Premium</label><type>Currency</type></fields></CustomObject>`,
  );
  w("reports/Karim_Folder/Karim_Accounts.report", `<?xml version="1.0"?><Report><name>Accounts</name></Report>`);
  w(
    "flows/Policy_Update.flow",
    `<?xml version="1.0"?><Flow><processType>AutoLaunchedFlow</processType><start><object>Policy__c</object><triggerType>RecordAfterSave</triggerType><recordTriggerType>Update</recordTriggerType></start>` +
      `<recordUpdates><name>u</name><object>Policy__c</object><inputAssignments><field>Status__c</field></inputAssignments></recordUpdates></Flow>`,
  );
  w("classes/PolicyService.cls", "public class PolicyService { void x() { Policy__c p = [SELECT Premium__c FROM Policy__c LIMIT 1]; } }");
  w("classes/PolicyService.cls-meta.xml", "<ApexClass/>");
  const perms = Array.from({ length: 500 }, (_, i) => `<fieldPermissions><field>Claim__c.F${i}__c</field><readable>true</readable><editable>false</editable></fieldPermissions>`).join("");
  w("profiles/Admin.profile", `<?xml version="1.0"?><Profile><custom>false</custom>${perms}</Profile>`);
  return root;
}

async function connect(sf?: (args: string[]) => Promise<unknown>) {
  const db = new Database(":memory:");
  const vault = new Vault(db, newVaultKey());
  const masker = new Masker({ vault, model: fakeModel(["Karim Benali", "Karim"]) });
  const index = new MetadataIndex(db);
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-agent-ws-"));
  dirs.push(workspace);
  const indexer = new BackgroundIndexer(index, { workspace, ...(sf ? { sf } : {}) });
  const approval = new ApprovalServer();
  const server = createServer({
    contexts: new ContextRepository(db),
    masker,
    approval,
    recognizer: async () => {
      throw new Error("no OCR here");
    },
    version: "1.0.0-next.0",
    metadata: { index, indexer },
  });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(async () => {
    await indexer.settle();
    await client.close();
    await approval.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { ...r, text: r.content.map((c) => c.text ?? "").join("\n") };
  };
  return { call, index, indexer, client, db };
}

describe("metadata tools", () => {
  it("are offered only with an index", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["metadata_index", "metadata_sources", "metadata_summary", "metadata_search", "metadata_component"]));
  });

  it("say what to do when nothing is indexed", async () => {
    const { call } = await connect();
    expect((await call("metadata_sources")).text).toContain("Nothing is indexed yet");
    const r = await call("metadata_summary");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("metadata_index");
  });

  it("index a project in the background and list it", async () => {
    const { call, indexer } = await connect();
    const root = project();
    expect((await call("metadata_index", { org: "a", project: root })).isError).toBe(true);
    const bad = await call("metadata_index", { repo: "git:ext::sh -c id" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("not a clone URL");
    const started = await call("metadata_index", { project: root });
    expect(started.text).toMatch(/Indexing repo:sf-agent-meta-\w+#[0-9a-f]{8} in the background/);
    // The path, which can hold the user's name, is never shown.
    expect(started.text).not.toContain(root);
    await indexer.settle();
    const sources = await call("metadata_sources");
    expect(sources.text).toMatch(/Indexed:\n- repo:sf-agent-meta-\w+#[0-9a-f]{8} \(repo, \d+ components/);
    expect(sources.text).toMatch(/: ready, finished/);
    expect(sources.text).not.toContain(root);
  });

  it("summarize, search and open components, with free text and report names masked", async () => {
    const { call, index } = await connect();
    await indexProject(index, project());

    const summary = await call("metadata_summary", { context: "acme" });
    expect(summary.text).toContain("- CustomField: 2");
    expect(summary.text).toContain('- Policy__c "Policy": 2 fields, 0 validation rules, 1 flows run on its records, 0 Apex triggers');

    const search = await call("metadata_search", { context: "acme", query: "Status" });
    expect(search.text).toContain('- CustomField Policy__c.Status__c "Status for [PERSON_1]" [Picklist]');
    expect(search.text).not.toContain("Karim");

    const reports = await call("metadata_search", { context: "acme", query: "Accounts", types: ["Report"] });
    expect(reports.text).toContain("Report ");
    expect(reports.text).not.toContain("Karim");

    const object = await call("metadata_component", { context: "acme", type: "CustomObject", name: "policy__c" });
    expect(object.isError).toBeFalsy();
    expect(object.text).toContain("Owned by [PERSON_2]");
    expect(object.text).not.toContain("Karim");
    expect(object.text).toContain("Children (2):");
    expect(object.text).toContain("is written by, has automation: Flow Policy_Update");
    expect(object.text).toContain("is read by: ApexClass PolicyService");

    const field = await call("metadata_component", { context: "acme", type: "CustomField", name: "Policy__c.Premium__c" });
    expect(field.text).toContain("is read by: ApexClass PolicyService");
    expect(field.text).toContain("is part of: CustomObject Policy__c");

    const missing = await call("metadata_component", { context: "acme", type: "CustomField", name: "Policy__c.Statu__c" });
    expect(missing.text).toContain("No CustomField named Policy__c.Statu__c");
  });

  it("open a report by the masked name they listed it under", async () => {
    const { call, index } = await connect();
    await indexProject(index, project());
    const reports = await call("metadata_search", { context: "acme", query: "Accounts", types: ["Report"] });
    const name = /- Report (\S+)/.exec(reports.text)?.[1];
    expect(name).toMatch(/\[PERSON_\d+\]/);
    const opened = await call("metadata_component", { context: "acme", type: "Report", name: name! });
    expect(opened.isError).toBeFalsy();
    expect(opened.text).toContain(`- Report ${name}`);
    expect(opened.text).not.toContain("Karim");
    // A search with the pseudonym finds it too.
    expect((await call("metadata_search", { context: "acme", query: name!.split("/")[0]!, types: ["Report"] })).text).toContain("1 match");
  });

  it("cut long details, such as a profile's field permissions", async () => {
    const { call, index } = await connect();
    await indexProject(index, project());
    const profile = await call("metadata_component", { context: "acme", type: "Profile", name: "Admin" });
    expect(profile.text).toContain("460 more entries");
    expect(profile.text.length).toBeLessThan(20_000);
    expect(trimDetails({ a: Array.from({ length: 45 }, (_, i) => i) })).toEqual({ a: [...Array.from({ length: 40 }, (_, i) => i), "and 5 more"] });
  });

  it("show Apex code by range and by search, masked", async () => {
    const { call, index } = await connect();
    const root = project();
    const lines = ["public class Mapper {", "  // Written for Karim Benali", "  public List<SObject> load(String f) {", "    return Database.query('SELECT ' + f + ' FROM Policy__c');", "  }", ...Array.from({ length: 300 }, (_, i) => `  // line ${i}`), "}"];
    writeFileSync(path.join(root, "classes/Mapper.cls"), lines.join("\r\n"));
    await indexProject(index, root);

    const card = await call("metadata_component", { context: "acme", type: "ApexClass", name: "Mapper" });
    expect(card.text).toContain(`Its code (${lines.length} lines) can be read with metadata_code, which shows what the links above cannot`);
    expect((await call("metadata_component", { context: "acme", type: "ApexClass", name: "PolicyService" })).text).not.toContain("which shows what");

    const first = await call("metadata_code", { context: "acme", type: "ApexClass", name: "Mapper" });
    expect(first.text).toContain(`ApexClass Mapper, lines 1-200 of ${lines.length}`);
    expect(first.text).toContain("More from line 201.");
    expect(first.text).toContain("  4      return Database.query('SELECT ' + f + ' FROM Policy__c');");
    expect(first.text).toContain("// Written for [PERSON_");
    expect(first.text).not.toContain("Karim");
    expect(first.text).not.toContain("\r");

    const end = await call("metadata_code", { context: "acme", type: "ApexClass", name: "Mapper", from: 300, lines: 50 });
    expect(end.text).toContain(`lines 300-${lines.length} of ${lines.length}`);
    expect(end.text).not.toContain("More from");
    expect((await call("metadata_code", { context: "acme", type: "ApexClass", name: "Mapper", from: 999 })).text).toContain(`Mapper has ${lines.length} lines.`);

    const found = await call("metadata_code", { context: "acme", type: "ApexClass", name: "Mapper", find: "database.QUERY" });
    expect(found.text).toContain('ApexClass Mapper: 1 line(s) contain "database.QUERY"');
    expect(found.text).toContain("Database.query(");
    // A pseudonym the model was shown finds the real text, and comes back masked.
    const pseudonym = /\[PERSON_\d+\]/.exec(first.text)![0];
    const byName = await call("metadata_code", { context: "acme", type: "ApexClass", name: "Mapper", find: pseudonym });
    expect(byName.text).toContain(`  2    // Written for ${pseudonym}`);
    expect(byName.text).not.toContain("Karim");
    // A real name the model guesses is not confirmed by the lines that hold it.
    expect((await call("metadata_code", { context: "acme", type: "ApexClass", name: "Mapper", find: "Benali" })).text).toContain('No line of Mapper contains "Benali"');
    const many = await call("metadata_code", { context: "acme", type: "ApexClass", name: "Mapper", find: "// line" });
    expect(many.text).toContain("200 line(s) contain");
    expect(many.text).toContain("the first 60 shown");
    expect(many.text).toContain("More may follow: search again from line 206.");
    const later = await call("metadata_code", { context: "acme", type: "ApexClass", name: "Mapper", find: "// line", from: 206 });
    expect(later.text).toContain("100 line(s) from line 206 contain");
    expect(later.text).toContain("206    // line 200");
    expect(later.text).not.toContain("More may follow");
    expect((await call("metadata_code", { context: "acme", type: "ApexClass", name: "Mapper", find: "nowhere" })).text).toContain('No line of Mapper contains "nowhere"');

    expect((await call("metadata_code", { context: "acme", type: "ApexTrigger", name: "Mapper" })).text).toContain("No ApexTrigger named Mapper");
    expect((await call("metadata_code", { context: "acme", type: "ApexClass", name: "Mapper", lines: 501 })).isError).toBe(true);
  });

  it("show a flow's logic, masked", async () => {
    const { call, index } = await connect();
    const root = project();
    writeFileSync(
      path.join(root, "flows/Lapse.flow"),
      `<?xml version="1.0"?><Flow><label>Lapse</label><processType>AutoLaunchedFlow</processType><start><object>Policy__c</object><triggerType>RecordAfterSave</triggerType><recordTriggerType>Update</recordTriggerType><connector><targetReference>Is_Lapsed</targetReference></connector></start>` +
        `<decisions><name>Is_Lapsed</name><rules><name>Yes</name><conditionLogic>and</conditionLogic><conditions><leftValueReference>$Record.Status__c</leftValueReference><operator>EqualTo</operator><rightValue><stringValue>Lapsed by Karim Benali</stringValue></rightValue></conditions><connector><targetReference>Close</targetReference></connector></rules></decisions>` +
        `<recordUpdates><name>Close</name><inputReference>$Record</inputReference><inputAssignments><field>Premium__c</field><value><numberValue>0</numberValue></value></inputAssignments></recordUpdates></Flow>`,
    );
    await indexProject(index, root);
    const card = await call("metadata_component", { context: "acme", type: "Flow", name: "Lapse" });
    expect(card.text).toMatch(/Its logic \(\d+ lines\) can be read with metadata_code: the conditions of its decisions/);
    const logic = await call("metadata_code", { context: "acme", type: "Flow", name: "Lapse" });
    expect(logic.text).toMatch(/^Flow Lapse, lines 1-\d+ of \d+/);
    expect(logic.text).toContain("START after save on Policy__c, when a record is updated");
    expect(logic.text).toMatch(/outcome Yes when:\n +\d+ +\{!\$Record\.Status__c\} EqualTo 'Lapsed by \[PERSON_\d+\]'/);
    expect(logic.text).toContain("Premium__c = 0");
    expect(logic.text).not.toContain("Karim");
    expect((await call("metadata_code", { context: "acme", type: "Flow", name: "Lapse", find: "premium" })).text).toContain('Flow Lapse: 1 line(s) contain "premium"');
  });

  it("show who records are shared with, masked", async () => {
    const { call, index } = await connect();
    const root = project();
    const w = (rel: string, c: string) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), c);
    };
    w(
      "sharingRules/Policy__c.sharingRules",
      `<?xml version="1.0"?><SharingRules><sharingCriteriaRules><fullName>Lapsed_To_Care</fullName><accessLevel>Edit</accessLevel><label>Lapsed</label><sharedTo><group>Care_EU</group></sharedTo>` +
        `<criteriaItems><field>Status__c</field><operation>equals</operation><value>Lapsed by Karim Benali</value></criteriaItems></sharingCriteriaRules></SharingRules>`,
    );
    w("groups/Care_EU.group", "<Group><name>Care EU</name></Group>");
    w("roles/CEO.role", "<Role><name>CEO</name></Role>");
    w("roles/Care_Manager.role", "<Role><name>Care manager</name><parentRole>CEO</parentRole></Role>");
    await indexProject(index, root);
    const object = await call("metadata_component", { context: "acme", type: "CustomObject", name: "Policy__c" });
    // Its sharing rules are one of its parts.
    expect(object.text).toMatch(/Children \(\d+\):[\s\S]*- SharingRules Policy__c/);
    const rules = await call("metadata_component", { context: "acme", type: "SharingRules", name: "Policy__c" });
    expect(rules.text).toContain("share records of: CustomObject Policy__c");
    expect(rules.text).toContain("references: Group Care_EU");
    expect(rules.text).toContain("can be read in full with metadata_code");
    expect(rules.text).not.toContain("Karim");
    const full = await call("metadata_code", { context: "acme", type: "SharingRules", name: "Policy__c" });
    expect(full.text).toMatch(/CRITERIA RULE Lapsed_To_Care "Lapsed"\n *\d+ +records where Status__c equals 'Lapsed by \[PERSON_\d+\]'\n *\d+ +shared with group Care_EU: Edit/);
    expect(full.text).not.toContain("Karim");
    const role = await call("metadata_component", { context: "acme", type: "Role", name: "Care_Manager" });
    expect(role.text).toContain("references: Role CEO");
    // Deleting a field a sharing rule tests is refused by Salesforce.
    const impact = await call("metadata_impact", { context: "acme", changes: [{ change: "delete", type: "CustomField", name: "Policy__c.Status__c" }] });
    expect(impact.text).toContain("SharingRules Policy__c");
    expect(impact.text).toContain("Salesforce refuses the delete");
    // The object's own sharing rules go with it: they do not stop its delete.
    const object_ = await call("metadata_impact", { context: "acme", changes: [{ change: "delete", type: "CustomObject", name: "Policy__c" }] });
    expect(object_.text).not.toMatch(/SharingRules Policy__c.*\(reads it/);
    const rulesChange = await call("metadata_impact", { context: "acme", changes: [{ change: "modify", type: "SharingRules", name: "Policy__c" }] });
    expect(rulesChange.text).toContain("It decides who sees records of Policy__c beyond their owner, through Group Care_EU");
    const group = await call("metadata_impact", { context: "acme", changes: [{ change: "delete", type: "Group", name: "Care_EU" }] });
    expect(group.text).toContain("Its members see records through it: 1 object(s) share records with it");
    expect(group.text).toContain("check in Setup whether Salesforce refuses the delete or removes them");
    expect(group.text).not.toContain("Salesforce refuses the delete while");
  });

  it("say why there is no flow logic to show", async () => {
    const { call, index, db } = await connect();
    await indexProject(index, project());
    db.db.prepare("DELETE FROM component_body").run();
    // A flow an earlier version indexed has its details, but no logic.
    const old = await call("metadata_code", { context: "acme", type: "Flow", name: "Policy_Update" });
    expect(old.text).toContain("has no logic for Policy_Update: it was built by an earlier version");
    // A flow file the scan could not read has no details at all: indexing again would not help.
    db.db.prepare("UPDATE component SET attrs = '{}' WHERE name = 'Policy_Update'").run();
    expect((await call("metadata_code", { context: "acme", type: "Flow", name: "Policy_Update" })).text).toContain("could not be read when");
  });

  it("show code with its secrets hidden, and long lines cut", async () => {
    const { call, index } = await connect();
    const root = project();
    const fixture = `'${"{\"a\":1}".repeat(1_000)}'`;
    writeFileSync(
      path.join(root, "classes/Client.cls"),
      ["public class Client {", "  String apiKey = 'k_9f8e7d6c';", "  // req.setHeader('Authorization', 'Bearer abcDEF123456');", ...Array.from({ length: 100 }, () => `  String json = ${fixture};`), "}"].join("\n"),
    );
    await indexProject(index, root);
    const r = await call("metadata_code", { context: "acme", type: "ApexClass", name: "Client" });
    expect(r.text).toContain("String apiKey = 'HIDDEN_SECRET';");
    expect(r.text).toContain("'Bearer HIDDEN_SECRET'");
    expect(r.text).not.toContain("k_9f8e7d6c");
    expect(r.text).not.toContain("abcDEF123456");
    expect(r.text).toMatch(/\.\.\. \(\d+ more characters\)/);
    expect(r.text.length).toBeLessThan(40_000);
    expect(r.text).toMatch(/lines 1-\d+ of 104, .* More from line \d+\./);
  });

  it("show what a query built in strings may read", async () => {
    const { call, index } = await connect();
    const root = project();
    writeFileSync(path.join(root, "objects/Lead.object"), `<?xml version="1.0"?><CustomObject><fields><fullName>Rating</fullName><type>Picklist</type></fields></CustomObject>`);
    writeFileSync(path.join(root, "classes/Finder.cls"), "public class Finder { static final String OBJ = 'Lead'; List<SObject> f() { return Database.query('SELECT Rating FROM ' + OBJ); } }");
    await indexProject(index, root);
    const field = await call("metadata_component", { context: "acme", type: "CustomField", name: "Lead.Rating" });
    expect(field.text).toContain("may be read by (a query built in strings): ApexClass Finder");
    const impact = await call("metadata_impact", { context: "acme", changes: [{ change: "delete", type: "CustomField", name: "Lead.Rating" }] });
    expect(impact.text).toContain("ApexClass Finder (may read it: a query built in strings)");
    // A query built in strings does not stop the delete: the class fails when it runs.
    expect(impact.text).toContain("1 class(es) may read it in a query built in strings: Salesforce does not stop the delete");
    expect(impact.text).not.toContain("Salesforce refuses the delete");
  });

  it("show the fields a mapping in custom metadata names, with record names masked", async () => {
    const { call, index } = await connect();
    const root = project();
    const w = (rel: string, c: string) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), c);
    };
    w("objects/Map__mdt.object", `<?xml version="1.0"?><CustomObject><label>Map</label></CustomObject>`);
    w("customMetadata/Map.Karim_Benali.md", `<?xml version="1.0"?><CustomMetadata><label>Karim</label><values><field>Field__c</field><value>Policy__c.Premium__c</value></values></CustomMetadata>`);
    w("classes/Mapper.cls", "public class Mapper { void m() { List<Map__mdt> all = Map__mdt.getAll().values(); } }");
    await indexProject(index, root);
    const field = await call("metadata_component", { context: "acme", type: "CustomField", name: "Policy__c.Premium__c" });
    expect(field.text).toContain("is named in the records of: CustomObject Map__mdt");
    const type = await call("metadata_component", { context: "acme", type: "CustomObject", name: "Map__mdt" });
    expect(type.text).toContain("its records name: CustomField Policy__c.Premium__c");
    expect(type.text).toContain("is read by: ApexClass Mapper");
    expect(type.text).not.toContain("Karim");
    // Two links away, the link from the type is said plainly.
    const mapper = await call("metadata_component", { context: "acme", type: "ApexClass", name: "Mapper", depth: 2 });
    expect(mapper.text).toContain("may read (2 links away): CustomField Policy__c.Premium__c");
    const impact = await call("metadata_impact", { context: "acme", changes: [{ change: "delete", type: "CustomField", name: "Policy__c.Premium__c" }] });
    expect(impact.text).toContain("CustomObject Map__mdt \"Map\" (its records name it: code that reads them may use it)");
    expect(impact.text).toContain("1 custom metadata type(s) name it in their records");
    expect(impact.text).not.toContain("Karim");
  });

  it("say why there is no code to show", async () => {
    const { call, index, db } = await connect();
    const root = project();
    writeFileSync(path.join(root, "classes/Big.cls"), "x".repeat(MAX_APEX_LENGTH + 1));
    await indexProject(index, root);
    expect((await call("metadata_code", { context: "acme", type: "ApexClass", name: "Big" })).text).toContain("too large for the index to keep its code");
    // An index built before the code was kept.
    const snap = index.latest(index.snapshots()[0]!.source)!;
    db.db.prepare("DELETE FROM component_body").run();
    const old = await call("metadata_code", { context: "acme", type: "ApexClass", name: "PolicyService" });
    expect(old.text).toContain(`The index of ${snap.source} has no code for PolicyService`);
    expect(old.text).toContain("Index the source again");
    // A file the scan could not read has no lines either: indexing again would not help.
    db.db.prepare("UPDATE component SET attrs = '{}' WHERE name = 'PolicyService'").run();
    expect((await call("metadata_code", { context: "acme", type: "ApexClass", name: "PolicyService" })).text).toContain("could not be read when");
  });

  it("mask the error of a failed run", async () => {
    const { call, indexer } = await connect(async (args) => {
      if (args[1] === "display") return { id: "00D000000000001AAA", alias: "uat" };
      throw new Error("Entity of type 'Report' named 'Karim_Folder/Karim_Accounts' cannot be found");
    });
    await call("metadata_index", { org: "uat" });
    await indexer.settle();
    const sources = await call("metadata_sources");
    expect(sources.text).toContain("failed");
    expect(sources.text).toContain("[PERSON_");
    expect(sources.text).not.toContain("Karim");
  });

  it("refuse a source that is not indexed", async () => {
    const { call, index } = await connect();
    await indexProject(index, project());
    const r = await call("metadata_summary", { source: "org:nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Indexed: repo:");
  });
});
