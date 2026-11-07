import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentRun, CallTool, Model, ToolSpec } from "./models.js";
import { TASKS, type RubricSection, type Scenario, type Task } from "./scenario.js";

/** Opens an MCP client on a fresh server whose workspace is `workspaceDir`. */
export type Connect = (workspaceDir: string) => Promise<Client>;

/**
 * Starts the server under test as hosts do, over stdio. By default that is
 * today's 0.x server (`dist/index.js` after `npm run build`), which gives the
 * baseline; the v1 server plugs in the same way.
 */
export function stdioServer(command: string, args: string[], env: Record<string, string> = {}): Connect {
  return async (workspaceDir) => {
    const client = new Client({ name: "sf-agent-eval", version: "0" });
    // Only what the server needs: no model keys or other secrets reach it.
    const baseEnv = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
    await client.connect(new StdioClientTransport({ command, args, env: { ...baseEnv, ...env, SF_AGENT_WORKSPACE: workspaceDir }, stderr: "pipe" }));
    return client;
  };
}

/** Tools the model under test may use: no publishing, and no new inputs beyond the scenario's. */
export function allowedTool(name: string): boolean {
  return !/publish|^context_add_|^context_remove_/.test(name);
}

export interface CriterionVerdict {
  criterion: string;
  pass: boolean;
  reason: string;
}

export interface SectionResult {
  title: string;
  task: string;
  /** 0 to 10: the share of criteria met. */
  score: number;
  verdicts: CriterionVerdict[];
  /** What the task saved, as the judge saw it ("" when nothing was saved). */
  artifact: string;
  agent: Omit<AgentRun, "finalText"> & { finalText: string };
}

export interface ScenarioResult {
  scenario: string;
  model: string;
  judge: string;
  startedAt: string;
  durationMs: number;
  sections: SectionResult[];
  /** Mean of the section scores. */
  score: number;
  error?: string;
}

const CONTEXT = "eval";

export async function runScenario(scenario: Scenario, model: Model, judge: Model, connect: Connect, opts: { maxTurns?: number } = {}): Promise<ScenarioResult> {
  const started = Date.now();
  const result: ScenarioResult = { scenario: scenario.id, model: model.id, judge: judge.id, startedAt: new Date(started).toISOString(), durationMs: 0, sections: [], score: 0 };
  const workspace = await mkdtemp(join(tmpdir(), "sf-agent-eval-"));
  let client: Client | undefined;
  try {
    client = await connect(workspace);
    const lastResult = new Map<string, string>();
    const raw = toolCaller(client);
    const call: CallTool = async (name, args) => {
      const r = await raw(name, args);
      lastResult.set(name, r.text);
      return r;
    };
    await mustCall(call, "context_add_file", { context: CONTEXT, path: scenario.inputsDir });
    if (scenario.metadataDir) await mustCall(call, "context_add_metadata", { context: CONTEXT, provider: "local", location: scenario.metadataDir });
    const inputs = (await mustCall(call, "context_read", { context: CONTEXT })).text;

    const { tools } = await client.listTools();
    const specs: ToolSpec[] = tools
      .filter((t) => allowedTool(t.name))
      .map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown> }));

    // Tasks run in a fixed order (design before backlog), so the PO can build on the SA's design.
    const order = Object.keys(TASKS) as Task[];
    const sections = [...scenario.sections].sort((a, b) => order.indexOf(a.task as Task) - order.indexOf(b.task as Task));
    for (const section of sections) {
      const prompt = await client.getPrompt({ name: section.task, arguments: { context: CONTEXT, ...(scenario.industry ? { industry: scenario.industry } : {}) } });
      const text = prompt.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n\n");
      lastResult.delete(TASKS[section.task as Task].saveTool);
      const agent = await model.runAgent(`${withLanguage(text, scenario.language)}\n\n${UNATTENDED}`, specs, call, opts);
      const { artifactKind, saveTool } = TASKS[section.task as Task];
      const saved = await raw("context_read", { context: CONTEXT, kinds: [artifactKind] });
      const check = lastResult.get(saveTool);
      // The save tool's answer carries the server's own quality check, which some criteria refer to.
      const artifact = saved.isError || /^No matching documents/.test(saved.text) ? "" : `${saved.text}${check ? `\n\n<last_save_result tool="${saveTool}">\n${check}\n</last_save_result>` : ""}`;
      const verdicts = await judgeSection(judge, scenario, section, artifact, inputs);
      result.sections.push({ title: section.title, task: section.task, score: score(verdicts), verdicts, artifact, agent });
    }
    result.score = round(result.sections.reduce((s, x) => s + x.score, 0) / (result.sections.length || 1));
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    await client?.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    result.durationMs = Date.now() - started;
  }
  return result;
}

/**
 * The run has no user to answer questions, and 0.x tells the agent to ask when,
 * for example, it does not know the industry. Without this the agent could stop
 * and save nothing, which would measure the missing user rather than the output.
 */
export const UNATTENDED =
  "No one is available to answer questions during this task. Where you would ask the user, make the most reasonable assumption, state it, list it as an open question, and finish the task, including saving the result.";

/**
 * 0.x has no output language setting (FE3 comes in v1), so for a scenario in
 * another language the runner says which language to write in, the way a user would.
 */
export function withLanguage(prompt: string, language: string): string {
  if (language === "en") return prompt;
  return `${prompt}\n\nWrite everything you produce in ${languageName(language)}.`;
}

/**
 * The languages the scenarios use are named from a table. Intl.DisplayNames
 * covers the rest; its first use loads locale data, and a test calling it timed out on a busy Windows runner.
 */
const LANGUAGE_NAMES: Record<string, string> = { fr: "French", de: "German", it: "Italian", es: "Spanish", ja: "Japanese", zh: "Chinese" };

function languageName(language: string): string {
  return LANGUAGE_NAMES[language] ?? new Intl.DisplayNames(["en"], { type: "language" }).of(language) ?? language;
}

function toolCaller(client: Client): CallTool {
  return async (name, args) => {
    if (!allowedTool(name) && !["context_add_file", "context_add_metadata"].includes(name)) {
      return { text: `The tool ${name} is not available in this evaluation.`, isError: true };
    }
    try {
      const r = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
      return { text: (r.content ?? []).map((c) => c.text ?? "").join("\n"), isError: Boolean(r.isError) };
    } catch (err) {
      return { text: `Tool call failed: ${(err as Error).message}`, isError: true };
    }
  };
}

async function mustCall(call: CallTool, name: string, args: Record<string, unknown>): Promise<{ text: string }> {
  const r = await call(name, args);
  if (r.isError) throw new Error(`Loading the scenario failed at ${name}: ${r.text}`);
  return r;
}

const JUDGE_SYSTEM = `You are a strict reviewer of Salesforce solution designs and agile backlogs. You check an artifact against a rubric, one criterion at a time, using only what the artifact says. A criterion passes only when the artifact clearly meets it; partial or implied coverage fails. Answer with JSON only.`;

export async function judgeSection(judge: Model, scenario: Scenario, section: RubricSection, artifact: string, inputs: string): Promise<CriterionVerdict[]> {
  if (!artifact) return section.criteria.map((criterion) => ({ criterion, pass: false, reason: "Nothing was saved for this task." }));
  const prompt = `Scenario: ${scenario.title}. The expected output language is ${scenario.language}.

<inputs>
${inputs}
</inputs>

<artifact task="${section.task}">
${artifact}
</artifact>

Rubric "${section.title}" (${section.criteria.length} criteria):
${section.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

For each criterion, decide whether the artifact meets it. Reply with a JSON array, one object per criterion in order:
[{"n": 1, "pass": true, "reason": "one sentence citing where the artifact meets or misses it"}, ...]`;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await judge.complete(JUDGE_SYSTEM, attempt ? `${prompt}\n\nYour previous answer could not be read (${lastError}). Reply with the JSON array only.` : prompt);
    try {
      return parseVerdicts(answer, section.criteria);
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  throw new Error(`The judge's answer for "${section.title}" could not be read: ${lastError}`);
}

export function parseVerdicts(answer: string, criteria: string[]): CriterionVerdict[] {
  const start = answer.indexOf("[");
  const end = answer.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("no JSON array");
  const items = JSON.parse(answer.slice(start, end + 1)) as { n?: unknown; pass?: unknown; reason?: unknown }[];
  if (!Array.isArray(items)) throw new Error("not an array");
  return criteria.map((criterion, i) => {
    const item = items.find((x) => x.n === i + 1) ?? items[i];
    if (!item || typeof item.pass !== "boolean") throw new Error(`no verdict for criterion ${i + 1}`);
    return { criterion, pass: item.pass, reason: typeof item.reason === "string" ? item.reason : "" };
  });
}

function score(verdicts: CriterionVerdict[]): number {
  return round((10 * verdicts.filter((v) => v.pass).length) / (verdicts.length || 1));
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
