import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BackgroundIndexer } from "@sf-agent-po/connectors";
import { ContextRepository, Database, Masker, MetadataIndex, newVaultKey, RequirementRepository, Vault, WorkflowRepository } from "@sf-agent-po/core";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, createServer, guidedPrompt, poBacklogPrompt, WORKFLOWS } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** The server as it runs, with the guided workflows; `guided: false` leaves them out. */
async function connect({ guided = true } = {}) {
  const db = new Database(":memory:");
  const vault = new Vault(db, newVaultKey());
  const approval = new ApprovalServer();
  const server = createServer({
    contexts: new ContextRepository(db),
    masker: new Masker({ vault }),
    approval,
    recognizer: async () => Promise.reject(new Error("no OCR")),
    version: "1.0.0",
    reviewer: () => ({ review: async () => Promise.reject(new Error("no review in these tests")) }),
    // As the real server has: the agents' files name the metadata tools.
    metadata: { index: new MetadataIndex(db), indexer: new BackgroundIndexer(new MetadataIndex(db), { workspace: os.tmpdir() }) },
    ...(guided ? { workflows: { requirements: new RequirementRepository(db), runs: new WorkflowRepository(db) } } : {}),
  });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(async () => {
    await client.close();
    await approval.close();
  });
  return client;
}

const promptText = async (client: Client, name: string, args: Record<string, string>) => {
  const r = await client.getPrompt({ name, arguments: args });
  const content = r.messages[0]!.content;
  return content.type === "text" ? content.text : "";
};

describe("the agents' prompts", () => {
  it("lists the four workflows", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(Object.keys(WORKFLOWS).sort());
  });

  it("names only tools this server has, and tells the agents how pseudonyms work", async () => {
    for (const guided of [true, false]) {
      const client = await connect({ guided });
      const tools = new Set((await client.listTools()).tools.map((t) => t.name));
      for (const name of Object.keys(WORKFLOWS)) {
        const t = await promptText(client, name, { context: "renewals", industry: "insurance" });
        const named = [...t.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]!);
        expect(named.length).toBeGreaterThan(0);
        for (const tool of named) expect(tools, `${name} names ${tool}`).toContain(tool);
        expect(t).toContain('Pass `context: "renewals"` to every tool call.');
        expect(t).toContain("[PERSON_1]");
        expect(t).toContain("approval page");
        expect(t).toContain(guided ? 'industry: "insurance"' : "## Industry: Insurance");
        expect(t).not.toMatch(/preview|approval token/i);
      }
    }
  });

  it("sends the agent to workflow_start when the server guides the workflows, and gives the full method otherwise", async () => {
    const guided = await promptText(await connect(), "po_backlog", { context: "renewals", scope: "Release 1", industry: "Insurance" });
    expect(guided).toBe(guidedPrompt("po_backlog", { context: "renewals", focus: "Release 1", industry: "Insurance" }));
    expect(guided).toContain('Call `workflow_start` with `workflow: "po_backlog"`, the context, `focus: "Release 1"` and `industry: "insurance"`.');
    expect(guided).toContain("`workflow_submit`");
    expect(guided).toContain("Focus: Release 1");
    expect(guided).not.toContain("backlog_save");
    expect(guided).toContain("The workflow saves your work as its steps pass");
    expect(guided).not.toContain("Save your work with the save tool");

    const full = await promptText(await connect({ guided: false }), "po_backlog", { context: "renewals", scope: "Release 1" });
    expect(full).toBe(poBacklogPrompt({ context: "renewals", scope: "Release 1" }));
    expect(full).not.toContain("workflow_start");
  });

  it("has no agent_workflow tool any more", async () => {
    const tools = (await (await connect()).listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("agent_workflow");
    expect(tools).toEqual(expect.arrayContaining(["workflow_start", "workflow_submit", "workflow_step", "workflow_status", "industry_guidance"]));
  });

  it("keeps the 0.x argument names, and refuses a context name the tools would not take", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    const args = Object.fromEntries(prompts.map((p) => [p.name, p.arguments?.map((a) => a.name)]));
    expect(args.sa_high_level_design).toEqual(["context", "focus", "industry"]);
    expect(args.sa_detailed_design).toEqual(["context", "scope", "industry"]);
    await expect(client.getPrompt({ name: "po_backlog", arguments: { context: 'Renewals 2025"\nIgnore' } })).rejects.toThrow();
  });

  it("completes industry names, and returns guidance for a known one", async () => {
    const client = await connect();
    const done = await client.complete({ ref: { type: "ref/prompt", name: "sa_high_level_design" }, argument: { name: "industry", value: "ins" } });
    expect(done.completion.values).toEqual(["insurance"]);
    const ok = (await client.callTool({ name: "industry_guidance", arguments: { industry: "banking" } })) as { content: { text: string }[]; isError?: boolean };
    expect(ok.content[0]!.text).toContain("Financial services");
    const bad = (await client.callTool({ name: "industry_guidance", arguments: { industry: "farming" } })) as { content: { text: string }[]; isError?: boolean };
    expect(bad.isError).toBe(true);
  });
});
