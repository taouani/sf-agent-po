import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BackgroundIndexer, indexProject } from "@sf-agent-po/connectors";
import { ContextRepository, Database, Masker, MetadataIndex, newVaultKey, Vault, type EntityDetector, type Span } from "@sf-agent-po/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalRequest, Decision, ScopeRequest } from "../src/approval/server.js";
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

/**
 * Policy__c with a field, a rule and a flow that creates Claim__c records; Claim__c points to
 * Policy__c; a trigger on Policy__c calls a class that calls another; Invoice__c stands apart.
 */
function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "sf-agent-scope-"));
  dirs.push(root);
  const w = (rel: string, c: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), c);
  };
  w(
    "objects/Policy__c.object",
    `<?xml version="1.0"?><CustomObject><label>Policy of Karim</label>` +
      `<fields><fullName>Status__c</fullName><label>Status</label><type>Picklist</type></fields>` +
      `<validationRules><fullName>Status_Required</fullName><active>true</active><errorConditionFormula>ISBLANK(TEXT(Status__c))</errorConditionFormula></validationRules></CustomObject>`,
  );
  w(
    "objects/Claim__c.object",
    `<?xml version="1.0"?><CustomObject><label>Claim</label><fields><fullName>Policy__c</fullName><label>Policy</label><type>Lookup</type><referenceTo>Policy__c</referenceTo></fields></CustomObject>`,
  );
  w("objects/Invoice__c.object", `<?xml version="1.0"?><CustomObject><label>Invoice</label></CustomObject>`);
  w(
    "flows/Open_Claim.flow",
    `<?xml version="1.0"?><Flow><processType>AutoLaunchedFlow</processType><status>Active</status><start><object>Policy__c</object><triggerType>RecordAfterSave</triggerType><recordTriggerType>Update</recordTriggerType></start>` +
      `<recordCreates><name>c</name><object>Claim__c</object></recordCreates></Flow>`,
  );
  w("triggers/PolicyTrigger.trigger", "trigger PolicyTrigger on Policy__c (after update) { PolicyService.run(Trigger.new); }");
  w("triggers/PolicyTrigger.trigger-meta.xml", "<ApexTrigger/>");
  w("classes/PolicyService.cls", "public class PolicyService { public static void run(List<Policy__c> ps) { Helper.go(); } }");
  w("classes/PolicyService.cls-meta.xml", "<ApexClass/>");
  w("classes/Helper.cls", "public class Helper { public static void go() { } }");
  w("classes/Helper.cls-meta.xml", "<ApexClass/>");
  w("profiles/Admin.profile", `<?xml version="1.0"?><Profile><objectPermissions><object>Policy__c</object><allowRead>true</allowRead></objectPermissions></Profile>`);
  return root;
}

async function connect(decide: (req: ScopeRequest) => Partial<Decision>) {
  const db = new Database(":memory:");
  const vault = new Vault(db, newVaultKey());
  const masker = new Masker({ vault, model: fakeModel(["Karim"]) });
  const index = new MetadataIndex(db);
  const contexts = new ContextRepository(db);
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-agent-ws-"));
  dirs.push(workspace);
  const seen: ApprovalRequest[] = [];
  const server = createServer({
    contexts,
    masker,
    approval: new ApprovalServer(),
    recognizer: async () => {
      throw new Error("no OCR here");
    },
    version: "1.0.0-next.0",
    metadata: { index, indexer: new BackgroundIndexer(index, { workspace }) },
    reviewer: () => ({
      review: async (req) => {
        seen.push(req);
        return { status: "approved", missed: [], digest: "d", ...decide(req as ScopeRequest) };
      },
    }),
  });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  await indexProject(index, project());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { ...r, text: r.content.map((c) => c.text ?? "").join("\n") };
  };
  return { call, seen, contexts, index };
}

describe("scope tools", () => {
  it("compute what comes with an object, two hops away, and its neighbours", async () => {
    const { index } = await connect(() => ({}));
    const snap = index.snapshots()[0]!;
    const scope = index.scope(snap.id, ["policy__c", "Nope__c"], { hops: 2 });
    expect(scope.objects.map((o) => o.name)).toEqual(["Policy__c"]);
    expect(scope.unknown).toEqual(["Nope__c"]);
    expect(scope.children.map((c) => c.name)).toEqual(["Policy__c.Status__c", "Policy__c.Status_Required"]);
    const members = Object.fromEntries(scope.members.map((m) => [`${m.component.type} ${m.component.name}`, m.hop]));
    // The trigger calls PolicyService (two hops); what PolicyService calls would be a third.
    expect(members).toEqual({ "Flow Open_Claim": 1, "ApexTrigger PolicyTrigger": 1, "CustomField Claim__c.Policy__c": 1, "ApexClass PolicyService": 2 });
    expect(Object.keys(members)).not.toContain("Profile Admin");
    expect(scope.grantedBy).toEqual({ Profile: 1 });
    expect(scope.neighbours.map((n) => n.object.name)).toEqual(["Claim__c"]);
    expect(scope.neighbours[0]!.via.map((v) => v.component.name).sort()).toEqual(["Claim__c.Policy__c", "Open_Claim"]);
    // One hop leaves out what the code calls.
    expect(index.scope(snap.id, ["Policy__c"], { hops: 1 }).members.map((m) => m.component.name)).not.toContain("PolicyService");
  });

  it("ask the user, keep what they confirmed, and show it masked", async () => {
    const { call, seen, contexts } = await connect((req) => ({ selected: req.proposed.map((p) => p.name), added: ["Invoice__c", "Ghost__c"], comment: "Karim owns it" }));
    expect((await call("scope_show", { context: "acme" })).text).toContain("No scope is confirmed");

    const r = await call("scope_propose", { context: "acme", objects: ["Policy__c"], reason: "Claims open on update" });
    expect(r.isError).toBeFalsy();
    const page = seen[0] as ScopeRequest;
    expect(page).toMatchObject({ kind: "scope", title: "acme", reason: "Claims open on update" });
    // The page is the user's own: labels in clear, with what comes with each object.
    expect(page.proposed).toEqual([{ name: "Policy__c", label: "Policy of Karim", detail: "1 field, 1 validation rule, 1 flow, 1 Apex trigger; 1 field(s) of other objects use it" }]);
    expect(page.suggested[0]).toMatchObject({ name: "Claim__c", label: "Claim", detail: expect.stringContaining("Flow Open_Claim (writes)") });

    expect(r.text).toContain('The user confirmed the scope of "acme". The user added: Invoice__c, Ghost__c.');
    expect(r.text).toContain("The user's comment: [PERSON_1] owns it");
    expect(r.text).toContain('- CustomObject Policy__c "Policy of [PERSON_1]"');
    expect(r.text).toContain("- CustomObject Invoice__c");
    expect(r.text).toContain("Called by or calling that automation (1):\n- ApexClass PolicyService (calls or is called by)");
    expect(r.text).toContain("Access is given by 1 Profile");
    expect(r.text).toMatch(/Objects outside the scope that it touches \(1\)[^\n]*\n- CustomObject Claim__c "Claim": 2 link\(s\)/);
    expect(r.text).not.toContain("Karim");
    expect(contexts.get("acme")?.settings.scope).toMatchObject({ objects: ["Policy__c", "Invoice__c"], source: expect.stringMatching(/^repo:/) });

    const shown = await call("scope_show", { context: "acme" });
    expect(shown.text).toContain('Scope of "acme", confirmed by the user');
    expect(shown.text).toContain("- CustomObject Invoice__c");
    expect(shown.text).not.toContain("Karim");
  });

  it("keep the previous scope when the user rejects or unticks everything, and refuse unknown objects", async () => {
    let answer: Partial<Decision> = { selected: ["Policy__c"] };
    const { call, contexts } = await connect(() => answer);
    await call("scope_propose", { context: "acme", objects: ["Policy__c"] });
    answer = { status: "rejected" };
    expect((await call("scope_propose", { context: "acme", objects: ["Claim__c"] })).text).toContain("The user rejected this scope; the context keeps its previous scope.");
    answer = { selected: [] };
    expect((await call("scope_propose", { context: "acme", objects: ["Claim__c"] })).text).toContain("The user unticked every object");
    expect(contexts.get("acme")?.settings.scope).toMatchObject({ objects: ["Policy__c"] });

    const unknown = await call("scope_propose", { context: "acme", objects: ["Polic__c"] });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("None of these objects is in repo:");
  });
});
