import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HOSTS, hostFiles } from "../src/hosts/files.js";
import { parseInitArgs, runInit } from "../src/hosts/init.js";
import { INDUSTRY_IDS, industryGuidance } from "../src/agents/industries.js";
import { saHighLevelDesignPrompt } from "../src/agents/solution-architect.js";
import { documentId } from "../src/context/store.js";
import { startServer } from "./helpers.js";

const examples = path.join(import.meta.dirname, "..", "examples");

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
    expect(file("copilot", "prompts/po-backlog.prompt.md")).toMatch(/^---\ndescription: ".+"\nagent: "agent"\n---\n/);
    expect(file("cursor", "rules/salesforce-product-owner.mdc")).toMatch(/^---\ndescription: .+\nglobs:\nalwaysApply: false\n---\n/);

    // The workflow text is the same as the MCP prompt's, apart from the context sentence.
    const mcp = saHighLevelDesignPrompt({ context: "x" });
    const tail = mcp.slice(mcp.indexOf("Your task:"));
    for (const host of HOSTS) expect(file(host, host === "copilot" ? "sa-hld.prompt.md" : "sa-hld.md")).toContain(tail);

    const agent = file("claude-code", "agents/salesforce-solution-architect.md");
    expect(agent).toMatch(/^---\nname: "salesforce-solution-architect"\ndescription: ".+"\n---\n/);
    expect(agent).toContain("industry_guidance");
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

  it("parses arguments", () => {
    expect(parseInitArgs(["--host", "copilot", "--dir", dir, "--force"])).toEqual({ hosts: ["copilot"], dir, force: true, dryRun: false });
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
    expect(() => industryGuidance("space")).toThrow("Unknown industry");
  });

  it("is available as a prompt argument with completion, and as a tool", async () => {
    const s = await startServer(() => undefined);
    try {
      const p = await s.client.getPrompt({ name: "po_backlog", arguments: { context: "c", industry: "insurance" } });
      expect((p.messages[0].content as { text: string }).text).toContain("## Industry: Insurance");

      const completion = await s.client.complete({
        ref: { type: "ref/prompt", name: "sa_high_level_design" },
        argument: { name: "industry", value: "fin" },
      });
      expect(completion.completion.values).toEqual(["financial-services"]);

      const tool = await s.call("industry_guidance", { industry: "health" });
      expect(tool.text).toContain("HIPAA");
    } finally {
      await s.close();
    }
  });
});

describe("sample scenarios", () => {
  it("accepts the insurance reference backlog with every security input traced", async () => {
    const s = await startServer(() => undefined);
    try {
      const scenario = path.join(examples, "insurance-renewal");
      expect((await s.call("context_add_file", { context: "ins", path: path.join(scenario, "inputs") })).text).toContain("Added 4 document(s)");
      expect((await s.call("context_add_metadata", { context: "ins", provider: "local", location: path.join(scenario, "metadata") })).isError).toBeFalsy();

      const raw = await readFile(path.join(scenario, "reference-backlog.json"), "utf8");
      const backlog = JSON.parse(raw.replace(/\{\{(inputs\/[^}]+)\}\}/g, (_, rel: string) => documentId(path.resolve(scenario, rel))));
      const saved = await s.call("backlog_save", { context: "ins", backlog });
      expect(saved.isError).toBeFalsy();
      expect(saved.text).not.toContain("ERROR");
      expect(saved.text).not.toContain("WARNING");
    } finally {
      await s.close();
    }
  });

  it("loads the banking scenario", async () => {
    const s = await startServer(() => undefined);
    try {
      const r = await s.call("context_add_file", { context: "bank", path: path.join(examples, "banking-onboarding", "inputs") });
      expect(r.text).toContain("Added 3 document(s)");
      expect(r.text).toContain("Non-negotiables for the onboarding redesign");
    } finally {
      await s.close();
    }
  });
});
