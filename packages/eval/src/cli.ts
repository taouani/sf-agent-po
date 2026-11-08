#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Approver } from "./approver.js";
import { checkOpenRouterModels, createModel } from "./models.js";
import { reportMarkdown } from "./report.js";
import { runScenario, stdioServer, type ScenarioResult } from "./run.js";
import { listScenarios } from "./scenario.js";

const USAGE = `Usage: sf-agent-eval --models <provider:model,...> [options]

Runs every scenario with every model against the server, has a judge model score
the output against each scenario's rubric, and writes report.md and results.json.

  --models     Models to evaluate, e.g. anthropic:claude-opus-5-5,openai:<model>,xai:<model>,
               or through OpenRouter: openrouter:anthropic/<model>,openrouter:x-ai/<model>
  --judge      Judge model (default: the first model)
  --scenarios  Scenario ids, comma-separated (default: all)
  --server     Command that starts the MCP server, split on spaces, or a JSON array
               such as '["C:/Program Files/nodejs/node.exe","dist/main.js"]'
               (default: the v1 server, node packages/mcp/dist/main.js)
  --baseline   Run against the 0.x server (node dist/index.js) instead, for comparison
  --out        Output folder (default: eval-results/<date>)
  --max-turns  Turn limit per task (default: 80)
  --list       List the scenarios and exit

Keys come from ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY and OPENROUTER_API_KEY.
The runner answers the approval pages a v1 server opens (input review, requirements,
scope) as a user would, approving what they propose; run "npm run build" first.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      models: { type: "string" },
      judge: { type: "string" },
      scenarios: { type: "string" },
      server: { type: "string" },
      baseline: { type: "boolean" },
      out: { type: "string" },
      "max-turns": { type: "string" },
      list: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const all = listScenarios();
  if (values.list) {
    for (const s of all) console.log(`${s.id}\t${s.language}\t${s.industry ?? "-"}\t${s.title}`);
    return 0;
  }
  if (!values.models) {
    console.error(USAGE);
    return 2;
  }
  const wanted = values.scenarios?.split(",").map((s) => s.trim()).filter(Boolean);
  const scenarios = wanted ? wanted.map((id) => all.find((s) => s.id === id) ?? fail(`Unknown scenario "${id}". Known: ${all.map((s) => s.id).join(", ")}`)) : all;
  const specs = values.models.split(",").map((m) => m.trim());
  const models = specs.map((m) => createModel(m));
  const judge = values.judge ? createModel(values.judge) : models[0]!;
  // After the cheap checks (the spec, the key): this one asks OpenRouter.
  await checkOpenRouterModels([...specs, ...(values.judge ? [values.judge] : [])]);

  if (values.server && values.baseline) fail("Give --server or --baseline, not both.");
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const [command, ...args] = values.server
    ? serverCommand(values.server)
    : [process.execPath, values.baseline ? join(repoRoot, "dist", "index.js") : join(repoRoot, "packages", "mcp", "dist", "main.js")];
  // Answers the pages the server opens; the server finds it through SF_AGENT_PO_BROWSER.
  const approver = new Approver();
  const connect = stdioServer(command!, args, await approver.listen());
  const serverName = values.server ?? (values.baseline ? "0.x (dist/index.js)" : "v1 (packages/mcp/dist/main.js)");
  // UTC to the second, without colons so the folder name works on Windows.
  const date = new Date().toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");
  const out = resolve(values.out ?? join("eval-results", date));
  const maxTurns = values["max-turns"] === undefined ? undefined : Number(values["max-turns"]);
  if (maxTurns !== undefined && !(Number.isInteger(maxTurns) && maxTurns > 0)) fail(`--max-turns must be a positive whole number, not "${values["max-turns"]}".`);

  const results: ScenarioResult[] = [];
  let report = "";
  await mkdir(out, { recursive: true });
  for (const model of models) {
    for (const scenario of scenarios) {
      console.log(`Running ${scenario.id} with ${model.id}...`);
      const r = await runScenario(scenario, model, judge, connect, { maxTurns, approver });
      console.log(r.error ? `  failed: ${r.error}` : `  ${r.sections.map((s) => `${s.task} ${s.error ? `failed: ${s.error}` : `${s.score}/10`}`).join(", ")}`);
      results.push(r);
      // Written after every run, so a run cut short (for example by a CI timeout) keeps what it measured.
      report = reportMarkdown(results, { server: serverName, judge: judge.id, date });
      await writeFile(join(out, "results.json"), JSON.stringify(results, null, 2));
      await writeFile(join(out, "report.md"), report);
    }
  }
  await approver.close();
  console.log(`\n${report}\nWritten to ${out}`);
  return results.some((r) => r.error || r.sections.some((s) => s.error)) ? 1 : 0;
}

/** A JSON array of strings, or words separated by spaces. */
function serverCommand(value: string): string[] {
  const parts = value.trim().startsWith("[") ? (JSON.parse(value) as unknown) : value.trim().split(/\s+/);
  if (!Array.isArray(parts) || !parts.length || !parts.every((p) => typeof p === "string" && p)) fail(`--server must name a command, not "${value}".`);
  return parts as string[];
}

function fail(message: string): never {
  throw new Error(message);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
