import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundIndexer } from "../../connectors/src/index.js";
import { ContextRepository, Database, documentId, Masker, MetadataIndex, newVaultKey, RequirementRepository, Vault, WorkflowRepository } from "../../core/src/index.js";
import { ApprovalServer, createServer, type RequirementsRequest } from "../../mcp/src/index.js";
import { databaseFile } from "../../mcp/src/startup.js";
import {
  Approver,
  firstTryShare,
  forgetVaultKey,
  listScenarios,
  openerPath,
  parseForm,
  reportMarkdown,
  runScenario,
  newestRun,
  submitOutcome,
  workflowSave,
  type CallTool,
  type Connect,
  type Model,
  type ToolSpec,
} from "../src/index.js";

const closers: (() => Promise<unknown>)[] = [];
const insurance = listScenarios().find((s) => s.id === "insurance-renewal")!;

/** The hand-written reference backlog, with its input placeholders turned into document ids. */
function referenceBacklog(): unknown {
  const text = readFileSync(join(insurance.dir, "reference-backlog.json"), "utf8").replace(/\{\{inputs\/([^}]+)\}\}/g, (_, f: string) =>
    documentId(resolve(insurance.inputsDir, f)),
  );
  return JSON.parse(text);
}
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

const requirementsPage = (): RequirementsRequest => ({
  kind: "requirements",
  title: "eval",
  items: [
    { key: "n1", kind: "functional", priority: "must", statement: "Send the renewal letter 30 days before the end date.", sources: ["notes"], note: "New" },
    { key: "n2", kind: "compliance", priority: "should", statement: "Keep card data out of Salesforce.", sources: ["security"], note: "New" },
  ],
  warnings: [],
});

describe("the approver", () => {
  it("answers a requirements page as a person would, keeping what it proposes", async () => {
    const pages = new ApprovalServer();
    closers.push(() => pages.close());
    const pending = await pages.request(requirementsPage());
    const approver = new Approver();
    expect(approver.open("https://example.com/a/x")).toBe(false);
    expect(approver.open(pending.url)).toBe(true);
    const decision = await pending.decision;
    expect(decision).toMatchObject({ status: "approved", selected: ["n1", "n2"], priorities: { n1: "must", n2: "should" }, lines: [] });
    await approver.close();
    expect(approver.records).toEqual([{ page: "Confirm the requirements", ok: true }]);
    const late = new Approver(async () => new Response("", { status: 410 }));
    late.open(pending.url);
    await late.close();
    expect(late.records).toEqual([{ page: "approval page", ok: false, error: "The approval link answered 410." }]);
  });

  it("is reached through the opener program the server starts", async () => {
    const pages = new ApprovalServer();
    const approver = new Approver();
    closers.push(() => pages.close(), () => approver.close());
    const env = await approver.listen();
    expect(JSON.parse(env.SF_AGENT_PO_BROWSER!)).toEqual([process.execPath, openerPath()]);
    const pending = await pages.request(requirementsPage());
    // What openInBrowser runs: the program with the page's address last.
    await promisify(execFile)(process.execPath, [openerPath(), pending.url], { env: { ...process.env, ...env } });
    expect((await pending.decision).status).toBe("approved");
  });

  it("rejects a page a task does not need, such as a publish, and takes addresses only with its token", async () => {
    const pages = new ApprovalServer();
    const approver = new Approver();
    closers.push(() => pages.close(), () => approver.close());
    const publish = await pages.request({ kind: "publish", target: "Confluence page", title: "Design", body: "Owner: Karim" });
    approver.open(publish.url);
    expect((await publish.decision).status).toBe("rejected");
    await approver.close();
    expect(approver.records[0]).toMatchObject({ ok: false, error: expect.stringContaining('Rejected the page "Approve and write"') });

    const env = await approver.listen();
    const hook = new URL(env.SF_AGENT_EVAL_APPROVER!);
    expect((await fetch(new URL("/0123456789abcdef0123456789abcdef", hook), { method: "POST", body: "x" })).status).toBe(404);
    expect((await fetch(hook)).status).toBe(404);
    expect((await fetch(hook, { method: "POST", body: "https://example.com/" })).status).toBe(400);
    expect((await fetch(hook, { method: "POST", body: "x".repeat(10_000) }).catch(() => ({ status: 413 }))).status).toBe(413);
  });

  it("reads a form as a browser sends it", () => {
    const form = parseForm(
      `<form method="post" action="/a/x"><input type="hidden" name="csrf" value="t&#38;k"><input type="checkbox" name="item" value="a" checked><input type="checkbox" name="item" value="b">` +
        `<select name="p"><option value="must">Must</option><option value="could" selected>Could</option></select><textarea name="comment"></textarea>` +
        `<input type="text" name="added"><button name="decision" value="approved">Approve <b>and</b> write</button><button name="decision" value="rejected">Reject</button></form>`,
    );
    expect(form.action).toBe("/a/x");
    expect(form.fields).toEqual([
      ["csrf", "t&k"],
      ["item", "a"],
      ["p", "could"],
      ["comment", ""],
      ["added", ""],
    ]);
    expect(form.buttons.map((b) => b.label)).toEqual(["Approve and write", "Reject"]);
  });
});

describe("reading the workflow's answers", () => {
  it("tells passed, sent back and uncounted answers apart, and finds what the last step saved", () => {
    expect(submitOutcome("epics", 'Step "epics" passed. 2 epics: E1, E2.\n\nWorkflow: ...')).toBe("passed");
    expect(submitOutcome("epics", 'Step "epics" was sent back (attempt 1 of 3; 2 left).')).toBe("sent back");
    expect(submitOutcome("epics", 'Step "epics" failed its checks 3 times, so the run goes on.')).toBe("failed");
    expect(submitOutcome("epics", 'Step "epics" is still open; this did not count as an attempt.')).toBe("not counted");
    expect(submitOutcome("stories", "Saved the stories of E1. Next: E2.")).toBe("progress");
    const done = 'Step "assemble" passed. Saved as doc-0123456789, version 2: Renewals.\n\nEvery step is done:\n9. Assemble (assemble): passed. Saved as doc-aaaaaaaaaa, version 1';
    expect(workflowSave("assemble", done)).toBe("doc-0123456789");
    expect(workflowSave("assemble", 'Step "assemble" was sent back. Saved as doc-0123456789, version 2')).toBeUndefined();
    expect(submitOutcome("x", "Every step of run run-0123456789ab is done. Start a new run.")).toBe("not counted");
    expect(newestRun("Run run-aaaaaaaaaaaa: HLD, open\n1. Requirements (requirements): passed\n\nRun run-bbbbbbbbbbbb: HLD, closed\nFindings on scope:\n- ERROR x")).toBe(
      "Run run-aaaaaaaaaaaa: HLD, open\n1. Requirements (requirements): passed",
    );
    expect(firstTryShare([])).toBeUndefined();
    expect(
      firstTryShare([
        { step: "a", sentBack: 0, accepted: true },
        { step: "b", sentBack: 2, accepted: true },
        { step: "c", sentBack: 0, accepted: false },
      ]),
    ).toBe(0.5);
  });

  it("leaves nothing to clean up outside macOS", () => {
    expect(() => forgetVaultKey(os.tmpdir(), "linux")).not.toThrow();
  });
});

describe("runScenario with the v1 server", () => {
  /** The v1 server in process, as main.ts builds it, with input review on (a pre-release) and its pages opened by the approver. */
  const v1 = (approver: Approver): Connect => async (workspaceDir) => {
    const db = new Database(databaseFile(workspaceDir));
    const metadata = new MetadataIndex(db);
    const approval = new ApprovalServer();
    const server = createServer({
      contexts: new ContextRepository(db),
      masker: new Masker({ vault: new Vault(db, newVaultKey()) }),
      approval,
      recognizer: async () => Promise.reject(new Error("no OCR")),
      version: "1.0.0-next.6",
      review: { open: (url) => approver.open(url) },
      metadata: { index: metadata, indexer: new BackgroundIndexer(metadata, { workspace: workspaceDir }) },
      workflows: { requirements: new RequirementRepository(db), runs: new WorkflowRepository(db) },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "eval-test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const close = client.close.bind(client);
    client.close = async () => {
      await close();
      await approval.close();
      db.close();
    };
    return client;
  };

  /** Starts each workflow, has its requirements sent back once, confirms them, then saves the work with the save tools. */
  class GuidedModel implements Model {
    readonly id = "fake:guided";
    prompts: string[] = [];
    replies: string[] = [];
    offered: string[] = [];
    async runAgent(prompt: string, tools: ToolSpec[], callTool: CallTool) {
      this.prompts.push(prompt);
      this.offered = tools.map((t) => t.name);
      const backlog = /Your task: build a \*\*backlog/.test(prompt);
      const workflow = backlog ? "po_backlog" : "sa_high_level_design";
      const toolCalls: { name: string; args: Record<string, unknown>; isError: boolean }[] = [];
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await callTool(name, args);
        toolCalls.push({ name, args, isError: r.isError });
        this.replies.push(r.text);
        return r;
      };
      await call("workflow_start", { context: "eval", workflow, industry: "insurance" });
      const doc = (await call("context_show", { context: "eval" })).text.match(/doc-[0-9a-f]{10}/)![0];
      const step = { context: "eval", workflow, step: "requirements" };
      if (backlog) await call("workflow_submit", { ...step, answer: { keep: true } });
      else {
        await call("workflow_submit", { ...step, answer: { requirements: [{ kind: "wish", statement: "x" }] } });
        await call("workflow_submit", {
          ...step,
          answer: { requirements: [{ kind: "functional", statement: "Policyholders accept their renewal quote online.", priority: "must", sourceIds: [doc] }] },
        });
      }
      if (backlog) await call("backlog_save", { context: "eval", backlog: referenceBacklog() });
      else await call("design_save", { context: "eval", title: "Renewal portal: high-level design", designType: "high-level", content: "# Renewal portal\n\nThe PAS stays the system of record." });
      return { finalText: "Done.", toolCalls, turns: toolCalls.length + 1, inputTokens: 100, outputTokens: 50, stop: "done" as const };
    }
    async complete(): Promise<string> {
      throw new Error("not a judge");
    }
  }

  class PassingJudge implements Model {
    readonly id = "fake:judge";
    seen: string[] = [];
    async runAgent(): Promise<never> {
      throw new Error("not an agent");
    }
    async complete(_system: string, prompt: string): Promise<string> {
      this.seen.push(prompt);
      const n = Number(prompt.match(/\((\d+) criteria\)/)![1]);
      return JSON.stringify(Array.from({ length: n }, (_, i) => ({ n: i + 1, pass: true, reason: "ok" })));
    }
  }

  it("indexes the metadata, answers the pages, counts the first tries, and judges with the workflow's status", async () => {
    const approver = new Approver();
    closers.push(() => approver.close());
    const model = new GuidedModel();
    const judge = new PassingJudge();
    const r = await runScenario(insurance, model, judge, v1(approver), { approver });
    expect(r.error).toBeUndefined();
    expect(r.sections.map((s) => s.error)).toEqual([undefined, undefined]);
    // The guided prompt, which names the workflow tools; the model may not index more metadata.
    expect(model.prompts[0]).toContain('Call `workflow_start` with `workflow: "sa_high_level_design"`');
    expect(model.offered).toContain("workflow_submit");
    expect(model.offered).not.toContain("metadata_index");
    // The input review while loading, then the requirements page of the design.
    expect(r.approvals?.length).toBeGreaterThan(0);
    expect(r.approvals!.every((a) => a.ok && a.page === "Looks right")).toBe(true);
    expect(r.sections[0]!.approvals).toEqual([{ page: "Confirm the requirements", ok: true }]);
    expect(model.replies.some((t) => t.startsWith('Step "requirements" passed'))).toBe(true);
    expect(r.sections[0]!.steps).toEqual([{ step: "requirements", sentBack: 1, accepted: true }]);
    expect(r.sections[1]!.steps).toEqual([{ step: "requirements", sentBack: 0, accepted: true }]);
    // The work saved with the save tool, with the workflow's status for the judge.
    expect(r.sections[0]!.artifact).toContain("The PAS stays the system of record.");
    expect(r.sections[0]!.artifact).toContain('<last_save_result tool="design_save">');
    expect(r.sections[0]!.artifact).toMatch(/<workflow_status>\nRun run-[0-9a-f]{12}: /);
    const md = reportMarkdown([r], { server: "v1", judge: "fake:judge", date: "today" });
    expect(md).toContain("| fake:guided | 10 | 50% |");
    expect(md).toContain("Workflow steps: 1, 0% passed on the first try; sent back: requirements 1×.");
    expect(md).toContain("Approval pages answered: Confirm the requirements.");
    expect(model.prompts[0]).toContain("A page that opens in the browser for the user to confirm is confirmed as it is proposed.");

    // A step that failed its checks is reported as such, and a page the runner could not answer fails the task.
    const failed = structuredClone(r);
    failed.sections[0]!.steps = [{ step: "scope", sentBack: 3, accepted: false, failed: true }];
    expect(reportMarkdown([failed], { server: "v1", judge: "j", date: "d" })).toContain("sent back: scope 3×; failed its checks: scope.");
  }, 60_000);

  it("fails the task, not the model, when a page cannot be answered", async () => {
    const approver = new Approver(async () => new Response("", { status: 500 }));
    closers.push(() => approver.close());
    const luxury = listScenarios().find((s) => s.id === "luxury-clienteling")!;
    const r = await runScenario({ ...luxury, sections: luxury.sections.slice(0, 1) }, new GuidedModel(), new PassingJudge(), v1(approver), { approver });
    // The input review page could not be answered, so loading failed, and the report says why.
    expect(r.error).toMatch(/context_add_file/);
    expect(r.approvals?.[0]).toMatchObject({ ok: false, error: "The approval link answered 500." });
    expect(reportMarkdown([r], { server: "v1", judge: "j", date: "d" })).toContain("(failed: The approval link answered 500.)");
  }, 60_000);
});
