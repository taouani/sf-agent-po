# sf-agent-po

An MCP server that gives Claude Code, Cursor and GitHub Copilot a Salesforce **Solution Architect** and **Product Owner** workflow.

The host's own model does the reasoning. This server supplies:

- a **requirement context** assembled from meeting notes, emails, PI planning output, Jira, Confluence, a metadata repository and a Salesforce org;
- the **agent workflows** as MCP prompts, with Salesforce architecture and product practice built in;
- **artifacts** (designs, backlogs) saved as versioned drafts in the same context, so the agents can run in either order: the Solution Architect's high-level design feeds the Product Owner, or the PO's stories feed the SA's detailed design;
- **publishing** to Confluence (and Jira, in step 3) that only runs after the user approves a preview.

## Status

| Step | Scope | State |
| --- | --- | --- |
| 1 | Shared core: requirement context, input loaders, metadata sources, org/Jira/Confluence readers | Done |
| 2 | SA agent: high-level design from raw inputs, detailed design from stories, published to Confluence | Done |
| 3 | PO agent: epics and stories with acceptance criteria, published to Jira after review | Next |
| 4 | Per-host packaging (Claude Code, Cursor, Copilot), test set, industry templates | Planned |

## Tools

| Tool | What it does |
| --- | --- |
| `context_add_file` | Adds local files or a whole folder: meeting notes, `.eml` emails, PI planning exports, Markdown, HTML, text |
| `context_add_text` | Adds text pasted into the chat, such as an email or a high-level design |
| `context_add_jira` | Adds Jira Cloud issues by key or JQL |
| `context_add_confluence` | Adds Confluence Cloud pages by id or URL (short `/x/` links are not supported) |
| `context_add_metadata` | Scans a Salesforce DX repo and adds an inventory of objects, fields, flows, Apex, triggers, LWC and permission sets |
| `context_add_org` | Reads an org through the `sf` CLI: custom objects plus field detail for chosen objects (read-only) |
| `context_show` / `context_read` | Lists a context's documents, or returns their full text filtered by id or kind |
| `context_list` / `context_remove_document` | Housekeeping |
| `design_save` | Saves a high-level or detailed design (Markdown) as a versioned artifact in the context |
| `confluence_publish_preview` | Shows what would be written to Confluence for an artifact and returns an approval token |
| `confluence_publish` | Creates or updates the page, only with a token from a matching preview |

Every tool takes a `context` name (default `default`), so you can keep one context per feature or epic. Contexts are saved as JSON under the workspace folder, so they persist between sessions and are shared by every host pointed at the same workspace. Re-adding a source replaces the earlier copy.

## Agent workflows (MCP prompts)

| Prompt | Agent | What it does |
| --- | --- | --- |
| `sa_high_level_design` | Solution Architect | Drafts a high-level design from raw inputs: scope, personas and licences, current state, data model, Flow vs Apex decisions, integrations, security and compliance, impact on the existing org, decisions, risks, open questions and traceability |
| `sa_detailed_design` | Solution Architect | Drafts a build-ready design for stories or epics, fitted to the existing metadata, with every acceptance criterion mapped to components and tests |

Each prompt takes a `context` argument. In Claude Code they appear as `/mcp__sf-agent-po__sa_high_level_design`; in VS Code Copilot Chat as `/mcp.sf-agent-po.sa_high_level_design`. Step 4 adds native agent files for each host as well.

### Publishing and approval

Nothing is written to Confluence or Jira without a preview. The preview tool returns the exact target and content plus an approval token. The token is signed by the server over that exact content and target, so the publish tool rejects it if the design was edited, the target changed, or the token came from somewhere else. The agents are instructed to show the preview and wait for your explicit approval, and your host's own tool-approval prompt adds a second check.

An artifact remembers the page it was published to, so publishing again updates that page (Confluence keeps the history). Editing a published artifact marks it as `changed` until it is republished.

### Metadata sources

`context_add_metadata` takes a `provider` and a `location`:

| Provider | Location | How it is fetched |
| --- | --- | --- |
| `local` | A folder path, including a shared drive | Read in place |
| `github` | `owner/repo` or URL | `gh repo clone` (uses your `gh auth`) |
| `gitlab` | `group/repo` or URL | `glab repo clone` (uses your `glab auth`) |
| `azure-devops` | Clone URL | `git clone` (uses Git Credential Manager; prefer it over a PAT in the URL) |
| `git` | Any clone URL | `git clone` |

Remote repos are shallow-cloned into `<workspace>/repos/` and fast-forwarded on later calls. Credentials embedded in a clone URL are stripped from titles, folder names, saved contexts and error messages. Only the source format (`sfdx-project.json`) is analysed for now.

## Setup

```bash
npm install
npm run build
```

Environment variables:

| Variable | Purpose |
| --- | --- |
| `SF_AGENT_WORKSPACE` | Where contexts and cloned repos are stored. Defaults to `./.sf-agent` |
| `ATLASSIAN_SITE_URL` | e.g. `https://your-company.atlassian.net` |
| `ATLASSIAN_EMAIL` | Atlassian account email |
| `ATLASSIAN_API_TOKEN` | API token from https://id.atlassian.com/manage-profile/security/api-tokens |

For org access, authorise the org once with `sf org login web --alias my-org`.

### Claude Code

```bash
claude mcp add sf-agent-po \
  -e ATLASSIAN_SITE_URL=https://your-company.atlassian.net \
  -e ATLASSIAN_EMAIL=you@company.com \
  -e ATLASSIAN_API_TOKEN=... \
  -- node /absolute/path/to/sf-agent-po/dist/index.js
```

### Cursor

`.cursor/mcp.json` in your project (or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "sf-agent-po": {
      "command": "node",
      "args": ["/absolute/path/to/sf-agent-po/dist/index.js"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://your-company.atlassian.net",
        "ATLASSIAN_EMAIL": "you@company.com",
        "ATLASSIAN_API_TOKEN": "..."
      }
    }
  }
}
```

### GitHub Copilot (VS Code)

`.vscode/mcp.json`:

```json
{
  "inputs": [{ "id": "atlassian-token", "type": "promptString", "description": "Atlassian API token", "password": true }],
  "servers": {
    "sf-agent-po": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/sf-agent-po/dist/index.js"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://your-company.atlassian.net",
        "ATLASSIAN_EMAIL": "you@company.com",
        "ATLASSIAN_API_TOKEN": "${input:atlassian-token}"
      }
    }
  }
}
```

## Example

> Add the notes in ~/shared/renewal-kickoff as meeting notes, the security team's email, Jira epic PORT-12, and our metadata repo acme/salesforce-core on GitHub to a context called "renewal". Then summarise what we know.

## Development

```bash
npm test          # vitest
npm run typecheck
```
