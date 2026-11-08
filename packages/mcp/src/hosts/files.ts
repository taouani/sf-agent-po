import { EVIDENCE_RULES, PRIVACY_RULES } from "../agents/common.js";
import { type GuidedWorkflow, guidedHowTo, guidedPrompt, guidedPublishRules } from "../agents/guided.js";
import { INDUSTRY_IDS } from "../agents/industries.js";
import { PO_PRACTICES, PO_ROLE } from "../agents/product-owner.js";
import { SA_PRINCIPLES, SA_ROLE } from "../agents/solution-architect.js";

/**
 * Native agent files for each host, generated from the same text as the MCP
 * prompts so the two never drift apart. `npx sf-agent-po@next init` writes them into a
 * project; they all rely on the sf-agent-po MCP server being configured.
 */
export const HOSTS = ["claude-code", "cursor", "copilot"] as const;
export type Host = (typeof HOSTS)[number];

export interface HostFile {
  path: string;
  content: string;
  /** Not written when this other file is present or written in the same run, because the host would load both. */
  unlessPresent?: { path: string; reason: string };
}

interface Workflow {
  id: string;
  /** The server's workflow the command starts. */
  workflow: GuidedWorkflow;
  agent: AgentDef;
  description: string;
  argumentHint: string;
}

interface AgentDef {
  id: string;
  name: string;
  description: string;
  body: string;
}

const INDUSTRY_NOTE = `## Industry templates

If the user names an industry, or the inputs make it clear, pass it as \`industry\` to \`workflow_start\` (one of: ${INDUSTRY_IDS.join(", ")}): the steps then carry its guidance. Outside a workflow, the \`industry_guidance\` tool returns the same guidance. Confirm industry objects and features against the org before relying on them.`;

const SA_AGENT: AgentDef = {
  id: "salesforce-solution-architect",
  name: "Salesforce Solution Architect",
  description:
    "Salesforce Solution Architect. Use for high-level or detailed Salesforce solution designs built from meeting notes, emails, PI planning output, Jira, Confluence and the org's metadata, and for publishing designs to Confluence after approval.",
  body: `${SA_ROLE}

You work through the sf-agent-po MCP server. Inputs live in a named requirement context, masked (\`context_show\`, \`context_read\`, and the \`context_add_*\` tools to add files, notes, Jira issues and Confluence pages). The existing org is in the metadata index (\`metadata_summary\`, \`metadata_search\`, \`metadata_component\`), the scope the user confirmed for the work is in \`scope_show\` (\`scope_propose\` to set it), and \`metadata_impact\` lists what depends on the components you change.

You produce two kinds of design: a **high-level design** from raw inputs (often the first deliverable, which the Product Owner then turns into a backlog), and a **detailed design** for stories or epics, fitted exactly to the existing metadata. The server guides both, one section at a time, with the workflows \`sa_high_level_design\` and \`sa_detailed_design\`, and saves the design when the last step passes. \`trace_show\` shows which confirmed requirements a design covers, and \`confluence_publish\` publishes it, with its traceability matrix, after the user approves it in their browser.

${guidedHowTo(undefined)}

${EVIDENCE_RULES}

${PRIVACY_RULES}

${SA_PRINCIPLES}

${guidedPublishRules()}

${INDUSTRY_NOTE}`,
};

const PO_AGENT: AgentDef = {
  id: "salesforce-product-owner",
  name: "Salesforce Product Owner",
  description:
    "Salesforce Product Owner. Use to turn requirements and the Solution Architect's design into epics and user stories with Given/When/Then acceptance criteria, to review Jira stories for readiness, and to publish backlogs to Jira and Confluence after approval.",
  body: `${PO_ROLE}

You work through the sf-agent-po MCP server. Inputs live in a named requirement context, masked (\`context_show\`, \`context_read\`, and the \`context_add_*\` tools). The existing org is in the metadata index (\`metadata_summary\`, \`metadata_search\`, \`metadata_component\`), the scope the user confirmed for the work is in \`scope_show\` (\`scope_propose\` to set it), and \`metadata_impact\` lists what depends on the components you change. When the Solution Architect has saved a design in the context, it is one of your inputs.

The server guides your work with the workflows \`po_backlog\` (the requirements, then the epics, then the stories one epic at a time, then the whole backlog, which it saves) and \`po_review_stories\`. \`backlog_get\` returns a saved backlog. \`backlog_save\` saves the stories of a review, and a revision the user asks for after a run, with the same quality check. \`trace_show\` shows which confirmed requirements the stories deliver. You publish with \`jira_publish\` (with the sub-tasks of the detailed design) and \`confluence_publish\`, which wait for the user's approval in their browser.

${guidedHowTo(undefined)}

${EVIDENCE_RULES}

${PRIVACY_RULES}

${PO_PRACTICES}

${guidedPublishRules()}

${INDUSTRY_NOTE}`,
};

const WORKFLOWS: Workflow[] = [
  {
    id: "sa-hld",
    workflow: "sa_high_level_design",
    agent: SA_AGENT,
    description: "Draft a high-level Salesforce solution design from the inputs in a requirement context.",
    argumentHint: "[context] [focus]",
  },
  {
    id: "sa-detailed",
    workflow: "sa_detailed_design",
    agent: SA_AGENT,
    description: "Draft a detailed design for stories or epics, fitted to the existing metadata.",
    argumentHint: "[context] [stories or epics in scope]",
  },
  {
    id: "po-backlog",
    workflow: "po_backlog",
    agent: PO_AGENT,
    description: "Build epics and user stories with acceptance criteria from a requirement context and the SA's design.",
    argumentHint: "[context] [scope]",
  },
  {
    id: "po-review",
    workflow: "po_review_stories",
    agent: PO_AGENT,
    description: "Review the Jira stories in a requirement context for readiness and propose rewrites and splits.",
    argumentHint: "[context] [Jira keys or epic]",
  },
];

const AGENTS = [SA_AGENT, PO_AGENT];

const INDUSTRY_LINE = `The industry templates are: ${INDUSTRY_IDS.join(", ")}.`;

function frontmatter(fields: Record<string, string | boolean | undefined>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

export function hostFiles(host: Host): HostFile[] {
  switch (host) {
    case "claude-code": {
      const contextText = `The requirement context to work from is the first word of "$ARGUMENTS" (use "default" if it is empty); any further text is extra scope or focus. Pass \`context: "<that name>"\` to every sf-agent-po tool call. ${INDUSTRY_LINE}`;
      return [
        ...AGENTS.map((a) => ({ path: `.claude/agents/${a.id}.md`, content: frontmatter({ name: a.id, description: a.description }) + a.body + "\n" })),
        ...WORKFLOWS.map((w) => ({
          path: `.claude/commands/${w.id}.md`,
          content: frontmatter({ description: w.description, "argument-hint": w.argumentHint }) + guidedPrompt(w.workflow, { contextText }) + "\n",
        })),
      ];
    }
    case "cursor": {
      const contextText = `The requirement context to work from is the one the user named with this command or in their message; any further text is extra scope or focus. If they named none, call \`context_list\` and ask which to use (use "default" when it is the only one). Pass \`context: "<that name>"\` to every sf-agent-po tool call. ${INDUSTRY_LINE}`;
      return [
        ...AGENTS.map((a) => ({
          path: `.cursor/rules/${a.id}.mdc`,
          content: `---\ndescription: ${a.description}\nglobs:\nalwaysApply: false\n---\n\n${a.body}\n`,
        })),
        ...WORKFLOWS.map((w) => ({ path: `.cursor/commands/${w.id}.md`, content: guidedPrompt(w.workflow, { contextText }) + "\n" })),
      ];
    }
    case "copilot": {
      const contextText = `The requirement context to work from is "\${input:context:default}" (if the user wrote context=<name> with the command, use that name); any further text is extra scope or focus. Pass that name as \`context\` to every sf-agent-po tool call. ${INDUSTRY_LINE}`;
      return [
        ...AGENTS.map((a) => ({
          path: `.github/agents/${a.id}.agent.md`,
          // vscode: the Copilot agent on github.com also reads .github/agents, but cannot reach a local MCP server.
          content: frontmatter({ name: a.name, description: a.description, target: "vscode" }) + a.body + "\n",
          unlessPresent: {
            path: `.claude/agents/${a.id}.md`,
            reason: "VS Code already loads the Claude Code agent file, so Copilot would list the agent twice",
          },
        })),
        ...WORKFLOWS.map((w) => ({
          path: `.github/prompts/${w.id}.prompt.md`,
          content: frontmatter({ description: w.description, "argument-hint": `context=<name> ${w.argumentHint.replace("[context] ", "")}`, agent: "agent" }) + guidedPrompt(w.workflow, { contextText }) + "\n",
        })),
      ];
    }
  }
}
