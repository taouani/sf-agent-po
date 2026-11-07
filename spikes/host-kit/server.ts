// Spike 4: a throwaway MCP server that checks, in each host (Copilot in VS Code, Cursor,
// Claude Code), the host features v1 depends on. See host-kit/README.md for how to run it.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'sf-agent-po-host-checks', version: '0.0.1' }, { capabilities: { logging: {} } });

server.registerTool(
  'spike_client_info',
  { title: 'Host info', description: 'Returns what this host reports about itself: name, version and MCP capabilities.' },
  async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { client: server.server.getClientVersion(), capabilities: server.server.getClientCapabilities() ?? null },
          null,
          2,
        ),
      },
    ],
  }),
);

server.registerTool(
  'spike_image',
  {
    title: 'Image check',
    description:
      'Returns a test image (an invented CRM contact card). Then answer: what is the email address and the mobile number shown in the image? ' +
      'If you cannot see an image, say so plainly.',
  },
  async () => ({
    content: [
      { type: 'text', text: 'Test image follows. Read the email address and mobile number from the picture, not from this text.' },
      { type: 'image', mimeType: 'image/png', data: readFileSync(join(import.meta.dirname, '..', 'ocr', 'fixtures', 'en-contact.png')).toString('base64') },
    ],
  }),
);

server.registerTool(
  'spike_elicitation',
  { title: 'Elicitation check', description: 'Asks the user to confirm through the host (MCP elicitation) and reports what happened.' },
  async () => {
    const caps = server.server.getClientCapabilities()?.elicitation;
    if (!caps) return { content: [{ type: 'text', text: 'This host does not advertise elicitation.' }] };
    const t0 = Date.now();
    try {
      const r = await server.server.elicitInput({
        message: 'sf-agent-po host check: would you publish this test story to Jira? (Nothing is published.)',
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean', title: 'Publish', default: false } },
          required: ['confirm'],
        },
      });
      return { content: [{ type: 'text', text: `Elicitation returned after ${Date.now() - t0} ms: ${JSON.stringify(r)}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Elicitation failed after ${Date.now() - t0} ms: ${(e as Error).message}` }] };
    }
  },
);

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

server.registerTool(
  'spike_approval_page',
  {
    title: 'Approval page check',
    description:
      'Opens a local approval page in the browser and waits up to 3 minutes for the user to click Approve or Reject. ' +
      'Checks that the browser opens and that the host does not time out a long tool call.',
  },
  async () => {
    const t0 = Date.now();
    const decision = await new Promise<string>((resolve) => {
      const http = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/decide') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p>Recorded. You can close this tab.</p>');
          http.close();
          resolve(url.searchParams.get('d') ?? 'unknown');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8">
<title>sf-agent-po approval check</title>
<body style="font-family:system-ui;max-width:640px;margin:40px auto">
<h1>Approval check</h1><p>This is where you would see the unmasked preview before a publish. Nothing is published.</p>
<p><a href="/decide?d=approved">Approve</a> &nbsp; <a href="/decide?d=rejected">Reject</a></p></body>`);
      });
      http.listen(0, '127.0.0.1', () => {
        const { port } = http.address() as { port: number };
        const url = `http://127.0.0.1:${port}/`;
        void server.server.sendLoggingMessage({ level: 'info', data: `Approval page: ${url}` }).catch(() => {});
        console.error(`Approval page: ${url}`);
        openBrowser(url);
      });
      setTimeout(() => {
        http.close();
        resolve('timed out after 3 minutes');
      }, 180_000).unref();
    });
    return { content: [{ type: 'text', text: `Approval page result: ${decision} (after ${Math.round((Date.now() - t0) / 1000)} s)` }] };
  },
);

await server.connect(new StdioServerTransport());
