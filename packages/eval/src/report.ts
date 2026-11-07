import type { ScenarioResult } from "./run.js";

/** The target from the confirmed goal: a rubric score of at least 7/10 per model. */
export const TARGET_SCORE = 7;

/** A Markdown summary: one table of scores by model and scenario, then every failed criterion. */
export function reportMarkdown(results: ScenarioResult[], meta: { server: string; judge: string; date: string }): string {
  const models = [...new Set(results.map((r) => r.model))];
  const scenarios = [...new Set(results.map((r) => r.scenario))];
  const cell = (m: string, s: string) => {
    const r = results.find((x) => x.model === m && x.scenario === s);
    if (!r) return "";
    if (r.error) return "error";
    return r.sections.map((x) => `${short(x.task)} ${x.score}`).join(", ");
  };
  const mean = (m: string) => {
    const ok = results.filter((r) => r.model === m && !r.error);
    return ok.length ? Math.round((ok.reduce((n, r) => n + r.score, 0) / ok.length) * 10) / 10 : undefined;
  };
  const lines = [
    `# Evaluation ${meta.date}`,
    ``,
    `Server: ${meta.server}. Judge: ${meta.judge}. Scores are out of 10 (the share of rubric criteria met); the target is ${TARGET_SCORE} per model.`,
    ``,
    `| Model | Mean | ${scenarios.join(" | ")} |`,
    `| --- | --- | ${scenarios.map(() => "---").join(" | ")} |`,
    ...models.map((m) => {
      const avg = mean(m);
      return `| ${m} | ${avg === undefined ? "n/a" : `${avg}${avg >= TARGET_SCORE ? "" : " (below target)"}`} | ${scenarios.map((s) => cell(m, s)).join(" | ")} |`;
    }),
  ];
  for (const r of results) {
    lines.push(``, `## ${r.scenario} with ${r.model}`, ``);
    if (r.error) {
      lines.push(`The run failed: ${r.error}`);
      continue;
    }
    for (const s of r.sections) {
      const a = s.agent;
      lines.push(
        `### ${s.title}: ${s.score}/10`,
        ``,
        `${a.turns} turns, ${a.toolCalls.length} tool calls (${a.toolCalls.filter((c) => c.isError).length} failed), ${a.inputTokens} input and ${a.outputTokens} output tokens, ended: ${a.stop}.`,
        ``,
      );
      const failed = s.verdicts.filter((v) => !v.pass);
      if (!failed.length) lines.push(`Every criterion met.`);
      for (const v of failed) lines.push(`- Missed: ${v.criterion}${v.reason ? ` (${v.reason})` : ""}`);
      lines.push(``);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function short(task: string): string {
  return task === "sa_high_level_design" ? "design" : task === "po_backlog" ? "backlog" : task;
}
