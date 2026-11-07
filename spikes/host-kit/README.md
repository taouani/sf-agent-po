# Host checks kit (spike 4)

Four checks that only you can run, because they need a real host and your Atlassian site.
Each takes a minute or two per host. Test order: Copilot in VS Code, then Cursor, then Claude Code.

## Setup

You need Node 22.18 or later (the kit runs TypeScript directly). From the repository root:

```bash
cd spikes
npm ci
```

Then add the server to the host, using the absolute path to `spikes/host-kit/server.ts`:

- **VS Code (Copilot):** create `.vscode/mcp.json` in the repository:
  ```json
  { "servers": { "sf-agent-po-host-checks": { "type": "stdio", "command": "node", "args": ["${workspaceFolder}/spikes/host-kit/server.ts"] } } }
  ```
  Start it from the MCP view, then use Copilot Chat in Agent mode.
- **Cursor:** add to `.cursor/mcp.json`:
  ```json
  { "mcpServers": { "sf-agent-po-host-checks": { "command": "node", "args": ["/absolute/path/to/sf-agent-po/spikes/host-kit/server.ts"] } } }
  ```
- **Claude Code:** `claude mcp add sf-agent-po-host-checks -- node /absolute/path/to/sf-agent-po/spikes/host-kit/server.ts`

## Checks in the host

Ask the agent to call each tool, one at a time:

1. **`spike_client_info`**: copy the JSON it returns. It shows which MCP features the host advertises.
2. **`spike_image`**: the agent should read the email address (`s.whitfield@example-mail.com`) and the mobile number (`+44 20 7946 0958`) from the picture. Note whether it could, and which model you used.
3. **`spike_elicitation`**: the host should show a form asking you to confirm. Note whether it appeared and what came back.
4. **`spike_approval_page`**: a browser tab should open with Approve and Reject links. Wait about a minute before clicking, then note whether the tool still returned your choice or the host gave up first.

## Check in Confluence (once, not per host)

This creates one test page in a space you choose, using your own API token. Nothing is stored.

```bash
ATLASSIAN_SITE=https://your-site.atlassian.net ATLASSIAN_EMAIL=you@example.com \
ATLASSIAN_API_TOKEN=... CONFLUENCE_SPACE_KEY=ABC node host-kit/drawio-confluence.ts
```

Open the page it prints and note which of the three sections (A, B, C) shows the diagram, and whether A or B opens in the draw.io editor. Delete the page afterwards.

## Results

Fill this in (or just reply in the thread with what you saw):

| Check | Copilot (VS Code) | Cursor | Claude Code |
| --- | --- | --- | --- |
| Host version / model used | | | |
| Image read correctly | | | |
| Elicitation form shown | | | |
| Approval page opened | | | |
| Long tool call survived about a minute | | | |

draw.io in Confluence: A ☐ renders ☐ edits · B ☐ renders ☐ edits · C ☐ readable
