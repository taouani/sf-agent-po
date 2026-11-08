import { PRIVACY_RULES, PUBLISH_RULES, type PromptArgs, contextText } from "./common.js";
import { INDUSTRY_IDS, resolveIndustry } from "./industries.js";
import { PO_ROLE } from "./product-owner.js";
import { SA_ROLE } from "./solution-architect.js";

/**
 * The agents' workflows the server guides step by step (workflow_start). `steps`: the workflow
 * writes its document in several checked steps and saves it at the last one; the stories review
 * is one step that ends with a backlog the agent saves itself with backlog_save. `settles`: what
 * the workflow's steps confirm with the user on a page.
 */
export const GUIDED_WORKFLOWS = {
  sa_high_level_design: { role: SA_ROLE, task: "draft a **high-level Salesforce solution design** from the inputs in the context", steps: true, settles: "the requirements and the scope" },
  sa_detailed_design: { role: SA_ROLE, task: "draft a **detailed design** for stories or epics, fitted exactly to the existing metadata", steps: true, settles: "the requirements and the scope" },
  po_backlog: { role: PO_ROLE, task: "build a **backlog of epics and user stories** with acceptance criteria from the inputs in the context and the Solution Architect's design", steps: true, settles: "the requirements" },
  po_review_stories: { role: PO_ROLE, task: "**review the existing Jira stories** in the context for quality and readiness, and propose rewrites and splits", steps: false, settles: "" },
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
  const industry = args.industry ? resolveIndustry(args.industry) : undefined;
  const params = [
    workflow ? `\`workflow: "${workflow}"\`` : "the workflow's id as `workflow`",
    "the context",
    // The focus as written may hold a backtick or a line break, so it is shown once, above.
    ...(args.focus ? ["the focus above as `focus`"] : []),
    ...(industry ? [`\`industry: "${industry}"\``] : []),
  ];
  const list = `${params.slice(0, -1).join(", ")} and ${params.at(-1)}`;
  const unknown =
    args.industry && !industry
      ? ` "${args.industry.replace(/[`"\s]+/g, " ").trim()}" is not one of the industry templates (${INDUSTRY_IDS.join(", ")}): ask the user whether one of them fits, and otherwise start without \`industry\`.`
      : "";
  const ask = args.focus || args.industry ? "" : " Pass the focus or scope the user gave as `focus`, and the industry if one applies as `industry`.";
  // The stories review is one step, with no requirements or scope to confirm.
  const steps = workflow ? GUIDED_WORKFLOWS[workflow].steps : true;
  const settles = workflow ? GUIDED_WORKFLOWS[workflow].settles : "the requirements and, for a design, the scope";
  const which = workflow ? "The workflow's steps" : "In the design and backlog workflows, the steps";
  const items = [
    `Call \`workflow_start\` with ${list}.${unknown}${ask} When the user names the output language, add \`language\` (\`en\` or \`fr\`); it stays with the context. It returns the brief of the first step or, when a run was started earlier (in this chat or another one), of its current step.`,
    "Do what the brief asks: read the evidence it names, then send the answer, in the shape the brief gives, with `workflow_submit`.",
    "When the answer comes back with findings, fix every ERROR and submit the whole answer again. Tell the user about every WARNING that stays.",
    ...(steps ? [`Some steps open a page in the user's browser, to confirm ${settles}. Tell the user to look at their browser before you submit such a step; the call waits for them.`] : []),
    "Go on until the server says every step is done, then do what it says next.",
  ];
  return `## How to work

The sf-agent-po server guides this work and checks each answer${steps ? " before it gives the next step" : ""}.

${items.map((x, i) => `${i + 1}. ${x}`).join("\n")}

${steps ? `${which} settle ${settles}, and write the document part by part: do not propose them, or draft the whole document, before the step that asks for it. ` : ""}\`workflow_step\` shows the current brief again, and \`workflow_status\` shows the runs and their steps.`;
}

const SAVE_RULE = /^- Save your work with the save tool.*$/m;

/** The publishing rules, with the workflow doing the saving. Without `workflow`, for an agent with several workflows. */
export function guidedPublishRules(workflow?: GuidedWorkflow): string {
  const tool = workflow === "po_backlog" ? "`backlog_save`" : workflow ? "`design_save`" : "`backlog_save` for a backlog or `design_save` for a design";
  const revise = `Save a revision the user asks for after the run with ${tool}, or start the workflow again with \`restart: true\` when the change is large.`;
  const save =
    workflow === "po_review_stories"
      ? "- The review step tells you when to save the improved stories with `backlog_save`, which keeps a versioned draft in the context where the other agent can read it. Save them before you summarise them to the user."
      : workflow
        ? `- The workflow saves the document when its last step passes, as a versioned draft in the context where the other agent can read it; summarise it to the user then. ${revise}`
        : `- The design and backlog workflows save the document when their last step passes, as a versioned draft in the context where the other agent can read it; in the stories review, the step tells you when to save with \`backlog_save\`. ${revise}`;
  return PUBLISH_RULES.replace(SAVE_RULE, save);
}

/** The text of an agent's workflow as an MCP prompt or a host command: start it with workflow_start. */
export function guidedPrompt(workflow: GuidedWorkflow, args: PromptArgs & { focus?: string } = {}): string {
  const w = GUIDED_WORKFLOWS[workflow];
  return `${w.role}

${contextText(args)}

Your task: ${w.task}.${args.focus ? `\n\nFocus: ${args.focus}` : ""}

${guidedHowTo(workflow, args)}

${PRIVACY_RULES}

${guidedPublishRules(workflow)}`;
}
