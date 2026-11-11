# Troubleshooting

Start with `doctor`, in the folder your AI tool opens:

```bash
npx -y sf-agent-po@next doctor
```

Each line is a check that passed, a warning or a failure, with the fix. This page explains each check, then covers problems `doctor` cannot see. Your AI tool starts the server with its own environment, which your shell may not have: if `doctor` passes but the tools fail, ask the assistant to run the `server_status` tool, which runs the same checks inside the server (without the calls to Jira and Confluence).

When you open an issue, paste the `doctor` output. It shows no token, username or masked value, and `~` for your home folder.

## Node

| What `doctor` says | What to do |
| --- | --- |
| `Node 22.x; sf-agent-po needs Node 24 or later.` | Install Node 24 LTS from nodejs.org, or `nvm install 24`. If your shell has Node 24 but your tool does not, see [The server does not start](#the-server-does-not-start). |

## Workspace

The workspace is `.sf-agent` in the folder `doctor` runs in, or the folder `--workspace` or `SF_AGENT_WORKSPACE` names. It must be the same one the server uses.

| What `doctor` says | What to do |
| --- | --- |
| `No workspace in ... yet` | Run `doctor` where the server starts, or give it the server's `SF_AGENT_WORKSPACE` with `--workspace`. The server makes the workspace on first start. |
| `This Node's SQLite has no full-text search (FTS5)` | Use the official Node 24 build from nodejs.org; some Linux distribution builds leave FTS5 out. |
| `The database ... cannot be read` or `is damaged` | Restore the workspace folder from a backup, or move it away, then index and add the inputs again. |
| `written by a newer sf-agent-po` | Run the newest version: `npx -y sf-agent-po@next doctor`, and restart your tool so the server updates too. |
| `written by an older sf-agent-po` | Nothing to do: the server upgrades it when it next starts. |

## Masking key

The key encrypts the real values behind the pseudonyms. Without it nothing can be unmasked, so nothing can be published.

| What `doctor` says | What to do |
| --- | --- |
| `No key yet, and secret-tool is not installed` (Linux) | Install `libsecret-tools` (or `libsecret` on Fedora) so the key goes to your keyring, not a key file. |
| `The workspace's key ... is not in ...` (your keychain, or a key file) | Import it from your backup: `npx -y sf-agent-po@next key import`. If there is no backup, the masked values cannot be recovered; move the workspace away and start again. |
| A keychain that is locked or does not answer | Unlock it (on Linux over SSH, start a session with a keyring) and run `doctor` again. |
| `Keep a backup` on a passing line | Run `npx -y sf-agent-po@next key export` once and keep the line in your password manager. |

## Name model

The model that finds names (about 140 MB) is downloaded from huggingface.co on first use, checked against pinned checksums, and kept in your user cache folder (or `SF_AGENT_PO_MODEL_DIR`).

| What `doctor` says | What to do |
| --- | --- |
| `not downloaded yet; huggingface.co is reachable` | Nothing to do: it downloads when the first input is added. |
| `not downloaded yet, and huggingface.co cannot be reached` | Behind a company proxy, set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1`, plus `NODE_OPTIONS=--use-system-ca` if the proxy inspects HTTPS, in your shell and in the server's environment. Without access, the server's error names each file to download by hand and where to save it. |
| `The model loads but found no name in a test sentence` | Delete the model folder `doctor` names, so it downloads again. |
| `The model runtime is missing from the package` | The package download was incomplete. If running `doctor` again with `npx -y` does not fix it, delete npx's cache folder (`_npx` in npm's cache, `~/.npm/_npx` on macOS and Linux) and run `doctor` again. |

## Salesforce CLI

Needed only to index an org.

| What `doctor` says | What to do |
| --- | --- |
| `The sf CLI is not installed` | `npm install -g @salesforce/cli`, then `sf org login web --alias <alias>`. |
| `sf is installed but logged in to no org` | `sf org login web --alias <alias>`. |
| `... cannot be reached or need a new login` | `sf org list` shows which; log in to each one you index again. |
| Any other `sf` error | Run `sf org list` to see it, and update the CLI. |

## Jira and Confluence

The server needs `ATLASSIAN_SITE_URL`, `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN` in its environment, which is your AI tool's MCP settings, not your shell. `doctor` reads them from your shell, so set them there too to test them, or use `server_status`.

| What `doctor` says | What to do |
| --- | --- |
| `None of ... is set` | Add the three to your tool's MCP settings (see the [user guide](user-guide.md#install)). |
| `... is not set` | Set the missing one next to the others. |
| `does not start with https://` | Use your site's address, for example `https://your-company.atlassian.net`. |
| `refused the email and API token (401)` | Make a new API token at id.atlassian.com for the account of `ATLASSIAN_EMAIL`. |
| `accepted the login but refused access (403)` | Ask your Atlassian admin for Jira or Confluence access for this account. |
| `was not found on this site (404)` | Check the site address, or ignore it if your site has no Confluence (or no Jira). |
| `answered with a page that is not its API`, or `cannot be reached` | A company proxy or login page is in the way: set the proxy variables as for the [name model](#name-model). |

## git, gh and glab

Needed only to index a remote repository: `git` for any clone, `gh` for private GitHub repositories, `glab` for private GitLab ones. Install the missing one and sign in (`gh auth login`, `glab auth login`). The server never asks for a password: sign in first, or use your git credential manager.

## AI tool files

| What `doctor` says | What to do |
| --- | --- |
| `No AI tool files` | In your project folder: `npx -y sf-agent-po@next init --host claude-code` (or `cursor`, `copilot`, `all`). |
| `N of M files`, or `from another version or edited` | `npx -y sf-agent-po@next init --host <tool> --force`. This replaces your edits to those files. |
| `file(s) from an earlier version are still in ...` | Delete the files it names (for Cursor, the old `.cursor/commands` files that skills replace), so your tool does not offer each workflow twice. |

## Metadata index

| What `doctor` says | What to do |
| --- | --- |
| `Nothing is indexed` | `npx -y sf-agent-po@next index --org <alias>` (or `--project <folder>`, `--repo <repository>`). |
| `... was indexed N day(s) ago` | Index it again with the command shown (`--repo <repository>` for a remote repository): a run reads only what changed. |

## Problems doctor cannot see

### The server does not start

Your tool shows the server as failed or missing. Common causes:

- **The tool cannot find `npx` or uses an old Node.** Apps started from the Dock or Start menu often do not see the Node your shell uses (common with nvm). Use the full path as the command: the output of `which npx` (macOS, Linux) or `where npx` (Windows), and make sure that Node is version 24.
- **A first start takes a while.** `npx` downloads the package the first time. Some tools give up early: restart the server once it is downloaded.
- **Its log says why.** The server writes to its error output, which your tool shows in its MCP log or output panel. Running `npx -y sf-agent-po@next doctor` in a terminal also shows whether the package starts at all.

### The tools are there but never used

Copilot must be in Agent mode with the sf-agent-po tools ticked; Cursor must be in Agent mode, not Ask. You can also say "use the sf-agent-po tools".

### `/sa-hld` and the other workflows are missing

`init` was run in another folder, or the session started before it. Run `init --dir <the folder you open in your tool>`, then start a new session. Cursor needs version 2.4 or later for skills.

### An approval page does not open

The server opens it in your default browser, on the computer the server runs on. If the tool runs over SSH or in a container, the page cannot reach you there. To use another browser, set `SF_AGENT_PO_BROWSER` to a JSON array: the browser's absolute path, then any arguments. The server names that program on its error output when it starts.

### A context seems empty in another tool

Each tool uses `.sf-agent` in the folder it starts in. Set `SF_AGENT_WORKSPACE` to the same absolute path in every tool, then restart them.

### A publish is refused

Something changed after you approved (the design, the Jira issue, the Confluence page), or the backlog has quality errors. Ask for the publish again; for errors, ask the agent to fix them first.
