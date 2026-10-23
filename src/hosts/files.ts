import { EVIDENCE_RULES, PUBLISH_RULES } from "../agents/common.js";
import { INDUSTRY_IDS } from "../agents/industries.js";
import { PO_PRACTICES, PO_ROLE, poBacklogPrompt, poReviewStoriesPrompt } from "../agents/product-owner.js";
import { SA_PRINCIPLES, SA_ROLE, saDetailedDesignPrompt, saHighLevelDesignPrompt } from "../agents/solution-architect.js";

/**
 * Native agent files for each host, generated from the same text as the MCP
 * prompts so the two never drift apart. `sf-agent-po init` writes them into a
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
  agent: AgentDef;
  description: string;
  argumentHint: string;
  build: (contextText: string) => string;
}

interface AgentDef {
  id: string;
  name: string;
  description: string;
  body: string;
}

const INDUSTRY_NOTE = `## Industry templates

If the user names an industry, or the inputs make it clear, call the \`industry_guidance\` tool with one of: ${INDUSTRY_IDS.join(", ")}. Apply its guidance and confirm industry objects and features against the org before relying on them.`;

const SA_AGENT: AgentDef = {
  id: "salesforce-solution-architect",
  name: "Salesforce Solution Architect",
  description:
    "Salesforce Solution Architect. Use for high-level or detailed Salesforce solution designs built from meeting notes, emails, PI planning output, Jira, Confluence and the org's metadata, and for publishing designs to Confluence after approval.",
  body: `${SA_ROLE}

You work through the sf-agent-po MCP server. Inputs live in a named requirement context (\`context_show\`, \`context_read\`, and the \`context_add_*\` tools to add notes, emails, Jira issues, Confluence pages, a metadata repository or an org). You save designs with \`design_save\` and publish them with \`confluence_publish_preview\` and \`confluence_publish\`.

You produce two kinds of design: a **high-level design** from raw inputs (often the first deliverable, which the Product Owner then turns into a backlog), and a **detailed design** for stories or epics, fitted exactly to the existing metadata. Before you draft either, call the \`agent_workflow\` tool with \`workflow: "sa_high_level_design"\` or \`workflow: "sa_detailed_design"\`, the context name and the industry if one applies, and follow the steps and the template it returns.

${EVIDENCE_RULES}

${SA_PRINCIPLES}

${PUBLISH_RULES}

${INDUSTRY_NOTE}`,
};

const PO_AGENT: AgentDef = {
  id: "salesforce-product-owner",
  name: "Salesforce Product Owner",
  description:
    "Salesforce Product Owner. Use to turn requirements and the Solution Architect's design into epics and user stories with Given/When/Then acceptance criteria, to review Jira stories for readiness, and to publish backlogs to Jira and Confluence after approval.",
  body: `${PO_ROLE}

You work through the sf-agent-po MCP server. Inputs live in a named requirement context (\`context_show\`, \`context_read\`, and the \`context_add_*\` tools). When the Solution Architect has saved a design in the context, it is one of your inputs. You save backlogs with \`backlog_save\` (which runs a quality check), revise them with \`backlog_get\`, and publish with \`jira_publish_preview\` / \`jira_publish\` and \`confluence_publish_preview\` / \`confluence_publish\`.

Before you build a backlog or review stories, call the \`agent_workflow\` tool with \`workflow: "po_backlog"\` or \`workflow: "po_review_stories"\`, the context name and the industry if one applies, and follow the steps it returns.

${EVIDENCE_RULES}

${PO_PRACTICES}

${PUBLISH_RULES}

${INDUSTRY_NOTE}`,
};

const WORKFLOWS: Workflow[] = [
  {
    id: "sa-hld",
    agent: SA_AGENT,
    description: "Draft a high-level Salesforce solution design from the inputs in a requirement context.",
    argumentHint: "[context] [focus]",
    build: (contextText) => saHighLevelDesignPrompt({ contextText }),
  },
  {
    id: "sa-detailed",
    agent: SA_AGENT,
    description: "Draft a detailed design for stories or epics, fitted to the existing metadata.",
    argumentHint: "[context] [stories or epics in scope]",
    build: (contextText) => saDetailedDesignPrompt({ contextText }),
  },
  {
    id: "po-backlog",
    agent: PO_AGENT,
    description: "Build epics and user stories with acceptance criteria from a requirement context and the SA's design.",
    argumentHint: "[context] [scope]",
    build: (contextText) => poBacklogPrompt({ contextText }),
  },
  {
    id: "po-review",
    agent: PO_AGENT,
    description: "Review the Jira stories in a requirement context for readiness and propose rewrites and splits.",
    argumentHint: "[context] [Jira keys or epic]",
    build: (contextText) => poReviewStoriesPrompt({ contextText }),
  },
];

const AGENTS = [SA_AGENT, PO_AGENT];

const INDUSTRY_LINE = `If an industry applies, call \`industry_guidance\` (${INDUSTRY_IDS.join(", ")}) and apply it.`;

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
          content: frontmatter({ description: w.description, "argument-hint": w.argumentHint }) + w.build(contextText) + "\n",
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
        ...WORKFLOWS.map((w) => ({ path: `.cursor/commands/${w.id}.md`, content: w.build(contextText) + "\n" })),
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
          content: frontmatter({ description: w.description, "argument-hint": `context=<name> ${w.argumentHint.replace("[context] ", "")}`, agent: "agent" }) + w.build(contextText) + "\n",
        })),
      ];
    }
  }
}
