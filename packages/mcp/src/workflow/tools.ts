// The workflow tools: workflow_start, workflow_step, workflow_submit and workflow_status.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowRun } from "@sf-agent-po/core";
import { z } from "zod";
import { INDUSTRY_IDS, resolveIndustry } from "../agents/industries.js";
import { OUTPUT_LANGUAGES, type OutputLanguage } from "../checks.js";
import { KeyedLock } from "../artifacts.js";
import type { Finding } from "../backlog.js";
import type { CallContext } from "../review.js";
import { briefText, currentStep, findingsText, MAX_ATTEMPTS, progressText, shapeFindings, stepsOf, type StepOutcome, type StepState, type WorkflowDefinition, type WorkflowKit } from "./engine.js";
import { WORKFLOW_DEFINITIONS } from "./steps.js";

type Text = { content: { type: "text"; text: string }[] };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });

export interface WorkflowToolsKit extends WorkflowKit {
  guard: <A extends { context?: string }>(fn: (args: A, call: CallContext) => Promise<Text>) => (args: A, call: CallContext) => Promise<Text & { isError?: boolean }>;
  contextName: z.ZodDefault<z.ZodString>;
}

type WorkflowId = keyof typeof WORKFLOW_DEFINITIONS;
const workflowArg = z.enum(Object.keys(WORKFLOW_DEFINITIONS) as [WorkflowId, ...WorkflowId[]]).describe(
  "sa_high_level_design, sa_detailed_design, po_backlog or po_review_stories.",
);

/** A run's step state for a call. */
function stateOf(kit: WorkflowKit, run: WorkflowRun, call: CallContext): StepState {
  const workflow = WORKFLOW_DEFINITIONS[run.workflow as WorkflowId];
  if (!workflow) throw new Error(`Run ${run.id} is of a workflow this version does not know (${run.workflow}).`);
  const { focus, industry } = run.options as { focus?: string; industry?: string };
  return { kit, run, context: run.context, workflow, call, ...(focus ? { focus } : {}), ...(industry ? { industry } : {}) };
}

/** Masks what goes back to the model or into the store: findings may quote what the agent wrote. */
async function maskFindings(kit: WorkflowKit, context: string, findings: readonly Finding[]): Promise<Finding[]> {
  if (!findings.length) return [];
  const { texts } = await kit.masker.maskOutputs(context, findings.flatMap((f) => [f.where, f.message]));
  return findings.map((f, i) => ({ level: f.level, where: texts[2 * i]!, message: texts[2 * i + 1]! }));
}

/** Parses an answer a host may send as a JSON string, encoded once or twice. */
function parseAnswer(answer: unknown): unknown {
  let value = answer;
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      break;
    }
  }
  return value;
}

/**
 * Checks the answer to the current step and records what came of it: passed or warned, sent
 * back with findings, or failed after the last attempt. Returns what the model reads next.
 */
export async function submitStep(kit: WorkflowKit, call: CallContext, run: WorkflowRun, stepId: string, answer: unknown): Promise<string> {
  const s = stateOf(kit, run, call);
  const steps = stepsOf(s.workflow, kit, run);
  const i = currentStep(run);
  if (i < 0) {
    // Every step is decided but the run was left open (a run from before runs ended themselves).
    kit.runs.finish(run.id, "done");
    return `Every step of run ${run.id} is done. Start a new run with workflow_start to do the work again.`;
  }
  const { def, state } = steps[i]!;
  if (stepId !== def.id) {
    const known = steps.some((x) => x.def.id === stepId);
    throw new Error(`${known ? `Step "${stepId}" is not the current one` : `There is no step "${stepId}" in this workflow`}: the current step is "${def.id}". Read it with workflow_step.`);
  }
  const parsed = def.schema.safeParse(parseAnswer(answer));
  const outcome: StepOutcome = parsed.success ? await def.submit(parsed.data, s) : { kind: "retry", attempt: true, findings: shapeFindings(parsed.error) };
  const findings = await maskFindings(kit, run.context, outcome.findings);
  // The step must still be as it was when the answer came in: another chat may have moved it.
  const expected = { status: state.status, attempts: state.attempts };
  const message = outcome.message ? `\n\n${(await kit.masker.maskOutputs(run.context, [outcome.message])).texts[0]}` : "";

  if (outcome.kind === "passed") {
    const warned = findings.some((f) => f.level === "warning");
    const summary = (await kit.masker.maskOutputs(run.context, [outcome.summary])).texts[0]!;
    const done = kit.runs.record(run.id, def.id, { status: warned ? "warned" : "passed", findings, summary, ...(outcome.saved !== undefined ? { answer: outcome.saved } : {}) }, expected);
    const lead = `Step "${def.id}" passed${warned ? " with warnings: tell the user about them" : ""}. ${summary}${findings.length ? `\n${findingsText(findings)}` : ""}${message}`;
    return briefText({ ...s, run: done }, lead);
  }

  const attempts = state.attempts + (outcome.attempt ? 1 : 0);
  if (outcome.attempt && attempts >= MAX_ATTEMPTS) {
    const done = kit.runs.record(run.id, def.id, { status: "failed", attempts, findings, summary: `Failed its checks ${attempts} times; saved with its findings for the user to look at.` }, expected);
    const lead = `Step "${def.id}" failed its checks ${attempts} times, so the run goes on without it. Tell the user what is still wrong:\n${findingsText(findings)}${message}`;
    return briefText({ ...s, run: done }, lead);
  }
  // A retry that does not count keeps the last attempt's findings: the brief shows them.
  kit.runs.record(run.id, def.id, { status: "pending", attempts, findings: outcome.attempt ? findings : state.findings }, expected);
  const left = MAX_ATTEMPTS - attempts;
  const head = outcome.attempt
    ? `Step "${def.id}" was sent back (attempt ${attempts} of ${MAX_ATTEMPTS}; ${left} left). Fix every ERROR, then submit the whole answer again.`
    : `Step "${def.id}" is still open; this did not count as an attempt.`;
  return `${head}${findings.length ? `\n${findingsText(findings)}` : ""}${message}`;
}

function openRun(kit: WorkflowKit, context: string, workflow: WorkflowId): WorkflowRun {
  const run = kit.runs.open(context, workflow);
  if (!run) throw new Error(`No ${workflow} run is open in context "${context}". Start one with workflow_start.`);
  return run;
}

export function registerWorkflowTools(server: McpServer, kit: WorkflowToolsKit): void {
  const { guard, contextName, runs } = kit;
  // Two starts at once would each close the other's run.
  const lock = new KeyedLock();

  server.registerTool(
    "workflow_start",
    {
      title: "Start a guided workflow",
      description:
        "Starts a Solution Architect or Product Owner workflow on a context, or resumes the open one, and returns the brief of its current step. " +
        "The server gives the steps one at a time and checks each answer (workflow_submit) before the next one. Use it for every design or backlog.",
      inputSchema: {
        context: contextName,
        workflow: workflowArg,
        focus: z.string().max(1_000).optional().describe("Optional focus or scope: an area, or the stories, epics or Jira keys in scope."),
        industry: z.string().optional().describe(`Optional industry template: ${INDUSTRY_IDS.join(", ")}.`),
        restart: z.boolean().optional().describe("Start over even if a run is open; the open run is closed."),
        language: z.enum(OUTPUT_LANGUAGES).optional().describe("The language to write in: en (English, the default) or fr (French). Kept with the context for every later run."),
      },
      annotations: { readOnlyHint: false },
    },
    guard(
      async (
        { context, workflow, focus, industry, restart, language }: { context: string; workflow: WorkflowId; focus?: string; industry?: string; restart?: boolean; language?: OutputLanguage },
        call,
      ) =>
      lock.run(`${context}/${workflow}`, async () => {
        if (language) kit.contexts.updateSettings(context, { language });
        const open = runs.open(context, workflow);
        if (open && !restart) {
          const changed = focus !== undefined || industry !== undefined ? " It keeps the focus and industry it was started with; set restart to true to change them." : "";
          return text(await briefText(stateOf(kit, open, call), `Resuming the open run, started ${open.createdAt}.${changed}`));
        }
        const known = industry ? resolveIndustry(industry) : undefined;
        if (industry && !known) throw new Error(`Unknown industry "${industry}". Use one of: ${INDUSTRY_IDS.join(", ")}.`);
        const maskedFocus = focus?.trim() ? (await kit.masker.maskOutputs(context, [focus.trim()])).texts[0] : undefined;
        const def: WorkflowDefinition = WORKFLOW_DEFINITIONS[workflow];
        const run = runs.start(context, workflow, def.steps(kit).map((d) => d.id), { ...(maskedFocus ? { focus: maskedFocus } : {}), ...(known ? { industry: known } : {}) });
        return text(await briefText(stateOf(kit, run, call), open ? `Started a new run; the open one (${open.id}) is closed.` : "Started a new run."));
      }),
    ),
  );

  server.registerTool(
    "workflow_step",
    {
      title: "Show the current step",
      description: "Returns the brief of the current step of the open workflow run again: what to produce, the answer's shape, the evidence to read and the rules.",
      inputSchema: { context: contextName, workflow: workflowArg },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ context, workflow }: { context: string; workflow: WorkflowId }, call) => text(await briefText(stateOf(kit, openRun(kit, context, workflow), call)))),
  );

  server.registerTool(
    "workflow_submit",
    {
      title: "Submit a step",
      description:
        "Submits the answer to the current step of the open workflow run. The server checks it: if it passes, it is saved and the next step's brief comes back; " +
        `if not, precise findings come back to fix and submit again. After ${MAX_ATTEMPTS} failed attempts the step is saved with its findings for the user, and the run goes on.`,
      inputSchema: {
        context: contextName,
        workflow: workflowArg,
        step: z.string().min(1).describe('The current step\'s id, as the brief names it, e.g. "requirements".'),
        answer: z.union([z.record(z.string(), z.unknown()), z.string()]).describe("The answer, in the shape the brief gives: a JSON object (or the same object as a JSON string)."),
      },
      annotations: { readOnlyHint: false },
    },
    // No lock: the user may take minutes on the page. The record checks the step did not move meanwhile.
    guard(async ({ context, workflow, step, answer }: { context: string; workflow: WorkflowId; step: string; answer: unknown }, call) =>
      text(await submitStep(kit, call, openRun(kit, context, workflow), step, answer)),
    ),
  );

  server.registerTool(
    "workflow_status",
    {
      title: "Workflow status",
      description: "Shows the workflow runs of a context: their steps, each step's status and what it produced, and the findings still open.",
      inputSchema: { context: contextName, workflow: workflowArg.optional() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ context, workflow }: { context: string; workflow?: WorkflowId }) => {
      const list = runs.list(context).filter((r) => !workflow || r.workflow === workflow).slice(0, 5);
      if (!list.length) return text(`No workflow run in context "${context}"${workflow ? ` for ${workflow}` : ""}. Start one with workflow_start.`);
      return text(
        list
          .map((r) => {
            const def = WORKFLOW_DEFINITIONS[r.workflow as WorkflowId];
            const titles = new Map((def ? def.steps(kit) : []).map((d) => [d.id, d.title]));
            const open = r.steps.filter((s) => s.findings.length && s.status !== "passed");
            const findings = open.map((s) => `Findings on ${s.step}:\n${findingsText(s.findings)}`).join("\n");
            return `Run ${r.id}: ${def?.title ?? r.workflow}, ${r.status}, started ${r.createdAt}, updated ${r.updatedAt}\n${progressText(r, titles)}${findings ? `\n${findings}` : ""}`;
          })
          .join("\n\n"),
      );
    }),
  );
}
