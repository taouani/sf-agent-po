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
The diagrams of a design written by a workflow are attached to its Confluence page as
draw.io files and shown with the draw.io app; on a site without the app, publish with
`diagrams: "mermaid"` to keep their Mermaid source in a code block instead (kept for the
context).

To add the agent files for your tool to a project:

```bash
npx -y sf-agent-po@next init --host claude-code   # or cursor, copilot, all
```

To fill the workspace's metadata index from an org (retrieved with your `sf` CLI, which
must be logged in to it; the org is only read), from a Salesforce project folder, or from
a repository, cloned with your own `gh`, `glab` or `git` into the workspace (prefer your
credential manager to a token in the URL, which git keeps in the clone). Runs the server
starts never ask for a password: sign in with `gh auth login`, `glab auth login` or your
git credential manager first.

```bash
npx -y sf-agent-po@next index --org <alias or username>
npx -y sf-agent-po@next index --project <folder>
npx -y sf-agent-po@next index --repo github:owner/repo#main   # or gitlab:, azure-devops:<url>, git:<url>
```

A run reads only what changed since the last one: an org's components whose date changed
(with profiles and permission sets every time), and the files whose content changed. An org
is retrieved in full once a week, and every file parsed again at least weekly and after an
upgrade; `--full` does both now.

The workspace (one SQLite database per project, in `.sf-agent`, or `SF_AGENT_WORKSPACE`)
holds the masked inputs and the agents' work. Its masking key is kept in your OS keychain,
or in a key file when no keychain is available. Back it up: without it, nothing can be
unmasked. When the server makes a new key, its log (the MCP server output of your AI tool)
says so, with the command to back it up.

```bash
npx -y sf-agent-po@next key export   # prints the key as one line, for a password manager
npx -y sf-agent-po@next key import   # on another computer: paste it when asked (it is not shown)
```

Both take `--workspace <folder>` (else `SF_AGENT_WORKSPACE`, else `.sf-agent` here). Export
prints only to a terminal, so that an AI agent running commands cannot read the key; add
`--to-pipe` to send it to a password manager's CLI. Import checks that the key is this
workspace's and saves it in your keychain; add `--allow-key-file` to save it in a key file
instead when the keychain cannot be used. The key is never read from the command line, which
your shell history keeps, and neither command changes the workspace database.

To check the set-up, run `doctor` in your project folder. It checks Node, the workspace and
its masking key, the name detection model, the `sf` CLI and its orgs, the Jira and Confluence
settings (with one call to each), `git`, `gh` and `glab`, the AI tool files and the age of
each index, and gives the fix for each problem. Its output shows no token, username or
masked value, and `~` for your home folder, so you can paste it into an issue. Your AI tool
sets the server's environment, which your shell may not have: the `server_status` tool runs
the same checks from inside the server, without the calls to Jira and Confluence.

```bash
npx -y sf-agent-po@next doctor   # --workspace <folder>, --dir <project folder>, --no-calls
```

The name detection model (about 140 MB) is downloaded on first use, pinned and checked.
It comes from huggingface.co, whose larger files are served from its download hosts
(`*.hf.co`). Behind a company proxy, add `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` to the
server's environment, since Node does not use the system's proxy on its own; if the proxy
inspects HTTPS, also add `NODE_OPTIONS=--use-system-ca`. Without access at all, download the
files yourself: the error names each file's address and where to save it, and the server
checks them against their checksums.

Approval pages open in your default browser. To use another one, set `SF_AGENT_PO_BROWSER` in
the server's environment to a JSON array: the browser's absolute path, then any arguments, for
example `["/Applications/Firefox.app/Contents/MacOS/firefox", "--new-window"]`. The page's
address is added last. Whoever opens the page decides, so treat this setting like the server
command itself: the server names the program on its error output when it starts.

The [user guide](https://github.com/taouani/sf-agent-po/blob/main/docs/user-guide.md) walks
through a first run and day-to-day use, and [troubleshooting](https://github.com/taouani/sf-agent-po/blob/main/docs/troubleshooting.md)
explains each `doctor` result.

Source, documentation and issues: https://github.com/taouani/sf-agent-po
