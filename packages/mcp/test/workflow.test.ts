import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { BackgroundIndexer, indexProject } from "@sf-agent-po/connectors";
import {
  ContextRepository,
  Database,
  Masker,
  MetadataIndex,
  newVaultKey,
  RequirementRepository,
  Vault,
  WorkflowRepository,
  WorkflowRunChangedError,
  type EntityDetector,
  type Span,
} from "@sf-agent-po/core";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, createServer, requestDigest, submitStep, type ApprovalRequest, type Decision, type RequirementsRequest } from "../src/index.js";

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

type Decide = (req: ApprovalRequest) => Partial<Decision>;

interface Store {
  db: Database;
  masker: Masker;
  contexts: ContextRepository;
  requirements: RequirementRepository;
  runs: WorkflowRepository;
  index: MetadataIndex;
}

function store(): Store {
  const db = new Database(":memory:");
  return {
    db,
    masker: new Masker({ vault: new Vault(db, newVaultKey()), model: fakeModel(["Karim Haddad"]) }),
    contexts: new ContextRepository(db),
    requirements: new RequirementRepository(db),
    runs: new WorkflowRepository(db),
    index: new MetadataIndex(db),
  };
}

/** A project with one object, Policy__c. */
function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "sf-agent-wfp-"));
  dirs.push(root);
  mkdirSync(path.join(root, "objects"));
  writeFileSync(path.join(root, "objects/Policy__c.object"), `<?xml version="1.0"?><CustomObject><label>Policy</label><fields><fullName>Status__c</fullName><label>Status</label><type>Text</type></fields></CustomObject>`);
  return root;
}

async function connect({ metadata = false, shared }: { metadata?: boolean; shared?: Store } = {}) {
  const st = shared ?? store();
  const { masker, contexts, requirements, runs, index } = st;
  const seen: ApprovalRequest[] = [];
  // Approves with every item kept unless a test says otherwise.
  let decide: Decide = () => ({});
  const workspace = mkdtempSync(path.join(tmpdir(), "sf-agent-wf-"));
  dirs.push(workspace);
  const server = createServer({
    contexts,
    masker,
    approval: new ApprovalServer(),
    recognizer: async () => {
      throw new Error("no OCR here");
    },
    version: "1.0.0",
    workflows: { requirements, runs },
    ...(metadata ? { metadata: { index, indexer: new BackgroundIndexer(index, { workspace }) } } : {}),
    reviewer: () => ({
      review: async (req) => {
        seen.push(structuredClone(req));
        const selected = req.kind === "requirements" ? (req as RequirementsRequest).items.map((i) => i.key) : req.kind === "scope" ? req.proposed.map((o) => o.name) : [];
        return { status: "approved", choice: "approved", missed: [], selected, digest: requestDigest(req), ...decide(req) };
      },
    }),
  });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { ...r, text: r.content.map((c) => c.text ?? "").join("\n") };
  };
  const notes =
    contexts.documents("renewals").find((d) => d.source.includes("notes")) ??
    (
      await masker.addDocuments(contexts, "renewals", [
        { kind: "meeting-notes", title: "Workshop with Karim Haddad", source: "notes.md", content: "Karim Haddad wants the renewal letter sent 30 days before the end date." },
      ])
    )[0]!;
  return { call, seen, runs, requirements, contexts, notes, setDecide: (d: Decide) => (decide = d), client, store: st };
}

const wf = { context: "renewals", workflow: "sa_high_level_design" };
const proposal = (sourceId: string) => ({ requirements: [{ kind: "functional", statement: "Send the renewal letter 30 days before the end date.", priority: "must", sourceIds: [sourceId] }] });

describe("workflow tools", () => {
  it("run a design workflow step by step: requirements confirmed on the page, then the saved design", async () => {
    const { call, seen, runs, notes } = await connect();
    const started = await call("workflow_start", wf);
    expect(started.isError).toBeFalsy();
    expect(started.text).toContain("Started a new run.");
    expect(started.text).toContain("Step 1 of 2: Requirements");
    expect(started.text).toContain(`[${notes.id}] meeting-notes: Workshop with [PERSON_`);
    expect(started.text).not.toContain("Karim");

    // Not the current step; then an answer of the wrong shape counts as an attempt.
    const wrong = await call("workflow_submit", { ...wf, step: "design", answer: { artifactId: "doc-0000000000" } });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('the current step is "requirements"');
    const bad = await call("workflow_submit", { ...wf, step: "requirements", answer: { requirements: [{ kind: "wish", statement: "x" }] } });
    expect(bad.text).toContain("attempt 1 of 3; 2 left");
    expect(bad.text).toMatch(/ERROR \[requirements\.0\.kind\]/);

    // A JSON string is taken too; the page shows the real name, the run moves on.
    const ok = await call("workflow_submit", { ...wf, step: "requirements", answer: JSON.stringify(proposal(notes.id)) });
    expect(ok.text).toContain('Step "requirements" passed. 1 requirement(s) confirmed.');
    expect(ok.text).toContain("Step 2 of 2: Draft the high-level design");
    expect(ok.text).toContain("- R1 [functional, must] Send the renewal letter 30 days before the end date.");
    expect(ok.text).toContain("Solution Architect");
    expect(seen).toHaveLength(1);

    // Resumes the open run in a new chat.
    const resumed = await call("workflow_start", { ...wf, focus: "letters" });
    expect(resumed.text).toContain("Resuming the open run");
    expect(resumed.text).toContain("keeps the focus and industry it was started with");
    expect(resumed.text).toContain("1. Requirements (requirements): done. 1 requirement(s) confirmed.");

    // An input is not a design; a design saved in the run is.
    expect((await call("workflow_submit", { ...wf, step: "design", answer: { artifactId: notes.id } })).text).toContain("is not a high-level design");
    const saved = await call("design_save", { context: "renewals", title: "Renewals: high-level design", designType: "high-level", content: "# Design\nR1: a flow sends the letter for Karim Haddad." });
    const id = /as (doc-[0-9a-f]{10})/.exec(saved.text)![1]!;
    const done = await call("workflow_submit", { ...wf, step: "design", answer: { artifactId: id } });
    expect(done.text).toContain("Every step is done");
    expect(done.text).toContain("offer to publish it to Confluence");
    expect(runs.list("renewals")[0]).toMatchObject({ status: "done" });
    expect(runs.list("renewals")[0]!.steps.map((s) => [s.step, s.status, s.attempts])).toEqual([
      ["requirements", "passed", 1],
      ["design", "passed", 1],
    ]);
    expect(JSON.stringify(runs.list("renewals"))).not.toContain("Karim");

    const status = await call("workflow_status", { context: "renewals" });
    expect(status.text).toContain("Solution Architect: high-level design, done");
    expect((await call("workflow_step", wf)).text).toContain("No sa_high_level_design run is open");
  });

  it("saves a step as failed after three attempts and goes on", async () => {
    const { call, runs } = await connect();
    await call("workflow_start", { ...wf, workflow: "po_backlog" });
    const pb = { context: "renewals", workflow: "po_backlog", step: "requirements" };
    await call("workflow_submit", { ...pb, answer: { keep: true } });
    await call("workflow_submit", { ...pb, answer: { keep: true } });
    const third = await call("workflow_submit", { ...pb, answer: { keep: true } });
    expect(third.text).toContain('Step "requirements" failed its checks 3 times, so the run goes on without it.');
    expect(third.text).toContain("No requirement is confirmed yet");
    expect(third.text).toContain("Step 2 of 2: Draft the backlog");
    expect(third.text).toContain("No requirement is confirmed");
    const run = runs.open("renewals", "po_backlog")!;
    expect(run.steps[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect((await call("workflow_status", { context: "renewals", workflow: "po_backlog" })).text).toContain("FAILED after the last attempt");
  });

  it("does not count a page the user closed, and counts a rejection with the user's comment", async () => {
    const { call, runs, notes, setDecide } = await connect();
    await call("workflow_start", wf);
    setDecide(() => ({ status: "expired" }));
    const expired = await call("workflow_submit", { ...wf, step: "requirements", answer: proposal(notes.id) });
    expect(expired.text).toContain("this did not count as an attempt");
    setDecide(() => ({ status: "rejected", comment: "Karim Haddad said 45 days" }));
    const rejected = await call("workflow_submit", { ...wf, step: "requirements", answer: proposal(notes.id) });
    expect(rejected.text).toContain("attempt 1 of 3");
    expect(rejected.text).toMatch(/The user's comment: \[PERSON_\d+\] said 45 days/);
    expect(runs.open("renewals", "sa_high_level_design")!.steps[0]).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("restarts a run, and keeps confirmed requirements without asking again", async () => {
    const { call, seen, runs, notes } = await connect();
    await call("workflow_start", wf);
    await call("workflow_submit", { ...wf, step: "requirements", answer: proposal(notes.id) });
    const first = runs.open("renewals", "sa_high_level_design")!.id;
    const restarted = await call("workflow_start", { ...wf, restart: true, industry: "insurance", focus: "Letters for Karim Haddad" });
    expect(restarted.text).toContain(`the open one (${first}) is closed`);
    expect(restarted.text).toMatch(/Focus: Letters for \[PERSON_\d+\]/);
    expect(restarted.text).toContain('If the inputs have not changed since, answer {"keep": true}');
    expect(runs.get(first)!.status).toBe("closed");
    const kept = await call("workflow_submit", { ...wf, step: "requirements", answer: { keep: true } });
    expect(kept.text).toContain("1 requirement(s) kept: R1.");
    expect(seen).toHaveLength(1);
    expect(runs.open("renewals", "sa_high_level_design")!.options).toMatchObject({ industry: "insurance" });
    expect((await call("workflow_start", { ...wf, restart: true, industry: "space mining" })).isError).toBe(true);
  });

  it("adds a scope step to designs when metadata is on, which can be skipped only while nothing is indexed", async () => {
    const { call, notes } = await connect({ metadata: true });
    const started = await call("workflow_start", wf);
    expect(started.text).toContain("Step 1 of 3: Requirements");
    const scope = await call("workflow_submit", { ...wf, step: "requirements", answer: proposal(notes.id) });
    expect(scope.text).toContain("Step 2 of 3: Scope");
    expect(scope.text).toContain("Nothing is indexed");
    expect((await call("workflow_submit", { ...wf, step: "scope", answer: { keep: true } })).text).toContain("No scope is confirmed yet");
    expect((await call("workflow_submit", { ...wf, step: "scope", answer: { objects: ["Account"] } })).text).toContain("Nothing is indexed, so no scope can be confirmed");
    const skipped = await call("workflow_submit", { ...wf, step: "scope", answer: { skip: "The user has no org access yet." } });
    expect(skipped.text).toContain('Step "scope" passed with warnings');
    expect(skipped.text).toContain("Step 3 of 3: Draft the high-level design");
    // The backlog has no scope step.
    expect((await call("workflow_start", { ...wf, workflow: "po_backlog" })).text).toContain("Step 1 of 2: Requirements");
  });

  it("resumes a run with a scope step on a server without metadata, where the step can be skipped", async () => {
    const first = await connect({ metadata: true });
    await first.call("workflow_start", wf);
    await first.call("workflow_submit", { ...wf, step: "requirements", answer: proposal(first.notes.id) });
    const again = await connect({ shared: first.store });
    const resumed = await again.call("workflow_start", wf);
    expect(resumed.isError).toBeFalsy();
    expect(resumed.text).toContain("Step 2 of 3: Scope");
    expect((await again.call("workflow_submit", { ...wf, step: "scope", answer: { skip: "No metadata here." } })).text).toContain("Step 3 of 3");
  });

  it("confirms the scope of an indexed project through the step, and masks an unknown object's name", async () => {
    const { call, notes, store: st } = await connect({ metadata: true });
    await indexProject(st.index, project());
    await call("workflow_start", wf);
    await call("workflow_submit", { ...wf, step: "requirements", answer: proposal(notes.id) });
    const unknown = await call("workflow_submit", { ...wf, step: "scope", answer: { objects: ["Karim Haddad"] } });
    expect(unknown.text).toContain("attempt 1 of 3");
    expect(unknown.text).toMatch(/None of these objects is in .*: \[PERSON_\d+\]/);
    expect(unknown.text).not.toContain("Karim");
    expect((await call("workflow_submit", { ...wf, step: "scope", answer: { skip: "No time." } })).text).toContain("propose the objects instead of skipping");
    const ok = await call("workflow_submit", { ...wf, step: "scope", answer: { objects: ["Policy__c"], reason: "Renewals change policies." } });
    expect(ok.text).toContain('Step "scope" passed. Scope confirmed: Policy__c.');
    expect(ok.text).toContain("Step 3 of 3: Draft the high-level design");
  });

  it("refuses a record built on a step that moved meanwhile", async () => {
    const { call, runs, notes, store: st } = await connect();
    await call("workflow_start", wf);
    const before = runs.open("renewals", "sa_high_level_design")!;
    await call("workflow_submit", { ...wf, step: "requirements", answer: proposal(notes.id) });
    const kit = { contexts: st.contexts, masker: st.masker, requirements: st.requirements, runs, reviewerFor: () => ({ review: async () => ({ status: "expired" as const, missed: [], digest: "" }) }) };
    await expect(submitStep(kit, {} as never, before, "requirements", { keep: true })).rejects.toThrow(WorkflowRunChangedError);
    expect(runs.open("renewals", "sa_high_level_design")!.steps[0]).toMatchObject({ status: "passed", attempts: 0 });
  });

  it("takes only a design of the right type written in the run, and a backlog whose check has no error", async () => {
    const { call, notes } = await connect();
    const save = (designType: string, content: string) => call("design_save", { context: "renewals", title: `Renewals ${designType}`, designType, content });
    const idOf = (t: string) => /as (doc-[0-9a-f]{10})/.exec(t)![1]!;
    const old = idOf((await save("high-level", "# Old design")).text);
    await new Promise((r) => setTimeout(r, 5));
    await call("workflow_start", wf);
    await call("workflow_submit", { ...wf, step: "requirements", answer: proposal(notes.id) });
    // Saved again unchanged: still the old version.
    await save("high-level", "# Old design");
    expect((await call("workflow_submit", { ...wf, step: "design", answer: { artifactId: old } })).text).toContain("was written before this run started");
    const detailed = idOf((await save("detailed", "# Detailed")).text);
    expect((await call("workflow_submit", { ...wf, step: "design", answer: { artifactId: detailed } })).text).toContain("is not a high-level design");
    await save("high-level", "# New design, R1");
    expect((await call("workflow_submit", { ...wf, step: "design", answer: { artifactId: old } })).text).toContain("Every step is done");

    const pb = { context: "renewals", workflow: "po_backlog" };
    await call("workflow_start", pb);
    await call("workflow_submit", { ...pb, step: "requirements", answer: { keep: true } });
    const story = (id: string) => ({ id, summary: "Send the letter", persona: "Renewals agent", want: "to send the letter", benefit: "clients renew", acceptanceCriteria: [{ given: "a policy", when: "30 days left", then: "a letter is sent" }], sourceIds: [notes.id] });
    const saved = await call("backlog_save", { context: "renewals", backlog: { title: "Renewals backlog", epics: [{ id: "E1", summary: "Renewal letters", outcome: "Clients renew on time", stories: [story("S1"), story("S1")] }] } });
    const sent = await call("workflow_submit", { ...pb, step: "backlog", answer: { artifactId: idOf(saved.text) } });
    expect(sent.text).toContain("ERROR [S1] Id S1 is used 2 times");
    expect(sent.text).toContain("quality check has errors");
  });

  it("reads an answer encoded twice, and masks a real name in an unknown key", async () => {
    const { call, notes } = await connect();
    await call("workflow_start", wf);
    const odd = await call("workflow_submit", { ...wf, step: "requirements", answer: { ...proposal(notes.id), "Karim Haddad": 1 } });
    expect(odd.text).toContain("attempt 1 of 3");
    expect(odd.text).not.toContain("Karim");
    const twice = await call("workflow_submit", { ...wf, step: "requirements", answer: JSON.stringify(JSON.stringify(proposal(notes.id))) });
    expect(twice.text).toContain('Step "requirements" passed');
  });

  it("keeps the output language with the context and tells it in every brief", async () => {
    const { call, contexts } = await connect();
    expect((await call("workflow_start", wf)).text).toContain("Output language: English.");
    const fr = await call("workflow_start", { ...wf, workflow: "po_backlog", language: "fr" });
    expect(fr.text).toContain("Output language: French. Write every requirement, design section and story in French");
    expect(contexts.get("renewals")?.settings.language).toBe("fr");
    expect((await call("workflow_step", wf)).text).toContain("Output language: French.");
    expect((await call("workflow_start", { ...wf, language: "de" })).isError).toBe(true);
  });

  it("lets a story review end without saved stories", async () => {
    const { call } = await connect();
    const review = { context: "renewals", workflow: "po_review_stories" };
    expect((await call("workflow_start", review)).text).toContain("Step 1 of 1: Review the stories");
    const done = await call("workflow_submit", { ...review, step: "review", answer: { none: "The user only wanted comments." } });
    expect(done.text).toContain("No stories saved");
    expect(done.text).toContain("Every step is done");
  });
});
