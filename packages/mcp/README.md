# sf-agent-po (pre-release)

Salesforce Solution Architect and Product Owner agents for Claude Code, Cursor and GitHub
Copilot, served over MCP. They turn meeting notes, emails, Jira issues and Confluence pages
into high-level and detailed designs and into backlogs of epics and stories, and publish them
to Confluence and Jira.

Personal data and secrets in the inputs are masked before any model sees them: the agents
work with pseudonyms such as `[PERSON_1]`. The real values are put back only when you approve
a publish, on a page the server opens in your browser, which shows exactly what will be
written. Secrets are never put back.

This is a pre-release of version 1 (`next`). Expect changes before 1.0.

## Use

Requires Node.js 24 or later.

Add the server to your AI tool's MCP configuration, with the command
`npx -y sf-agent-po@next`. For Jira and Confluence, set `ATLASSIAN_SITE_URL`,
`ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN` in the server's environment.

To add the agent files for your tool to a project:

```bash
npx -y sf-agent-po@next init --host claude-code   # or cursor, copilot, all
```

The workspace (one SQLite database per project, in `.sf-agent`, or `SF_AGENT_WORKSPACE`)
holds the masked inputs and the agents' work. Its masking key is kept in your OS keychain,
or in a key file when no keychain is available. Back it up: without it, nothing can be
unmasked.

The name detection model (about 140 MB) is downloaded on first use, pinned and checked.

Source, documentation and issues: https://github.com/taouani/sf-agent-po
