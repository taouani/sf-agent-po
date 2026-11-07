import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BackgroundIndexer, indexProject } from "@sf-agent-po/connectors";
import { ContextRepository, Database, Masker, MetadataIndex, newVaultKey, Vault, type EntityDetector, type Span } from "@sf-agent-po/core";
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
  return { call, index, indexer, client };
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
