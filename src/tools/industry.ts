import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { INDUSTRY_IDS, industryGuidance, resolveIndustry } from "../agents/industries.js";
import { poBacklogPrompt, poReviewStoriesPrompt } from "../agents/product-owner.js";
import { saDetailedDesignPrompt, saHighLevelDesignPrompt } from "../agents/solution-architect.js";
import { contextName, guard, text } from "./shared.js";

const WORKFLOWS = {
  sa_high_level_design: (a: WorkflowArgs) => saHighLevelDesignPrompt({ context: a.context, focus: a.focus, industry: a.industry }),
  sa_detailed_design: (a: WorkflowArgs) => saDetailedDesignPrompt({ context: a.context, scope: a.focus, industry: a.industry }),
  po_backlog: (a: WorkflowArgs) => poBacklogPrompt({ context: a.context, scope: a.focus, industry: a.industry }),
  po_review_stories: (a: WorkflowArgs) => poReviewStoriesPrompt({ context: a.context, scope: a.focus, industry: a.industry }),
};

type WorkflowArgs = { context: string; focus?: string; industry?: string };

/**
 * Industry templates and the agents' workflows as tools, for hosts that use
 * the agent files: a model cannot start an MCP prompt itself, but it can call
 * a tool to get the same steps and templates.
 */
export function registerIndustryTools(server: McpServer): void {
  server.registerTool(
    "industry_guidance",
    {
      title: "Industry guidance",
      description: `Returns Salesforce guidance for an industry: products, data model, regulation, integrations and pitfalls. Industries: ${INDUSTRY_IDS.join(", ")}.`,
      inputSchema: { industry: z.string().describe(`One of: ${INDUSTRY_IDS.join(", ")}. Common names such as "banking" or "healthcare" also work.`) },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ industry }) => {
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
        workflow: z.enum(Object.keys(WORKFLOWS) as [keyof typeof WORKFLOWS]),
        context: contextName,
        focus: z.string().optional().describe("Optional focus or scope: an area, or the stories, epics or Jira keys in scope."),
        industry: z.string().optional().describe(`Optional industry template: ${INDUSTRY_IDS.join(", ")}.`),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ workflow, ...args }) => text(WORKFLOWS[workflow](args))),
  );
}
