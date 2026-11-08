// The step engine (phase 4): a workflow is a list of steps the server gives the model one at a
// time. Each answer is checked by code against the step's shape and rules: errors send the
// step back with precise findings, warnings pass and stay visible. After three failed attempts
// the step is saved with its findings for the user to look at, so a run never loops forever.
// A run's state is on disk, so it can be resumed in a new chat.

import type { ContextRepository, Masker, MetadataIndex, RequirementRepository, StepFinding, WorkflowRepository, WorkflowRun, WorkflowStep } from "@sf-agent-po/core";
import type { z } from "zod";
import type { Finding } from "../backlog.js";
import { contextLanguage, LANGUAGE_NAMES } from "../checks.js";
import type { Reviewer } from "../inputs.js";
import type { CallContext } from "../review.js";

/** Attempts a step gets before it is saved as failed and the run goes on. */
export const MAX_ATTEMPTS = 3;

export interface WorkflowKit {
  contexts: ContextRepository;
  masker: Masker;
  requirements: RequirementRepository;
  runs: WorkflowRepository;
  reviewerFor: (call: CallContext) => Reviewer;
  /** The metadata index: design workflows get a scope step when it is there. */
  index?: MetadataIndex;
}

/** What a step sees: the run, the options it was started with, and how to reach the user. */
export interface StepState {
  kit: WorkflowKit;
  run: WorkflowRun;
  context: string;
  workflow: WorkflowDefinition;
  /** The focus the run was started with, masked. */
  focus?: string;
  industry?: string;
  call: CallContext;
}

export type StepOutcome =
  /** The answer is accepted: `saved` (masked) is kept with the step. */
  | { kind: "passed"; findings: Finding[]; summary: string; saved?: unknown; message?: string }
  /** The answer is sent back. `attempt` is false when it was not the model's doing (the user closed the page). */
  | { kind: "retry"; findings: Finding[]; attempt: boolean; message?: string }
  /**
   * The answer is accepted, but the step needs more answers (the stories of the next epic):
   * `saved` (masked) replaces what the step holds, its attempts start again, and it stays open.
   */
  | { kind: "progress"; findings: Finding[]; saved: unknown; message: string };

export interface StepDefinition<A = unknown> {
  id: string;
  title: string;
  /** The answer's JSON shape, as the brief shows it. */
  shape: string;
  schema: z.ZodType<A>;
  /** What to produce, the evidence to read and the rules: masked. */
  brief(s: StepState): Promise<string> | string;
  submit(answer: A, s: StepState): Promise<StepOutcome>;
}

export interface WorkflowDefinition {
  id: string;
  title: string;
  /** What the run ends with, for the model to offer next. */
  next: string;
  steps(kit: WorkflowKit): StepDefinition[];
  /** Steps a run may hold that `steps` leaves out with this kit (the scope step without metadata). */
  optional?: StepDefinition[];
}

const SYMBOL = { passed: "done", warned: "done, with warnings", failed: "FAILED after the last attempt; the user should look at it", pending: "to do" } as const;

/** The steps of a run, by their definitions; a run started by another version may name steps this one lacks. */
export function stepsOf(workflow: WorkflowDefinition, kit: WorkflowKit, run: WorkflowRun): { def: StepDefinition; state: WorkflowStep }[] {
  const defs = new Map([...(workflow.optional ?? []), ...workflow.steps(kit)].map((d) => [d.id, d]));
  return run.steps.map((state) => {
    const def = defs.get(state.step);
    if (!def) throw new Error(`Run ${run.id} has a step "${state.step}" this version does not know. Start the workflow again with restart set to true.`);
    return { def, state };
  });
}

export const currentStep = (run: WorkflowRun) => run.steps.findIndex((s) => s.status === "pending");

export function findingsText(findings: readonly StepFinding[]): string {
  const order = { error: 0, warning: 1, info: 2 } as const;
  return [...findings]
    .sort((a, b) => order[a.level] - order[b.level])
    .map((f) => `- ${f.level.toUpperCase()} [${f.where}] ${f.message}`)
    .join("\n");
}

/** The run's progress: each step with its status and what it produced. */
export function progressText(run: WorkflowRun, titles: ReadonlyMap<string, string>): string {
  return run.steps
    .map((s, i) => {
      const tries = s.status === "pending" && s.attempts ? `, ${s.attempts} failed attempt(s)` : "";
      return `${i + 1}. ${titles.get(s.step) ?? s.step} (${s.step}): ${SYMBOL[s.status]}${tries}${s.summary ? `. ${s.summary}` : ""}`;
    })
    .join("\n");
}

/** The brief of the run's current step, or what to do once every step is done. */
export async function briefText(s: Omit<StepState, "run"> & { run: WorkflowRun }, lead = ""): Promise<string> {
  const steps = stepsOf(s.workflow, s.kit, s.run);
  const titles = new Map(steps.map((x) => [x.def.id, x.def.title]));
  const language = LANGUAGE_NAMES[contextLanguage(s.kit.contexts, s.context)];
  const header =
    `${lead}${lead ? "\n\n" : ""}Workflow: ${s.workflow.title} · context "${s.context}" · run ${s.run.id}${s.focus ? `\nFocus: ${s.focus}` : ""}\n` +
    `Output language: ${language}. Write every requirement, design section and story in ${language}, whatever the inputs' language; keep API names, ids and pseudonyms as they are.`;
  const i = currentStep(s.run);
  if (i < 0) {
    const failed = s.run.steps.filter((x) => x.status === "failed").length;
    return `${header}\n\nEvery step is done:\n${progressText(s.run, titles)}\n\n${failed ? `${failed} step(s) failed their checks: tell the user which, and why, before going on. ` : ""}${s.workflow.next}`;
  }
  const { def, state } = steps[i]!;
  const done = i ? `\n\nSteps so far:\n${progressText({ ...s.run, steps: s.run.steps.slice(0, i) }, titles)}` : "";
  const retry = state.attempts ? `\n\nAttempt ${state.attempts + 1} of ${MAX_ATTEMPTS}. The last answer was sent back:\n${findingsText(state.findings)}` : "";
  return (
    `${header}\nStep ${i + 1} of ${steps.length}: ${def.title}${done}${retry}\n\n${await def.brief(s)}\n\n` +
    `Answer shape:\n${def.shape}\n\n` +
    `Submit it with workflow_submit (context "${s.context}", workflow "${s.workflow.id}", step "${def.id}", answer as above). Keep pseudonyms such as [PERSON_1] as they are.`
  );
}

type Issue = { code: string; path: PropertyKey[]; message: string; errors?: Issue[][] };

/**
 * The issues of an answer, with each union (one answer shape or another) narrowed to the shape
 * the answer was closest to: the one with no unknown key, then the fewest issues.
 */
function flatIssues(issues: readonly Issue[], prefix: PropertyKey[] = []): { path: PropertyKey[]; message: string }[] {
  return issues.flatMap((i) => {
    const path = [...prefix, ...i.path];
    if (i.code !== "invalid_union" || !i.errors?.length) return [{ path, message: i.message }];
    const score = (branch: Issue[]) => branch.filter((b) => b.code === "unrecognized_keys").length * 1_000 + branch.length;
    const closest = [...i.errors].sort((a, b) => score(a) - score(b))[0]!;
    return flatIssues(closest, path);
  });
}

/** Zod's complaints as findings: where in the answer, and what is wrong. Never the values. */
export function shapeFindings(error: z.ZodError): Finding[] {
  return flatIssues(error.issues as unknown as Issue[])
    .slice(0, 30)
    .map((i) => ({ level: "error", where: i.path.length ? i.path.map(String).join(".") : "answer", message: i.message }));
}
