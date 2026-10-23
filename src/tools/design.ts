import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ArtifactMeta, saveArtifact } from "../artifacts/artifacts.js";
import { saDetailedDesignPrompt, saHighLevelDesignPrompt } from "../agents/solution-architect.js";
import { type Deps, contextName, guard, industryArg, text } from "./shared.js";

/** The Solution Architect: design prompts and the tool that saves designs. */
export function registerDesignTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "design_save",
    {
      title: "Save design",
      description:
        "Saves a solution design (Markdown) as a versioned draft in the requirement context, where the Product Owner agent can read it. " +
        "Saving again with the same title creates a new version of the same design.",
      inputSchema: {
        context: contextName,
        title: z.string().min(3).describe('Design title, e.g. "Policy renewal portal: high-level design".'),
        designType: z.enum(["high-level", "detailed"]),
        content: z.string().min(1).describe("The full design in Markdown."),
        sourceIds: z.array(z.string()).optional().describe("Ids of the context documents the design is based on."),
      },
    },
    guard(async ({ context, title, designType, content, sourceIds }) => {
      const doc = await saveArtifact(deps.store, context, { kind: "design", title, content, artifactType: designType, sourceIds });
      const meta = doc.metadata as ArtifactMeta;
      const published = meta.confluence ? ` It was published to ${meta.confluence.url} (status: ${meta.status}).` : "";
      return text(`Saved ${designType} design "${title}" as ${doc.id}, version ${meta.version}.${published}`);
    }),
  );

  const contextArg = z.string().optional().describe('Requirement context name (default "default").');

  server.registerPrompt(
    "sa_high_level_design",
    {
      title: "Solution Architect: high-level design",
      description: "Draft a high-level Salesforce solution design from the inputs in a requirement context.",
      argsSchema: { context: contextArg, focus: z.string().optional().describe("Optional area to focus on."), industry: industryArg },
    },
    ({ context, focus, industry }) => userPrompt(saHighLevelDesignPrompt({ context, focus, industry: industry || undefined })),
  );

  server.registerPrompt(
    "sa_detailed_design",
    {
      title: "Solution Architect: detailed design",
      description: "Draft a detailed design for stories or epics, fitted to the existing metadata.",
      argsSchema: { context: contextArg, scope: z.string().optional().describe("Stories, epics or Jira keys in scope."), industry: industryArg },
    },
    ({ context, scope, industry }) => userPrompt(saDetailedDesignPrompt({ context, scope, industry: industry || undefined })),
  );
}

export function userPrompt(body: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text: body } }] };
}
