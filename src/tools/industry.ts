import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { INDUSTRY_IDS, industryGuidance } from "../agents/industries.js";
import { guard, text } from "./shared.js";

/** Industry templates as a tool, for hosts that use the agent files rather than the MCP prompts. */
export function registerIndustryTools(server: McpServer): void {
  server.registerTool(
    "industry_guidance",
    {
      title: "Industry guidance",
      description: `Returns Salesforce guidance for an industry: products, data model, regulation, integrations and pitfalls. Industries: ${INDUSTRY_IDS.join(", ")}.`,
      inputSchema: { industry: z.enum(INDUSTRY_IDS as [string, ...string[]]) },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ industry }) => text(industryGuidance(industry))),
  );
}
