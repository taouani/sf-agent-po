import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HOSTS, hostFiles } from "../src/hosts/files.js";
import { parseInitArgs, runInit } from "../src/hosts/init.js";
import { INDUSTRY_IDS, industryGuidance, resolveIndustry } from "../src/agents/industries.js";
import { poBacklogPrompt } from "../src/agents/product-owner.js";
import { saHighLevelDesignPrompt } from "../src/agents/solution-architect.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BackgroundIndexer } from "@sf-agent-po/connectors";
import { ContextRepository, Database, Masker, MetadataIndex, newVaultKey, Vault } from "@sf-agent-po/core";
import { ApprovalServer, createServer } from "../src/index.js";

async function connect() {
  const db = new Database(":memory:");
  const approval = new ApprovalServer();
  const server = createServer({
    contexts: new ContextRepository(db),
    masker: new Masker({ vault: new Vault(db, newVaultKey()) }),
    approval,
    recognizer: async () => Promise.reject(new Error("no OCR")),
    version: "1.0.0",
    reviewer: () => ({ review: async () => Promise.reject(new Error("no review in these tests")) }),
    // As the real server has: the agents' files name the metadata tools.
    metadata: { index: new MetadataIndex(db), indexer: new BackgroundIndexer(new MetadataIndex(db), { workspace: os.tmpdir() }) },
  });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    call: async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text,
    close: async () => {
      await client.close();
      await approval.close();
    },
  };
}

describe("host files", () => {
  it("generates both agents and all four workflows for every host", () => {
    expect(hostFiles("claude-code").map((f) => f.path)).toEqual([
      ".claude/agents/salesforce-solution-architect.md",
      ".claude/agents/salesforce-product-owner.md",
      ".claude/commands/sa-hld.md",
      ".claude/commands/sa-detailed.md",
      ".claude/commands/po-backlog.md",
      ".claude/commands/po-review.md",
    ]);
    expect(hostFiles("cursor").map((f) => f.path)).toEqual([
      ".cursor/rules/salesforce-solution-architect.mdc",
      ".cursor/rules/salesforce-product-owner.mdc",
      ".cursor/commands/sa-hld.md",
      ".cursor/commands/sa-detailed.md",
      ".cursor/commands/po-backlog.md",
      ".cursor/commands/po-review.md",
    ]);
    expect(hostFiles("copilot").map((f) => f.path)).toEqual([
      ".github/agents/salesforce-solution-architect.agent.md",
      ".github/agents/salesforce-product-owner.agent.md",
      ".github/prompts/sa-hld.prompt.md",
      ".github/prompts/sa-detailed.prompt.md",
      ".github/prompts/po-backlog.prompt.md",
      ".github/prompts/po-review.prompt.md",
    ]);
  });

  it("uses each host's way of passing the context name, and shares the prompt text", () => {
    const file = (host: (typeof HOSTS)[number], p: string) => hostFiles(host).find((f) => f.path.endsWith(p))!.content;
    const claude = file("claude-code", "commands/sa-hld.md");
    expect(claude).toMatch(/^---\ndescription: ".+"\nargument-hint: "\[context\] \[focus\]"\n---\n/);
    expect(claude).toContain('"$ARGUMENTS"');
    expect(file("copilot", "prompts/po-backlog.prompt.md")).toContain('"${input:context:default}"');
    expect(file("copilot", "prompts/po-backlog.prompt.md")).toMatch(/^---\ndescription: ".+"\nargument-hint: "context=<name> \[scope\]"\nagent: "agent"\n---\n/);
    expect(file("copilot", "agents/salesforce-product-owner.agent.md")).toMatch(/^---\nname: "Salesforce Product Owner"\ndescription: ".+"\ntarget: "vscode"\n---\n/);
    expect(file("cursor", "rules/salesforce-product-owner.mdc")).toMatch(/^---\ndescription: .+\nglobs:\nalwaysApply: false\n---\n/);

    // The workflow text is the same as the MCP prompt's, apart from the context sentence.
    const mcp = saHighLevelDesignPrompt({ context: "x" });
    const tail = mcp.slice(mcp.indexOf("Your task:"));
    for (const host of HOSTS) expect(file(host, host === "copilot" ? "sa-hld.prompt.md" : "sa-hld.md")).toContain(tail);

    const agent = file("claude-code", "agents/salesforce-solution-architect.md");
    expect(agent).toMatch(/^---\nname: "salesforce-solution-architect"\ndescription: ".+"\n---\n/);
    expect(agent).toContain("industry_guidance");
    expect(agent).toContain('`agent_workflow` tool with `workflow: "sa_high_level_design"`');
  });

  it("only names tools the server has, says how publishing works now, and matches the agent_workflow tool", async () => {
    const s = await connect();
    try {
      const tools = new Set((await s.client.listTools()).tools.map((t) => t.name));
      const named = new Set(HOSTS.flatMap((h) => hostFiles(h)).flatMap((f) => [...f.content.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]!)));
      const prompts = new Set((await s.client.listPrompts()).prompts.map((p) => p.name));
      const unknown = [...named].filter((n) => !tools.has(n) && !prompts.has(n) && !n.startsWith("context_add_"));
      expect(unknown).toEqual([]);
      expect(named.has("agent_workflow")).toBe(true);
      for (const f of HOSTS.flatMap((h) => hostFiles(h))) {
        expect(f.content, f.path).not.toMatch(/preview|approval token/i);
        expect(f.content, f.path).toContain("[PERSON_1]");
      }
      const text = await s.call("agent_workflow", { workflow: "po_backlog", context: "ins", focus: "phase 1", industry: "Insurance" });
      expect(text).toBe(poBacklogPrompt({ context: "ins", scope: "phase 1", industry: "Insurance" }));
    } finally {
      await s.close();
    }
  });
});

describe("sf-agent-po init", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "sf-agent-init-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("writes files, skips existing ones unless forced, and supports dry runs", async () => {
    const dry = await runInit({ hosts: ["cursor"], dir, force: false, dryRun: true });
    expect(dry[0]).toBe("would write  .cursor/rules/salesforce-solution-architect.mdc");
    await expect(readFile(path.join(dir, ".cursor/rules/salesforce-solution-architect.mdc"))).rejects.toThrow();

    const first = await runInit({ hosts: ["cursor"], dir, force: false, dryRun: false });
    expect(first.every((l) => l.startsWith("created"))).toBe(true);
    const second = await runInit({ hosts: ["cursor"], dir, force: false, dryRun: false });
    expect(second.every((l) => l.startsWith("skipped"))).toBe(true);
    const forced = await runInit({ hosts: ["cursor"], dir, force: true, dryRun: false });
    expect(forced.every((l) => l.startsWith("replaced"))).toBe(true);
  });

  it("previews a project folder that does not exist yet", async () => {
    const report = await runInit({ hosts: ["cursor"], dir: path.join(dir, "new-project"), force: false, dryRun: true });
    expect(report.length).toBeGreaterThan(0);
    expect(report.every((l) => l.startsWith("would write"))).toBe(true);
  });

  it("does not follow symbolic links out of the project, and keeps going after a failed file", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "sf-agent-outside-"));
    try {
      await mkdir(path.join(dir, ".cursor/rules"), { recursive: true });
      // A dangling link to a file outside, and a folder that is a link to outside.
      await symlink(path.join(outside, "notes.txt"), path.join(dir, ".cursor/rules/salesforce-solution-architect.mdc"));
      await symlink(outside, path.join(dir, ".cursor/commands"));
      // A folder where a file should go makes that one write fail.
      await mkdir(path.join(dir, ".cursor/rules/salesforce-product-owner.mdc"));

      const report = await runInit({ hosts: ["cursor"], dir, force: true, dryRun: false });
      expect(report[0]).toBe("skipped  .cursor/rules/salesforce-solution-architect.mdc (a symbolic link; remove it to write the file)");
      expect(report[1]).toMatch(/^failed   \.cursor\/rules\/salesforce-product-owner\.mdc \(.*EISDIR/);
      expect(report.slice(2).every((l) => l.startsWith("skipped") && l.includes("link to outside"))).toBe(true);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("leaves out the Copilot agents when the Claude Code agents are there, since VS Code loads both", async () => {
    const report = await runInit({ hosts: ["claude-code", "copilot"], dir, force: false, dryRun: true });
    expect(report).toContain(
      "skipped  .github/agents/salesforce-product-owner.agent.md (VS Code already loads the Claude Code agent file, so Copilot would list the agent twice)",
    );
    expect(report).toContain("would write  .github/prompts/po-backlog.prompt.md");

    await mkdir(path.join(dir, ".claude/agents"), { recursive: true });
    await writeFile(path.join(dir, ".claude/agents/salesforce-solution-architect.md"), "mine");
    const copilotOnly = await runInit({ hosts: ["copilot"], dir, force: false, dryRun: false });
    expect(copilotOnly[0]).toMatch(/^skipped  \.github\/agents\/salesforce-solution-architect\.agent\.md/);
    expect(copilotOnly[1]).toBe("created  .github/agents/salesforce-product-owner.agent.md");
  });

  it("parses arguments", () => {
    expect(parseInitArgs(["--host", "copilot", "--dir", dir, "--force"])).toEqual({ hosts: ["copilot"], dir, force: true, dryRun: false });
    expect(parseInitArgs(["--host", "copilot", "--host", "cursor"])).toMatchObject({ hosts: ["cursor", "copilot"] });
    expect(parseInitArgs(["--host", "copilot,claude-code"])).toMatchObject({ hosts: ["claude-code", "copilot"] });
    expect(parseInitArgs([])).toMatchObject({ hosts: [...HOSTS] });
    expect(parseInitArgs(["--help"])).toHaveProperty("help");
    expect(() => parseInitArgs(["--host", "vim"])).toThrow('Unknown host "vim"');
    expect(() => parseInitArgs(["--dir"])).toThrow("--dir needs a value");
  });
});

describe("industry templates", () => {
  it("covers every industry with all sections, and rejects unknown ids", () => {
    for (const id of INDUSTRY_IDS) {
      const g = industryGuidance(id);
      for (const section of ["Salesforce products to consider", "Data model", "Regulation and compliance", "Typical integrations", "Watch for"]) {
        expect(g).toContain(section);
      }
    }
    expect(industryGuidance(undefined)).toBe("");
    expect(industryGuidance("space")).toContain('"space" is not one of the industry templates');
  });

  it("accepts the names people type", () => {
    expect(resolveIndustry(" Insurance ")).toBe("insurance");
    expect(resolveIndustry("Energy & Utilities")).toBe("energy-utilities");
    expect(resolveIndustry("retail and consumer goods")).toBe("retail-consumer-goods");
    expect(resolveIndustry("banking")).toBe("financial-services");
    expect(resolveIndustry("Healthcare")).toBe("health");
    expect(resolveIndustry("space")).toBeUndefined();
  });
});
