import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { documentId } from "../../core/src/index.js";
import { listScenarios, parseVerdicts, reportMarkdown, runScenario, UNATTENDED, withLanguage, type CallTool, type Connect, type Model, type ToolSpec } from "../src/index.js";

// Today's server, in process, as the baseline run uses it over stdio. It is imported by path so the
// package's strict type check does not cover 0.x code, which compiles with its own settings.
const legacyServer = "../../../src/server.js";
const { createServer } = (await import(legacyServer)) as { createServer: (opts: { workspaceDir: string }) => { connect(t: unknown): Promise<void> } };

const inProcess: Connect = async (workspaceDir) => {
  const server = createServer({ workspaceDir });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "eval-test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const insurance = listScenarios().find((s) => s.id === "insurance-renewal")!;

/** The hand-written reference backlog, with its input placeholders turned into document ids. */
function referenceBacklog(): unknown {
  const text = readFileSync(join(insurance.dir, "reference-backlog.json"), "utf8").replace(/\{\{inputs\/([^}]+)\}\}/g, (_, f: string) =>
    documentId(resolve(insurance.inputsDir, f)),
  );
  return JSON.parse(text);
}

/** A model that follows a script instead of calling an API: it saves a fixed design and the reference backlog. */
class ScriptedModel implements Model {
  readonly id = "fake:scripted";
  prompts: string[] = [];
  offered: string[] = [];
  async runAgent(prompt: string, tools: ToolSpec[], callTool: CallTool) {
    this.prompts.push(prompt);
    this.offered = tools.map((t) => t.name);
    const calls: { name: string; args: Record<string, unknown> }[] = [
      { name: "context_show", args: { context: "eval" } },
      // Tools that are not offered are refused even when called by name.
      { name: "context_add_file", args: { context: "eval", path: join(insurance.dir, "rubric.md") } },
    ];
    if (!/Your task: build a \*\*backlog/.test(prompt)) {
      calls.push({
        name: "design_save",
        args: { context: "eval", title: "Renewal portal: high-level design", designType: "high-level", content: "# Renewal portal\n\nThe PAS stays the system of record." },
      });
    } else {
      calls.push({ name: "jira_publish", args: { context: "eval" } }, { name: "backlog_save", args: { context: "eval", backlog: referenceBacklog() } });
    }
    const toolCalls = [];
    for (const c of calls) toolCalls.push({ ...c, isError: (await callTool(c.name, c.args)).isError });
    return { finalText: "Done.", toolCalls, turns: calls.length + 1, inputTokens: 100, outputTokens: 50, stop: "done" as const };
  }
  async complete(): Promise<string> {
    throw new Error("not a judge");
  }
}

/** A judge that passes every design criterion and the first half of the backlog criteria, and records what it saw. */
class FakeJudge implements Model {
  readonly id = "fake:judge";
  seen: string[] = [];
  async runAgent(): Promise<never> {
    throw new Error("not an agent");
  }
  async complete(_system: string, prompt: string): Promise<string> {
    this.seen.push(prompt);
    const n = Number(prompt.match(/\((\d+) criteria\)/)![1]);
    const design = prompt.includes('task="sa_high_level_design"');
    return `Here you go:\n${JSON.stringify(Array.from({ length: n }, (_, i) => ({ n: i + 1, pass: design || i < n / 2, reason: `r${i + 1}` })))}`;
  }
}

describe("scenarios", () => {
  it("finds the sample and luxury scenarios and reads their rubrics", () => {
    const all = listScenarios();
    expect(all.map((s) => s.id)).toEqual(expect.arrayContaining(["banking-onboarding", "insurance-renewal", "luxury-clienteling", "luxe-service-apres-vente"]));
    const luxury = all.filter((s) => s.industry === "luxury");
    expect(luxury.map((s) => s.language).sort()).toEqual(["en", "fr"]);
    for (const s of luxury) expect(s.sections.map((x) => x.task)).toEqual(["sa_high_level_design", "po_backlog"]);
    expect(insurance.sections.map((s) => [s.task, s.criteria.length])).toEqual([
      ["sa_high_level_design", 15],
      ["po_backlog", 8],
    ]);
    expect(insurance.metadataDir).toBeDefined();
  });
});

describe("runScenario", () => {
  it("loads the inputs, runs each task, and scores what was saved", async () => {
    const model = new ScriptedModel();
    const judge = new FakeJudge();
    const r = await runScenario(insurance, model, judge, inProcess);
    expect(r.error).toBeUndefined();
    expect(r.sections.map((s) => [s.task, s.score])).toEqual([
      ["sa_high_level_design", 10],
      ["po_backlog", 5],
    ]);
    expect(r.score).toBe(7.5);
    // The design task ran first, with the industry template, and the PO saw the saved design.
    expect(model.prompts[0]).toContain("high-level design");
    expect(model.prompts[0]).toContain("Industry: Insurance");
    expect(model.prompts[0]).toContain(UNATTENDED);
    // Publishing and adding inputs are not offered, and a call to them is refused.
    expect(model.offered).toContain("backlog_save");
    expect(model.offered.some((t) => /publish|context_add_/.test(t))).toBe(false);
    for (const s of r.sections) expect(s.agent!.toolCalls.filter((c) => /publish|context_add_/.test(c.name)).every((c) => c.isError)).toBe(true);
    expect(r.sections[1]!.agent!.toolCalls.find((c) => c.name === "jira_publish")?.isError).toBe(true);
    expect(judge.seen[0]).not.toContain("Rubric \"High-level design\" (15 criteria):\n1. States that the current org");
    expect(judge.seen.join("\n")).not.toMatch(/Source: .*rubric\.md/);
    // The judge saw the inputs, the saved artifact and the server's quality check.
    expect(judge.seen[0]).toContain("The PAS stays the system of record.");
    expect(judge.seen[0]).toContain("Renewal portal kickoff");
    expect(judge.seen[1]).toContain('<last_save_result tool="backlog_save">');
    // The backlog is also shown as JSON, so fields the Markdown leaves out can be judged.
    expect(judge.seen[1]).toContain('<structured tool="backlog_get">');
    expect(r.sections[1]!.artifact).toContain("View my renewal quote in the portal");
  }, 30_000);

  it("fails every criterion of a task that saved nothing", async () => {
    const lazy: Model = {
      id: "fake:lazy",
      runAgent: async () => ({ finalText: "I will not.", toolCalls: [], turns: 1, inputTokens: 1, outputTokens: 1, stop: "done" }),
      complete: async () => "",
    };
    const r = await runScenario(insurance, lazy, new FakeJudge(), inProcess);
    expect(r.sections.map((s) => s.score)).toEqual([0, 0]);
    expect(r.sections[0]!.verdicts[0]!.reason).toBe("Nothing was saved for this task.");
  }, 30_000);

  it("judges only the last artifact the task itself saved, with that save's result", async () => {
    const design = (title: string) => ({ context: "eval", title, designType: "high-level", content: `# ${title}` });
    const model: Model = {
      id: "fake:drafts",
      async runAgent(prompt, _tools, callTool) {
        const calls: [string, Record<string, unknown>][] = /Your task: build a \*\*backlog/.test(prompt)
          ? [
              ["backlog_save", { context: "eval", backlog: referenceBacklog() }],
              ["backlog_save", { context: "eval", backlog: { title: "Broken" } }],
            ]
          : [
              ["design_save", design("Draft design ALPHA")],
              ["design_save", design("Final design BETA")],
              // Saved by the wrong task: must not count as this scenario's backlog.
              ["backlog_save", { context: "eval", backlog: { ...(referenceBacklog() as object), title: "SA backlog GAMMA" } }],
            ];
        const toolCalls = [];
        for (const [name, args] of calls) toolCalls.push({ name, args, isError: (await callTool(name, args)).isError });
        return { finalText: "", toolCalls, turns: 1, inputTokens: 1, outputTokens: 1, stop: "done" as const };
      },
      complete: async () => "",
    };
    const judge = new FakeJudge();
    const r = await runScenario(insurance, model, judge, inProcess);
    expect(r.sections.map((s) => s.error)).toEqual([undefined, undefined]);
    expect(r.sections[0]!.artifact).toContain("Final design BETA");
    expect(r.sections[0]!.artifact).not.toContain("Draft design ALPHA");
    expect(r.sections[1]!.artifact).not.toContain("SA backlog GAMMA");
    expect(r.sections[1]!.artifact).toContain("View my renewal quote in the portal");
    expect(r.sections[1]!.agent!.toolCalls[1]!.isError).toBe(true);
    expect(r.sections[1]!.artifact).not.toMatch(/<last_save_result[^>]*>\s*(Tool call failed|MCP error)/);
  }, 30_000);

  it("keeps the other sections when one task's judging fails", async () => {
    const judge = new FakeJudge();
    const flaky: Model = {
      id: "fake:flaky-judge",
      runAgent: judge.runAgent.bind(judge),
      complete: async (system, prompt) => {
        if (prompt.includes('task="po_backlog"')) throw new Error("529 overloaded");
        return judge.complete(system, prompt);
      },
    };
    const r = await runScenario(insurance, new ScriptedModel(), flaky, inProcess);
    expect(r.error).toBeUndefined();
    expect(r.sections.map((s) => [s.score, s.error])).toEqual([
      [10, undefined],
      [0, "529 overloaded"],
    ]);
    expect(r.sections[1]!.artifact).toContain("View my renewal quote in the portal");
    const md = reportMarkdown([r], { server: "test", judge: "fake", date: "today" });
    expect(md).toContain("design 10, backlog error");
    expect(md).toContain("The task failed: 529 overloaded");
    expect(md).toContain("| fake:scripted | 5 (below target; 1 failed, counted as 0) | n/a |");
  }, 30_000);

  it("reports a scenario that cannot load instead of throwing", async () => {
    const broken = { ...insurance, inputsDir: join(insurance.dir, "missing") };
    const r = await runScenario(broken, new ScriptedModel(), new FakeJudge(), inProcess);
    expect(r.error).toMatch(/Loading the scenario failed at context_add_file/);
    expect(reportMarkdown([r], { server: "test", judge: "fake:judge", date: "today" })).toContain("The run failed");
  });
});

describe("judging and reporting", () => {
  it("reads verdicts by number or by order, and refuses incomplete answers", () => {
    expect(parseVerdicts('[{"n":2,"pass":false,"reason":"b"},{"n":1,"pass":true}]', ["x", "y"])).toEqual([
      { criterion: "x", pass: true, reason: "" },
      { criterion: "y", pass: false, reason: "b" },
    ]);
    expect(() => parseVerdicts('[{"n":1,"pass":true}]', ["x", "y"])).toThrow(/criterion 2/);
    expect(() => parseVerdicts("I think it passes.", ["x"])).toThrow(/no JSON array/);
    // Brackets in the prose around the array, as when the judge cites a document id.
    expect(parseVerdicts('Checking criterion [1]:\n[{"n":1,"pass":true}]\nNote: the design cites [doc-1a2b].', ["x"])[0]!.pass).toBe(true);
    expect(parseVerdicts('```json\n[{"n":1,"pass":false,"reason":"see [doc-1]"}]\n```', ["x"])[0]!.reason).toBe("see [doc-1]");
  });

  it("asks for the scenario's language when it is not English", () => {
    expect(withLanguage("Draft.", "en")).toBe("Draft.");
    expect(withLanguage("Draft.", "fr")).toBe("Draft.\n\nWrite everything you produce in French.");
  });

  it("summarises scores against the target and lists missed criteria", async () => {
    const r = await runScenario(insurance, new ScriptedModel(), new FakeJudge(), inProcess);
    const md = reportMarkdown([r], { server: "0.x", judge: "fake:judge", date: "2026-11-07" });
    expect(md).toContain("| fake:scripted | 7.5 | n/a | design 10, backlog 5 |");
    expect(md).toContain("### Backlog: 5/10");
    expect(md).toContain("- Missed: ");
  }, 30_000);
});
