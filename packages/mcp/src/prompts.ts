// The Solution Architect and Product Owner agents: their workflows as MCP prompts, and as a
// tool for hosts that use agent files (a model cannot start an MCP prompt itself, but it can
// call a tool to get the same steps and templates), with the industry templates.

import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { INDUSTRY_IDS, industryGuidance, resolveIndustry } from "./agents/industries.js";
import { poBacklogPrompt, poReviewStoriesPrompt } from "./agents/product-owner.js";
import { saDetailedDesignPrompt, saHighLevelDesignPrompt } from "./agents/solution-architect.js";
import type { PublishKit } from "./publish.js";

type WorkflowArgs = { context: string; focus?: string; industry?: string };

export const WORKFLOWS = {
  sa_high_level_design: {
    title: "Solution Architect: high-level design",
    description: "Draft a high-level Salesforce solution design from the inputs in a requirement context.",
    arg: "focus",
    focus: "Optional area to focus on.",
    text: (a: WorkflowArgs) => saHighLevelDesignPrompt({ context: a.context, focus: a.focus, industry: a.industry }),
  },
  sa_detailed_design: {
    title: "Solution Architect: detailed design",
    description: "Draft a detailed design for stories or epics, fitted to the existing metadata.",
    arg: "scope",
    focus: "Stories, epics or Jira keys in scope.",
    text: (a: WorkflowArgs) => saDetailedDesignPrompt({ context: a.context, scope: a.focus, industry: a.industry }),
  },
  po_backlog: {
    title: "Product Owner: build the backlog",
    description: "Turn the inputs in a requirement context (and the SA's design, if any) into epics and user stories with acceptance criteria.",
    arg: "scope",
    focus: "Optional scope, e.g. a capability or release.",
    text: (a: WorkflowArgs) => poBacklogPrompt({ context: a.context, scope: a.focus, industry: a.industry }),
  },
  po_review_stories: {
    title: "Product Owner: review Jira stories",
    description: "Review the Jira stories in a requirement context for readiness and propose rewrites and splits.",
    arg: "scope",
    focus: "Optional subset, e.g. Jira keys or an epic.",
    text: (a: WorkflowArgs) => poReviewStoriesPrompt({ context: a.context, scope: a.focus, industry: a.industry }),
  },
} as const;

type Workflow = keyof typeof WORKFLOWS;

const completeIndustry = (value: string | undefined) => INDUSTRY_IDS.filter((id) => id.startsWith((value ?? "").trim().toLowerCase()));

/**
 * Prompt argument for an industry template, with completion of the known ids. The SDK looks
 * for the completer inside the optional wrapper when it enables completions, but on the
 * wrapper itself when it answers a completion request, so both carry it.
 */
const industryArg = () =>
  completable(completable(z.string(), completeIndustry).optional().describe(`Optional industry template: ${INDUSTRY_IDS.join(", ")}.`), completeIndustry);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function registerAgentPrompts(server: McpServer, kit: Pick<PublishKit, "guard" | "contextName">): void {
  const { guard, contextName } = kit;
  // The name goes into the instructions, so it must be one the tools take.
  const contextArg = z
    .string()
    .regex(/^[\w.-]+$/, "use letters, digits, '.', '-' or '_'")
    .optional()
    .describe('Requirement context name (default "default").');

  for (const [name, w] of Object.entries(WORKFLOWS) as [Workflow, (typeof WORKFLOWS)[Workflow]][]) {
    server.registerPrompt(
      name,
      // The second argument keeps its 0.x name: "focus" for the high-level design, "scope" for the others.
      { title: w.title, description: w.description, argsSchema: { context: contextArg, [w.arg]: z.string().optional().describe(w.focus), industry: industryArg() } },
      (args: Record<string, string | undefined>) => ({
        messages: [
          { role: "user" as const, content: { type: "text" as const, text: w.text({ context: args.context || "default", focus: args[w.arg] || undefined, industry: args.industry || undefined }) } },
        ],
      }),
    );
  }

  server.registerTool(
    "industry_guidance",
    {
      title: "Industry guidance",
      description: `Returns Salesforce guidance for an industry: products, data model, regulation, integrations and pitfalls. Industries: ${INDUSTRY_IDS.join(", ")}.`,
      inputSchema: { industry: z.string().describe(`One of: ${INDUSTRY_IDS.join(", ")}. Common names such as "banking" or "healthcare" also work.`) },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ industry }: { industry: string; context?: string }) => {
      if (!resolveIndustry(industry)) throw new Error(`Unknown industry "${industry}". Use one of: ${INDUSTRY_IDS.join(", ")}.`);
      return text(industryGuidance(industry));
    }),
  );

  server.registerTool(
    "agent_workflow",
    {
      title: "Agent workflow",
      description:
        "Returns the full method for a Solution Architect or Product Owner task: the steps, the rules and the document template. " +
        "Call it before drafting a design or a backlog, and follow what it returns. The text is the same as the MCP prompt of the same name.",
      inputSchema: {
        workflow: z.enum(Object.keys(WORKFLOWS) as [Workflow, ...Workflow[]]),
        context: contextName,
        focus: z.string().optional().describe("Optional focus or scope: an area, or the stories, epics or Jira keys in scope."),
        industry: z.string().optional().describe(`Optional industry template: ${INDUSTRY_IDS.join(", ")}.`),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ workflow, ...args }: WorkflowArgs & { workflow: Workflow }) => text(WORKFLOWS[workflow].text(args))),
  );
}
