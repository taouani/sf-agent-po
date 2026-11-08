import type { AgentRun } from "./models.js";
import { firstTryShare, type ScenarioResult, type StepTries } from "./run.js";

/** What the input owed to the prompt cache: read (cheap) and written (dearer). */
const cacheNote = (a: Pick<AgentRun, "cachedInputTokens" | "cacheWriteTokens">) => {
  const parts = [a.cachedInputTokens ? `${a.cachedInputTokens} read from the cache` : "", a.cacheWriteTokens ? `${a.cacheWriteTokens} written to it` : ""].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
};

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
    return r.sections.map((x) => `${short(x.task)} ${x.error ? "error" : x.score}`).join(", ");
  };
  // A run or task that failed counts as 0, so failures can never lift a model over the target.
  const mean = (m: string) => {
    const runs = results.filter((r) => r.model === m);
    return runs.length ? Math.round((runs.reduce((n, r) => n + (r.error ? 0 : r.score), 0) / runs.length) * 10) / 10 : undefined;
  };
  // The second number: the share of workflow steps whose first answer passed (v1 only).
  const firstTry = (m: string) => {
    const steps: StepTries[] = results.filter((r) => r.model === m).flatMap((r) => r.sections.flatMap((x) => x.steps ?? []));
    const share = firstTryShare(steps);
    return share === undefined ? "n/a" : `${Math.round(share * 100)}%`;
  };
  const failures = (m: string) => results.filter((r) => r.model === m).reduce((n, r) => n + (r.error ? 1 : r.sections.filter((x) => x.error).length), 0);
  const lines = [
    `# Evaluation ${meta.date}`,
    ``,
    `Server: ${meta.server}. Judge: ${meta.judge}. Scores are out of 10 (the share of rubric criteria met); the target is ${TARGET_SCORE} per model. ` +
      `First try is the share of workflow steps whose first answer the server accepted.`,
    ``,
    `| Model | Mean | First try | ${scenarios.join(" | ")} |`,
    `| --- | --- | --- | ${scenarios.map(() => "---").join(" | ")} |`,
    ...models.map((m) => {
      const avg = mean(m);
      const failed = failures(m);
      const notes = [...(avg !== undefined && avg < TARGET_SCORE ? ["below target"] : []), ...(failed ? [`${failed} failed, counted as 0`] : [])];
      return `| ${m} | ${avg === undefined ? "n/a" : `${avg}${notes.length ? ` (${notes.join("; ")})` : ""}`} | ${firstTry(m)} | ${scenarios.map((s) => cell(m, s)).join(" | ")} |`;
    }),
  ];
  const pages = (list: { page: string; ok: boolean; error?: string }[] | undefined) =>
    list?.length ? `Approval pages answered: ${list.map((p) => (p.ok ? p.page : `${p.page} (failed: ${p.error})`)).join("; ")}.` : undefined;
  for (const r of results) {
    lines.push(``, `## ${r.scenario} with ${r.model}`, ``);
    const loading = pages(r.approvals);
    if (loading) lines.push(`While loading the inputs. ${loading}`, ``);
    if (r.error) {
      lines.push(`The run failed: ${r.error}`);
      continue;
    }
    for (const s of r.sections) {
      const a = s.agent;
      lines.push(`### ${s.title}: ${s.score}/10`, ``);
      if (a) {
        lines.push(
          `${a.turns} turns, ${a.toolCalls.length} tool calls (${a.toolCalls.filter((c) => c.isError).length} failed), ${a.inputTokens} input${cacheNote(a)} and ${a.outputTokens} output tokens, ended: ${a.stop}.`,
          ``,
        );
      }
      if (s.steps?.length) {
        const share = firstTryShare(s.steps);
        const back = s.steps.filter((x) => x.sentBack);
        lines.push(
          `Workflow steps: ${s.steps.length}, ${share === undefined ? "none answered" : `${Math.round(share * 100)}% passed on the first try`}` +
            `${back.length ? `; sent back: ${back.map((x) => `${x.step} ${x.sentBack}×`).join(", ")}` : ""}` +
            `${s.steps.some((x) => x.failed) ? `; failed its checks: ${s.steps.filter((x) => x.failed).map((x) => x.step).join(", ")}` : ""}` +
            `${s.steps.some((x) => !x.accepted && !x.failed) ? `; never accepted: ${s.steps.filter((x) => !x.accepted && !x.failed).map((x) => x.step).join(", ")}` : ""}.`,
          ``,
        );
        const why = s.steps.flatMap((x) => [...new Set(x.errors ?? [])].map((e) => `- ${x.step}: ${e.length > 300 ? `${e.slice(0, 300)}…` : e}`));
        if (why.length) lines.push(`Why answers were sent back:`, ``, ...why.slice(0, 20), ...(why.length > 20 ? [`- and ${why.length - 20} more`] : []), ``);
      }
      const answered = pages(s.approvals);
      if (answered) lines.push(answered, ``);
      if (s.error) {
        lines.push(`The task failed: ${s.error}`, ``);
        continue;
      }
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
