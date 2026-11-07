#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createModel } from "./models.js";
import { reportMarkdown } from "./report.js";
import { runScenario, stdioServer, type ScenarioResult } from "./run.js";
import { listScenarios } from "./scenario.js";

const USAGE = `Usage: sf-agent-eval --models <provider:model,...> [options]

Runs every scenario with every model against the server, has a judge model score
the output against each scenario's rubric, and writes report.md and results.json.

  --models     Models to evaluate, e.g. anthropic:claude-opus-5-5,openai:<model>,xai:<model>
  --judge      Judge model (default: the first model)
  --scenarios  Scenario ids, comma-separated (default: all)
  --server     Command that starts the MCP server (default: today's server, node dist/index.js)
  --out        Output folder (default: eval-results/<date>)
  --max-turns  Turn limit per task (default: 40)
  --list       List the scenarios and exit

Keys come from ANTHROPIC_API_KEY, OPENAI_API_KEY and XAI_API_KEY.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      models: { type: "string" },
      judge: { type: "string" },
      scenarios: { type: "string" },
      server: { type: "string" },
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
  const models = values.models.split(",").map((m) => createModel(m.trim()));
  const judge = values.judge ? createModel(values.judge) : models[0]!;

  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const [command, ...args] = values.server ? values.server.split(" ") : [process.execPath, join(repoRoot, "dist", "index.js")];
  const connect = stdioServer(command!, args);
  const serverName = values.server ?? "0.x (dist/index.js)";
  const date = new Date().toISOString().replace(/:\d\d\.\d+Z$/, "Z").replace(":", "-");
  const out = resolve(values.out ?? join("eval-results", date));
  const maxTurns = values["max-turns"] ? Number(values["max-turns"]) : undefined;

  const results: ScenarioResult[] = [];
  for (const model of models) {
    for (const scenario of scenarios) {
      console.log(`Running ${scenario.id} with ${model.id}...`);
      const r = await runScenario(scenario, model, judge, connect, { maxTurns });
      console.log(r.error ? `  failed: ${r.error}` : `  ${r.sections.map((s) => `${s.task} ${s.score}/10`).join(", ")}`);
      results.push(r);
    }
  }
  await mkdir(out, { recursive: true });
  const report = reportMarkdown(results, { server: serverName, judge: judge.id, date });
  await writeFile(join(out, "results.json"), JSON.stringify(results, null, 2));
  await writeFile(join(out, "report.md"), report);
  console.log(`\n${report}\nWritten to ${out}`);
  return results.some((r) => r.error) ? 1 : 0;
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
