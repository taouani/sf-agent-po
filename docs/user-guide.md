# sf-agent-po user guide

This guide covers version 1 (`sf-agent-po@next`). It goes from installing the server to your first design and backlog, then covers day-to-day use. If you have ten minutes, do [Install](#install) and [Check the set-up](#check-the-set-up). If you have half an hour, continue with [A first run on the insurance sample](#a-first-run-on-the-insurance-sample).

- [How it works](#how-it-works)
- [Before you start](#before-you-start)
- [Install](#install)
- [Check the set-up](#check-the-set-up)
- [Index your org or project](#index-your-org-or-project)
- [A first run on the insurance sample](#a-first-run-on-the-insurance-sample)
- [Add your own inputs](#add-your-own-inputs)
- [The guided workflows](#the-guided-workflows)
- [Approval pages](#approval-pages)
- [Publish to Confluence and Jira](#publish-to-confluence-and-jira)
- [Give feedback on what was published](#give-feedback-on-what-was-published)
- [Back up the masking key](#back-up-the-masking-key)
- [Reference](#reference)

Problems: see [Troubleshooting](troubleshooting.md), which starts from the output of `doctor`.

## How it works

sf-agent-po is not an app you open. It is an MCP server that gives the AI assistant you already use (Claude Code, Cursor, or GitHub Copilot in VS Code) a Salesforce Solution Architect and Product Owner. Your assistant's model does the thinking. The server keeps your inputs, guides the work step by step, checks it, and publishes it.

Six ideas explain the rest of this guide:

- **Requirement context.** A named set of inputs for one feature or epic, for example `renewal`: meeting notes, emails, PI planning, documents, images, Jira issues and Confluence pages. Every tool takes the context name; with none, it uses `default`.
- **Masking.** Personal data and secrets in every input are replaced by pseudonyms such as `[PERSON_1]` or `[EMAIL_2]` before anything is stored or sent to the model. The real values come back only when you approve a publish, and secrets never do.
- **Metadata index.** Your org or Salesforce project, read once and kept in the workspace, so the agents can search it, check names against it, and list what a change affects.
- **Guided workflows.** The agents do not write a design or a backlog in one go. The server hands them one step at a time (the requirements, the scope, each section or each epic's stories), checks each answer, and sends it back with what to fix. After three tries a step is saved with its remaining findings, and the run goes on.
- **Approval pages.** Whenever you need to confirm something (the masked inputs, the requirements, the scope, a publish, your feedback), the server opens a page in your browser. The model never sees the page or its link.
- **Feedback.** After a backlog is published, you record whether each story was accepted, and the server compares the Jira issues with what it published. That gives the project's success measure: 90% of stories accepted without major edits.

Everything lives in a **workspace**: one SQLite database per project, in `.sf-agent` in the folder where the server starts (or the folder `SF_AGENT_WORKSPACE` names). Its masking key is kept in your OS keychain.

## Before you start

| What | Needed for | Check it with |
| --- | --- | --- |
| Node.js 24 or later | Running the server (required) | `node --version` |
| Claude Code, Cursor 2.4 or later, or VS Code with GitHub Copilot | Talking to the agents (one is required) | Copilot needs Agent mode in Chat |
| Atlassian API token | Reading and publishing Jira and Confluence | Create one at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) |
| Salesforce CLI (`sf`) | Indexing an org | `sf --version`, then `sf org login web --alias my-org` |
| `git`, and `gh` or `glab` | Indexing a remote repository | `gh auth status` or `glab auth status` |

The name detection model (about 140 MB) is downloaded from huggingface.co on first use. Behind a company proxy, see [Troubleshooting](troubleshooting.md#name-model).

## Install

There is nothing to clone or build: your tool starts the server with `npx`. Register it once, with your Atlassian settings in its environment.

**Claude Code**, for every project (`--scope user`):

```bash
claude mcp add sf-agent-po --scope user \
  -e ATLASSIAN_SITE_URL=https://your-company.atlassian.net \
  -e ATLASSIAN_EMAIL=you@company.com \
  -e ATLASSIAN_API_TOKEN=... \
  -- npx -y sf-agent-po@next
```

**Cursor**, in `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "sf-agent-po": {
      "command": "npx",
      "args": ["-y", "sf-agent-po@next"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://your-company.atlassian.net",
        "ATLASSIAN_EMAIL": "you@company.com",
        "ATLASSIAN_API_TOKEN": "..."
      }
    }
  }
}
```

**VS Code Copilot**, in `.vscode/mcp.json`, which asks for the token instead of storing it:

```json
{
  "inputs": [{ "id": "atlassian-token", "type": "promptString", "description": "Atlassian API token", "password": true }],
  "servers": {
    "sf-agent-po": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-agent-po@next"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://your-company.atlassian.net",
        "ATLASSIAN_EMAIL": "you@company.com",
        "ATLASSIAN_API_TOKEN": "${input:atlassian-token}"
      }
    }
  }
}
```

The workspace is `.sf-agent` in the folder the server starts in, which is usually the project you open. To share one workspace between tools or projects, add `SF_AGENT_WORKSPACE` with an absolute path to each tool's settings.

Then write the agent files into the project you work in:

```bash
npx -y sf-agent-po@next init --host claude-code   # or cursor, copilot, all
```

| Tool | Files | How to start a workflow |
| --- | --- | --- |
| Claude Code | `.claude/agents/` (two subagents) and `.claude/commands/` | `/sa-hld renewal`, `/sa-detailed`, `/po-backlog`, `/po-review` (the first word is the context) |
| Cursor | `.cursor/rules/` (two agent-requested rules) and `.cursor/skills/` | The same four, in Agent chat; name the context in your message, or the agent asks |
| VS Code Copilot | `.github/agents/` (two custom agents) and `.github/prompts/` | Pick the agent, or run `/sa-hld context=renewal` |

VS Code also loads Claude Code's agent files, so when `init` writes `.claude/agents/` in the same project (`--host all`, the default), it leaves out `.github/agents/` and Copilot lists each agent once.

Existing files are kept unless you add `--force`; `--dry-run` lists what would be written. Commit the files so your team gets the same agents, and start a new session in your tool so it loads them. Without the files, the four workflows are still there as MCP prompts (`sa_high_level_design`, `sa_detailed_design`, `po_backlog`, `po_review_stories`).

## Check the set-up

Run `doctor` in your project folder:

```bash
npx -y sf-agent-po@next doctor
```

It checks Node, the workspace and its masking key, the name model, the `sf` CLI and its orgs, the Jira and Confluence settings (with one call to each), `git`, `gh` and `glab`, the AI tool files and the age of each index. Each problem comes with its fix. The output shows no token, username or masked value, so you can paste it into an issue.

Your tool starts the server with its own environment, which your shell may not have. To check from inside the server, ask your assistant to "run the sf-agent-po server_status tool": it runs the same checks, without the calls to Jira and Confluence.

## Index your org or project

The agents check every object, field and automation they name against the index, and list what a change affects. Fill it before your first design:

```bash
npx -y sf-agent-po@next index --org <alias or username>            # retrieved read-only with your sf CLI
npx -y sf-agent-po@next index --project <folder>                   # a Salesforce project folder
npx -y sf-agent-po@next index --repo github:owner/repo#main        # or gitlab:, azure-devops:<url>, git:<url>
```

You can also ask the assistant to index (the `metadata_index` tool). A run reads only what changed since the last one; `--full` reads everything. It ends with the time each step took, which helps when a large org is slow to index. A large org is retrieved in parts, two at a time; `--parallel 3` retrieves three at a time, and `--parallel 1` one after another, which is lighter on an org that is busy with deployments. The index holds objects, fields, validation rules, record types, flows, Apex, triggers, Lightning components, Visualforce, email templates, layouts, permission sets and profiles, reports, dashboards and report types, and integrations (named and external credentials, remote sites, connected apps, outbound messages, callouts). The org is never changed.

For a large org, let your computer refresh the index every night, so the morning starts with a fresh one:

```bash
npx -y sf-agent-po@next schedule --org <alias or username> --at 02:00   # every day, as you, while you are logged in
npx -y sf-agent-po@next schedule --list                                  # the schedules, and how the last run went
npx -y sf-agent-po@next schedule --remove --org <alias or username>
```

It uses Task Scheduler on Windows, launchd on macOS and cron on Linux, and runs as you, with your `sf` login. On Windows it runs while you are logged in, in a console window (closing the window stops the run), and a run missed while the computer was off starts once you log on. On macOS a run missed while the Mac slept starts when it wakes; if the project is under Documents or Desktop, macOS may refuse the run access, which it says in `~/Library/Logs/sf-agent-po`. Each run writes its output to a log in `.sf-agent/schedule`, and `--list` shows how the last run went. The run gets your PATH and a company CA file (`NODE_EXTRA_CA_CERTS`) as they were when you scheduled it; a proxy with a password in it is not written down, so set it in your system settings instead. A scheduled run that starts while another run indexes the same org stops at once and says so in its log, so nothing is indexed twice at the same time.

### One repository, several orgs

When one repository is deployed to several orgs, each from some of its package folders, index each org's folders as a **folder set**, linked to that org:

```bash
npx -y sf-agent-po@next index --org prod-row                     # the org itself
npx -y sf-agent-po@next index --project <repo> --packages common-app,row-app,sdg-app --name row --for-org prod-row
```

`--packages` takes the folders as your deployment script lists them: a package folder of `sfdx-project.json` (`row-app/care-app`), a package name, or a folder that holds package folders (`row-app` picks `row-app/force-app`, `row-app/care-app` and every other one under it, in the file's order). A folder with its own `sfdx-project.json` is read through it. The set is a source of its own (`repo:<name>:row#<hash>`), next to the whole repository's, and each set is indexed apart, so a component two sets define differently is no clash. When two folders of one set define the same component, the first in `sfdx-project.json` is kept and the other is reported.

`--for-org` links the set to its org, kept by the org's id. `metadata_sources` then shows the pairs; opening a component in the org says where it is in the repository, or that it is not there (made in the org, or from another repository or a package), and opening one in the set says whether the org has it (if not: not deployed yet, or deleted in the org and still in git). A scope confirmed on one side also applies on the other, matched by name. Every other question, impact analysis included, works on one source at a time: the org, by default the safer one, since it has what was made by hand. `--repo` takes the same options for a remote repository, and the assistant can index a set too (the `metadata_index` tool, with `packages`, `set` and `forOrg`). Folder sets come with 1.0.0-next.12.

Ask questions in plain words: "summarise the uat org", "search the metadata for renewal", "what depends on Policy__c.Premium__c?".

## A first run on the insurance sample

The repository's [`examples/insurance-renewal`](../examples/insurance-renewal) has realistic inputs (a kickoff, PI planning, the business owner's and the security team's emails) and an existing metadata project. Clone the repository, run `init` in the clone and open the clone in your tool, so that the paths below and the workspace (`.sf-agent` in the clone) are the ones the server uses:

1. Index the sample's metadata: `npx -y sf-agent-po@next index --project examples/insurance-renewal/metadata`.
2. In your tool: "Add the files in examples/insurance-renewal/inputs to a context called renewal." A page opens for each input, showing it masked: the email addresses are pseudonyms. Confirm each one. While input review is on (the default in pre-releases), nothing is added until you confirm.
3. Start the Solution Architect: `/sa-hld renewal` in Claude Code (or the equivalent in your tool), with "industry insurance".
4. The first step extracts the requirements. A page opens with them; change, remove or add requirements, then confirm. Then the agent proposes the scope (the objects the work touches), which you confirm the same way.
5. The agent writes the design section by section. The server checks each section against the requirements, the index and the template, and sends it back when something is missing; you see the steps in the chat. The last step saves the design.
6. Start the Product Owner: `/po-backlog renewal`. It reads the requirements you confirmed and the SA's design, then writes the epics, then the stories of each epic, then checks the whole backlog: INVEST, testable Given/When/Then criteria, story points, dependencies, and that every security requirement is covered.
7. Ask "show the traceability matrix for renewal": each requirement with its inputs, the design sections that address it and the stories that deliver it.

The sample's [`rubric.md`](../examples/insurance-renewal/rubric.md) lists what a good design and backlog contain, if you want to judge the result.

## Add your own inputs

Ask in plain words; the assistant picks the tool.

| Input | Ask for example | Tool |
| --- | --- | --- |
| Files or a folder | "Add ~/shared/renewal as meeting notes to renewal" | `context_add_file` (notes, `.eml`, PDF, Word, PowerPoint, Excel, CSV, draw.io, text, PNG and JPEG) |
| Text pasted in the chat | "Add this email to renewal: ..." | `context_add_text` |
| Jira issues | "Add PORT-12 and its stories" or a JQL query | `context_add_jira` |
| Confluence pages | "Add this page: <URL>" | `context_add_confluence` |

Images are read with OCR, and the personal data found on them is blacked out. You confirm each redacted image before the model sees it, whatever the input review setting. To see what a context holds, ask "show the renewal context"; to remove an input, "remove doc-… from renewal".

Input review can be turned off for a context ("turn input review off for renewal"); turning it off needs your confirmation on a page, so the model cannot do it alone.

## The guided workflows

| Workflow | Agent | Steps |
| --- | --- | --- |
| `sa_high_level_design` | Solution Architect | Requirements, scope (when an index exists), each section of the high-level design template, then the whole design |
| `sa_detailed_design` | Solution Architect | Requirements, scope, each section of the detailed design (fitted to the existing metadata, with every acceptance criterion mapped to components and tests), then the whole design |
| `po_backlog` | Product Owner | Requirements, epics, the stories of each epic, then the whole backlog |
| `po_review_stories` | Product Owner | Reviews the Jira stories in the context for readiness and proposes rewrites and splits |

Things worth knowing:

- **Either order.** The SA's high-level design feeds the PO's backlog, and the PO's stories feed the SA's detailed design. Requirements confirmed once are reused by the next workflow: when the inputs have not changed, the agent keeps them and no page opens.
- **Resume.** A workflow stays open until it finishes. Start it again (or ask "where is the renewal workflow?") to continue where it stopped, even in another tool on the same workspace.
- **Industry.** Name it ("industry insurance") and the steps carry that industry's guidance. Templates: financial services, insurance, health, manufacturing, automotive, energy and utilities, public sector, nonprofit, education, retail and consumer goods, communications, luxury.
- **French.** Say "write in French": the context keeps French for every later run, and the checks use French word lists.
- **Changes.** To revise a saved design or backlog, ask for the change; the agent saves a new version with the same checks.

## Approval pages

Each page opens in your default browser and shows what you are confirming, with real values on the requirements, publish and feedback pages, and masked values on the input and image pages, which show what the model will see. The tool call waits until you answer. The pages are:

- **Input review**: each masked input, before it is stored.
- **Image**: each redacted image.
- **Requirements**: the requirements a workflow extracted, to change, remove, add and confirm.
- **Scope**: the objects the work touches.
- **Publish**: everything that will be written to Confluence or Jira, with the real values.
- **Feedback**: your verdict on each story and your rating of each design section.

To use another browser, set `SF_AGENT_PO_BROWSER` in the server's environment to a JSON array: the browser's absolute path, then its arguments.

## Publish to Confluence and Jira

Ask "publish the design to Confluence in space ARCH" or "publish the backlog to Jira project PORT". The page opens with exactly what will be written; nothing is written until you approve it there.

- **Confluence.** A design becomes a page; a design written by a workflow also gets its traceability matrix as a page under it. A high-level design's diagrams are attached as draw.io files and shown with the draw.io app (on a site without it, ask for Mermaid diagrams instead); a detailed design's diagrams stay Mermaid. Publishing again updates the same page.
- **Jira.** Epics, stories under them and "Blocks" links for dependencies. Publishing again creates only new items and updates only those whose content changed; labels, status, assignee and comments added in Jira are kept. Stories marked won't have stay out of Jira. The sub-tasks of a detailed design can go with it.
- **Quality first.** A backlog with errors from the quality check is not published until they are fixed.

## Give feedback on what was published

Once the team has worked on the published stories:

1. "Compare the renewal backlog with Jira" reads each story back and classes it as unchanged, a minor edit, a major edit (more than 30% of the words changed by default, or an acceptance criterion added or removed) or deleted.
2. "Open the feedback review for the renewal backlog, as PO" (or SA, or dev) opens a page where you give each story a verdict (accepted, minor edit, major edit, rejected) and rate each design section. Your verdict counts before the Jira diff's guess.
3. "Summarise the feedback" gives the share of stories accepted without major edits against the 90% target, by context, model and workflow.

For a report outside the chat, with a CSV file you can open in a spreadsheet:

```bash
npx -y sf-agent-po@next report --csv ~/renewal-feedback.csv
```

## Back up the masking key

Without the workspace's key, nothing in it can be unmasked, so nothing can be published. The server makes the key on first start, keeps it in your keychain (or a key file readable only by you), and its log says so with the command to back it up:

```bash
npx -y sf-agent-po@next key export   # prints the key as one line, for your password manager
npx -y sf-agent-po@next key import   # on another computer: paste it when asked
```

Export prints only to a terminal, so an AI agent running commands cannot read the key; `--to-pipe` sends it to a password manager's CLI instead. Import checks that the key belongs to the workspace.

## Reference

### Commands

| Command | What it does |
| --- | --- |
| `npx -y sf-agent-po@next` | Starts the MCP server (your tool runs this) |
| `init` | Writes the agent files for your tool into a project |
| `index` | Fills the metadata index from an org, a project folder or a repository, or a set of its package folders |
| `schedule` | Refreshes an org's metadata index every day with your computer's scheduler |
| `doctor` | Checks the set-up and gives the fix for each problem |
| `key export`, `key import` | Back up and restore the masking key |
| `report` | The feedback report, optionally as CSV |

`doctor`, `key`, `report` and `index --repo` come with 1.0.0-next.8, and `metadata_code` with 1.0.0-next.9 (flows and sharing rules with 1.0.0-next.10); run `npm view sf-agent-po@next version` to see which version `@next` is. Each command takes `--help` (for example `npx -y sf-agent-po@next doctor --help`). `schedule` comes with 1.0.0-next.11. `index`, `schedule`, `key`, `doctor` and `report` take `--workspace <folder>`, else `SF_AGENT_WORKSPACE`, else `.sf-agent` in the current folder; `init` and `doctor` take `--dir <project folder>`. `doctor --no-calls` skips the calls to Jira and Confluence, and `report --context <name>` limits the report to one context.

### Tools

You rarely call tools by name; this list helps when you want to be precise.

| Tools | What they do |
| --- | --- |
| `context_list`, `context_show`, `context_read` | List contexts; list a context's inputs; return their masked text |
| `context_add_file`, `context_add_text`, `context_add_jira`, `context_add_confluence` | Add inputs, masked |
| `context_remove_document`, `context_review_inputs` | Remove an input; turn input review on or off |
| `metadata_index`, `metadata_sources`, `metadata_summary`, `metadata_search`, `metadata_component`, `metadata_code` | Index and explore the org or project, and read Apex code, flow logic and sharing rules (masked) |
| `scope_propose`, `scope_show`, `metadata_impact` | The scope of the work, and what a change affects |
| `workflow_start`, `workflow_step`, `workflow_submit`, `workflow_status` | The guided workflows |
| `trace_show` | The traceability matrix |
| `design_save`, `backlog_save`, `backlog_get`, `backlog_check` | Save and check designs and backlogs (the workflows use them) |
| `confluence_publish`, `jira_publish` | Publish, after your approval |
| `feedback_jira_diff`, `feedback_review`, `feedback_summary` | Feedback on published work |
| `industry_guidance` | Guidance for one industry |
| `server_status` | The `doctor` checks, from inside the server |

### Environment variables

| Variable | Purpose |
| --- | --- |
| `ATLASSIAN_SITE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN` | Jira and Confluence access |
| `SF_AGENT_WORKSPACE` | The workspace folder (default `.sf-agent` where the server starts) |
| `SF_AGENT_PO_BROWSER` | The browser for approval pages, as a JSON array |
| `SF_AGENT_PO_MODEL_DIR` | Where the name model is kept, as an absolute path (default: your user cache folder) |
| `HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`, `NODE_OPTIONS=--use-system-ca` | Behind a company proxy |

### What is stored where

| What | Where |
| --- | --- |
| Inputs (masked), requirements, workflow runs, designs, backlogs, feedback, the metadata index | `<workspace>/sf-agent.db` |
| Retrieved org metadata and cloned repositories | `<workspace>/orgs/`, `<workspace>/repos/` |
| Scheduled runs: their scripts and the output of the last run | `<workspace>/schedule/` |
| The masking key | Your OS keychain, or a key file readable only by you |
| The name model | Your user cache folder (or `SF_AGENT_PO_MODEL_DIR`) |

Inputs, designs and backlogs are stored masked; the real values they stand for are in the vault, encrypted with the key. The metadata index keeps the org's metadata as it was retrieved, and masks it when a tool returns it. It keeps the code of Apex classes and triggers too, and an outline of each flow's logic (its conditions, filters, assignments and the values in them), so `metadata_code` can show them masked. Before it keeps the code or an outline, it hides the secrets written in its strings and comments in the usual forms (a string set to something named like a key, password or token, an Authorization header, a secret URL parameter or JSON value). That is a safety net, not a guarantee: keep secrets in named credentials, not in code. Custom metadata records are retrieved too, for the objects and fields their values name (mapping tables). Each record is kept on disk with only the values the index reads as names (in a field such as Object__c or Source_Field__c, or shaped like Account.Industry or Segment__c); its label and every other value are taken out. The index keeps no record, only the links its type gets to objects and fields the org has (a standard field the retrieve does not list, such as Account.Name, is not linked). Sharing rules, roles, public groups and queues are retrieved for who can see records; a queue is kept without its user members and its email. Public group members are data, not metadata, so the index does not have them. The agents send what they read, masked, to your tool's model, as with anything you share in a chat. The server writes a `.gitignore` into `.sf-agent` so git leaves the workspace out; back up the key.
