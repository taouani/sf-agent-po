# sf-agent-po

An MCP server that gives Claude Code, Cursor and GitHub Copilot a Salesforce **Solution Architect** and **Product Owner** workflow.

The host's own model does the reasoning. This server supplies:

- a **requirement context** assembled from meeting notes, emails, PI planning output, Jira, Confluence, a metadata repository and a Salesforce org;
- the **agent workflows** as MCP prompts, with Salesforce architecture and product practice built in;
- **artifacts** (designs, backlogs) saved as versioned drafts in the same context, so the agents can run in either order: the Solution Architect's high-level design feeds the Product Owner, or the PO's stories feed the SA's detailed design;
- **publishing** to Confluence and Jira that only runs after the user approves a preview.

New here? The [user guide](docs/user-guide.md) walks through installing the server, a first test run on the sample scenario, and day-to-day use of both agents.

## Status

| Step | Scope | State |
| --- | --- | --- |
| 1 | Shared core: requirement context, input loaders, metadata sources, org/Jira/Confluence readers | Done |
| 2 | SA agent: high-level design from raw inputs, detailed design from stories, published to Confluence | Done |
| 3 | PO agent: epics and stories with acceptance criteria, published to Jira after review | Done |
| 4 | Per-host packaging (Claude Code, Cursor, Copilot), sample scenarios, industry templates | Done |

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
| `backlog_save` | Saves a backlog (epics, stories, Given/When/Then acceptance criteria, NFRs, priorities, points, dependencies, sources) as a versioned artifact and runs the quality check |
| `backlog_get` / `backlog_check` | Returns a backlog as JSON for revision, or re-runs the quality check |
| `jira_publish_preview` | Lists every epic and story that would be created or updated in a Jira project, and returns an approval token |
| `jira_publish` | Creates epics, stories under them and "Blocks" links for dependencies; updates only what changed since the last publish |
| `industry_guidance` | Returns guidance for an industry: Salesforce products, data model, regulation, integrations and pitfalls |
| `agent_workflow` | Returns the full method and template of an SA or PO workflow (the same text as the MCP prompts), for agents in hosts where the model cannot start a prompt |

Every tool takes a `context` name (default `default`), so you can keep one context per feature or epic. Contexts are saved as JSON under the workspace folder, so they persist between sessions and are shared by every host pointed at the same workspace. Re-adding a source replaces the earlier copy.

## Agent workflows (MCP prompts)

| Prompt | Agent | What it does |
| --- | --- | --- |
| `sa_high_level_design` | Solution Architect | Drafts a high-level design from raw inputs: scope, personas and licences, current state, data model, Flow vs Apex decisions, integrations, security and compliance, impact on the existing org, decisions, risks, open questions and traceability |
| `sa_detailed_design` | Solution Architect | Drafts a build-ready design for stories or epics, fitted to the existing metadata, with every acceptance criterion mapped to components and tests |
| `po_backlog` | Product Owner | Builds epics and INVEST user stories from the inputs and the SA's design, with Given/When/Then criteria, NFRs traced to security and compliance inputs, spikes for open questions |
| `po_review_stories` | Product Owner | Reviews existing Jira stories for readiness and proposes rewrites and splits, which can be published back to the same issues |

Each prompt takes a `context` argument and an optional `industry` (with completion). In Claude Code they appear as `/mcp__sf-agent-po__sa_high_level_design`; in VS Code Copilot Chat as `/mcp.sf-agent-po.sa_high_level_design`. For hosts or teams that prefer native agent files, see [Agent files for your tool](#agent-files-for-your-tool).

### Industry templates

`financial-services`, `insurance`, `health`, `manufacturing`, `automotive`, `energy-utilities`, `public-sector`, `nonprofit`, `education`, `retail-consumer-goods` and `communications`. Each one points the agents at the relevant Salesforce industry products and data model, the regulations to trace (for example HIPAA, PCI DSS, KYC/AML, FedRAMP), the usual integration landscape and common pitfalls. The agents are told to confirm industry objects and features against the org before relying on them, since names differ between releases and licences. Common names such as "banking", "healthcare" or "Energy & Utilities" are accepted too.

### Publishing and approval

Nothing is written to Confluence or Jira without a preview. The preview tool returns the exact target and content plus an approval token. The token is signed by the server over that exact content, title, target and the target page's current version, so the publish tool rejects it if the design was edited, the target changed, someone edited the page in Confluence after the preview, the token was already used, or it came from somewhere else. Confluence's own version check also stops an update if the page changes between the check and the write.

The agents are instructed to show the preview and wait for your explicit approval. On top of that, the publish tools ask you directly through MCP elicitation when your host supports it (a confirmation prompt from the server, not from the model), and they are marked as destructive so hosts do not auto-approve them.

An artifact remembers the page it was published to, so publishing again updates that page (Confluence keeps the history), and the preview warns if the page was edited in Confluence since the last publish. Editing a published artifact marks it as `changed` until it is republished. Artifacts are identified by kind, type and title, so a high-level and a detailed design with the same title stay separate, and titles in any script work.

For Jira, each epic and story keeps a stable id (E1, S1, ...) mapped to its issue key. Republishing creates only new items and updates only items whose content changed. An update overwrites the summary and description (and story points, when set) and replaces the labels this backlog set, while labels added in Jira, status, assignee and comments are kept. The preview shows each issue's current summary when it differs, flags issues edited in Jira since the last publish, and shows stories that move to another epic, for example because their epic was deleted in Jira and is created again. An issue edited after the preview invalidates the approval token. Items marked won't have are left out of Jira, and issues whose ids are no longer in the backlog are listed and left as they are. Only one publish runs at a time per artifact, and progress is saved after every issue, so if a publish fails part-way, running the preview again continues without duplicates. Stories get the labels `sf-agent-po`, `moscow-<priority>` and `spike` where relevant; pass `storyPointsField` (for example `customfield_10016`) to fill story points, which are only ever set, never cleared.

### Quality check

`backlog_save` runs a deterministic check and the PO agent fixes what it finds before showing you the backlog: duplicate ids and Jira keys, broken or circular dependencies, dependencies on won't-have stories, generic personas, story points off the 1, 2, 3, 5, 8, 13 scale or over 8, untestable wording in acceptance criteria ("fast", "user-friendly"), stories without sources, and context inputs that no story cites, with security and compliance inputs flagged as warnings. Errors block publishing to Jira.

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

## Agent files for your tool

The MCP prompts work in any host that supports them. To also get native agents and slash commands, generate them into your project. The commands contain the same text as the prompts; the agents call the `agent_workflow` tool to get the full method and templates, since a model cannot start an MCP prompt itself.

```bash
node /absolute/path/to/sf-agent-po/dist/index.js init --host all --dir /path/to/your/project
```

| Host | Files | How to use |
| --- | --- | --- |
| Claude Code | `.claude/agents/salesforce-{solution-architect,product-owner}.md`, `.claude/commands/{sa-hld,sa-detailed,po-backlog,po-review}.md` | Subagents, plus `/sa-hld renewal integrations` etc. (the first word is the context) |
| Cursor | `.cursor/rules/salesforce-*.mdc` (agent-requested rules), `.cursor/commands/*.md` | `/sa-hld` etc. in Agent chat; name the context in your message, or the agent asks |
| GitHub Copilot (VS Code) | `.github/agents/salesforce-*.agent.md` (custom agents), `.github/prompts/*.prompt.md` | Pick the agent, or run `/sa-hld context=renewal` etc. |

`--host` takes `claude-code`, `cursor`, `copilot` or `all` (the default); repeat it or separate hosts with commas. Existing files are skipped unless you pass `--force`, symbolic links are never followed out of the project, and `--dry-run` lists what would be written. VS Code also loads Claude Code agents from `.claude/agents`, so when those are present the Copilot agent files are left out to avoid listing each agent twice. The Copilot agents are marked for VS Code, because the Copilot agent on github.com cannot reach a local MCP server.

## Sample scenarios

[`examples/`](examples/) has realistic input sets (an insurance renewal portal with existing metadata, and a business banking onboarding without any) with a rubric of what good SA and PO output contains. Use them to try the agents, compare models or prompt changes, and as a regression set; the tests check that a reference backlog passes the quality check and covers each of the security team's six requirements.

## Example

> Add the notes in ~/shared/renewal-kickoff as meeting notes, the security team's email, Jira epic PORT-12, and our metadata repo acme/salesforce-core on GitHub to a context called "renewal". Then summarise what we know.

## Development

```bash
npm test          # vitest
npm run typecheck
```

### v1 rewrite

v1 is being built next to the current server, which keeps working until v1 replaces it.
The new code lives in npm workspaces under `packages/`:

- `packages/core`: the workspace database (SQLite through `node:sqlite`, with migrations).
  Later it also holds masking, the metadata index and the workflow engine. It needs Node 24.
  `importLegacyWorkspace` copies the 0.x contexts (`.sf-agent/contexts/*.json`) into the
  database, keeping document ids and dates. It only reads the JSON files.
  Domain content (industry templates, including the new luxury one, the agents' roles and
  practices, and design templates) is Markdown in `packages/core/content`, so it can be reviewed
  and changed without touching code.
  `detect` finds what masking hides (personal data and secrets): rules for structured values
  and street addresses, a dictionary of names the context already knows, and the detection
  model for other names. Places and company names stay visible unless they are part of an address.
  `loadDetectionModel` downloads the model on first use (138 MB, checked against pinned
  SHA-256 checksums, cached in the user's cache folder or `SF_AGENT_PO_MODEL_DIR`) and runs it
  on the WebAssembly build of ONNX Runtime that the package ships in `vendor/` (no native code).
  `npm test` copies those runtime files there first; set `SF_AGENT_PO_MODEL_TEST=1` to also
  run the test against the real model.
  `Vault` replaces what `detect` finds with stable pseudonyms per context (`[PERSON_1]`,
  `[EMAIL_1]`), keeps the originals encrypted (AES-256-GCM) in the workspace database, and
  puts the real values back for the final write after approval. Secrets stay masked even then.
  Phone numbers, IBANs and the like that differ only in format share a pseudonym and come back
  in the first spelling seen; names merge only when they differ by case, spacing or apostrophe style.
  Its key is 32 random bytes, one per workspace. `openVault` keeps it out of the workspace: in
  the macOS keychain, in a Windows DPAPI-encrypted file, or in the Secret Service keyring
  (GNOME Keyring, KWallet) on Linux, through the tools each OS ships. Where none of these
  works (a server without a keyring), it falls back to a key file only the user can read,
  and says so. `exportVaultKey` and `importVaultKey` back the key up as text and restore it,
  for example on a new computer. Without the key, masked documents cannot be unmasked, so back
  it up when it is created. The keychain protects the key at rest and while you are logged
  out; like any keychain item an app reads without a prompt, other programs running as you
  can read it too.
- `packages/connectors`: everything that talks to the outside: the Jira and Confluence
  client, the Salesforce CLI, git hosts for metadata, and local files (notes, emails).
- `packages/eval`: measures the agents' output. It runs scenarios (inputs plus a rubric) against
  the MCP server with Anthropic, OpenAI or xAI models and has a judge model score the result.
  See [packages/eval/README.md](packages/eval/README.md).

The connectors started as copies of the 0.x modules in `src/`, which stay as they are so the
current server keeps working. A fix to one of them belongs in both places until v1 replaces 0.x.

`npm test` and `npm run typecheck` cover both the current server and the packages; in the packages,
`typecheck` also checks the tests (`tsconfig.check.json`).
