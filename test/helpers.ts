import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { AtlassianClient } from "../src/connectors/atlassian.js";

export interface FakeRequest {
  method: string;
  path: string;
  body?: any;
}

type Handler = (req: FakeRequest) => { status?: number; body: unknown } | undefined;

/** Starts the server against a fake Atlassian site and returns an MCP client plus the requests it made. */
export async function startServer(handler: Handler) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sf-agent-"));
  const requests: FakeRequest[] = [];
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    const req = { method: init.method ?? "GET", path: url.replace("https://x.atlassian.net", ""), body: init.body ? JSON.parse(init.body as string) : undefined };
    requests.push(req);
    const res = handler(req);
    if (!res) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200 });
  }) as typeof fetch;

  const server = createServer({
    workspaceDir: workspace,
    atlassian: new AtlassianClient({ siteUrl: "https://x.atlassian.net", email: "e", apiToken: "t" }, fakeFetch),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0].text, isError: r.isError };
  };
  const close = async () => {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  };
  return { client, call, requests, close, workspace };
}

export function tokenFrom(preview: string): string {
  const m = preview.match(/Approval token: (\S+)/);
  if (!m) throw new Error(`No approval token in preview:\n${preview}`);
  return m[1];
}

export function idFrom(saved: string): string {
  const m = saved.match(/\b(doc-[0-9a-f]{10})\b/);
  if (!m) throw new Error(`No document id in:\n${saved}`);
  return m[1];
}
