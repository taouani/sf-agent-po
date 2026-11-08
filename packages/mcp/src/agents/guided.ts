import { PRIVACY_RULES, PUBLISH_RULES, type PromptArgs, contextText } from "./common.js";
import { resolveIndustry } from "./industries.js";
import { PO_ROLE } from "./product-owner.js";
import { SA_ROLE } from "./solution-architect.js";

/** The agents' workflows the server guides step by step (workflow_start). */
export const GUIDED_WORKFLOWS = {
  sa_high_level_design: { role: SA_ROLE, task: "draft a **high-level Salesforce solution design** from the inputs in the context" },
  sa_detailed_design: { role: SA_ROLE, task: "draft a **detailed design** for stories or epics, fitted exactly to the existing metadata" },
  po_backlog: { role: PO_ROLE, task: "build a **backlog of epics and user stories** with acceptance criteria from the inputs in the context and the Solution Architect's design" },
  po_review_stories: { role: PO_ROLE, task: "**review the existing Jira stories** in the context for quality and readiness, and propose rewrites and splits" },
} as const;

export type GuidedWorkflow = keyof typeof GUIDED_WORKFLOWS;

/**
 * How the agents work with the server's guided workflows. The steps, the evidence to read, the
 * rules and the template come from the server, one step at a time, so this only says how to run
 * them. `workflow` is left out for an agent with several workflows. `focus` and `industry` are
 * given as the user wrote them; host files leave them out and say in the context sentence where
 * to find them.
 */
export function guidedHowTo(workflow: GuidedWorkflow | undefined, args: { focus?: string; industry?: string } = {}): string {
  const industry = args.industry ? (resolveIndustry(args.industry) ?? args.industry) : undefined;
  const params = [workflow ? `\`workflow: "${workflow}"\`` : "the workflow's id as `workflow`", "the context", ...(args.focus ? [`\`focus: ${JSON.stringify(args.focus)}\``] : []), ...(industry ? [`\`industry: ${JSON.stringify(industry)}\``] : [])];
  const list = `${params.slice(0, -1).join(", ")} and ${params.at(-1)}`;
  return `## How to work

The sf-agent-po server guides this work one step at a time, and checks each answer before it gives the next step.

1. Call \`workflow_start\` with ${list}.${args.focus || industry ? "" : " Pass the focus or scope the user gave as `focus`, and the industry if one applies as `industry`."} Add \`language: "fr"\` when the user wants the output in French. It returns the brief of the first step or, when a run was started earlier (in this chat or another one), of its current step.
2. Do what the brief asks: read the evidence it names, then send the answer, in the shape the brief gives, with \`workflow_submit\`.
3. When the answer comes back with findings, fix every ERROR and submit the whole answer again. Tell the user about every WARNING that stays.
4. Some steps open a page in the user's browser, for example to confirm the requirements. Tell the user to look at their browser before you submit such a step; the call waits for them.
5. Go on until the server says every step is done, then do what it says next.

Write each part when its step asks for it, not the whole document at once. \`workflow_step\` shows the current brief again, and \`workflow_status\` shows the runs and their steps.`;
}

/** The publishing rules, with the workflow doing the saving. */
const GUIDED_PUBLISH_RULES = PUBLISH_RULES.replace(
  /^- Save your work with the save tool.*$/m,
  "- The workflow saves your work as its steps pass, as a versioned draft in the context where the other agent can read it. Summarise it to the user once the last step is done.",
);

/** The text of an agent's workflow as an MCP prompt or a host command: start it with workflow_start. */
export function guidedPrompt(workflow: GuidedWorkflow, args: PromptArgs & { focus?: string } = {}): string {
  const w = GUIDED_WORKFLOWS[workflow];
  return `${w.role}

${contextText(args)}

Your task: ${w.task}.${args.focus ? `\n\nFocus: ${args.focus}` : ""}

${guidedHowTo(workflow, args)}

${PRIVACY_RULES}

${GUIDED_PUBLISH_RULES}`;
}
