import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { AtlassianClient } from "../src/connectors/atlassian.js";
import { SalesforceOrg } from "../src/connectors/salesforce.js";

const fixtures = path.join(import.meta.dirname, "fixtures");

describe("MCP server", () => {
  let workspace: string;
  let client: Client;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "sf-agent-"));
    const epic = { key: "PORT-1", fields: { summary: "Online renewal", issuetype: { name: "Epic" }, status: { name: "To Do" }, description: null } };
    const fakeFetch = (async (url: string) => {
      let body: unknown;
      if (url.includes("/rest/api/3/issue/")) body = epic;
      else if (url.includes("/rest/api/3/search/jql")) body = { issues: [epic, { key: "PORT-2", fields: { summary: "Renewal reminders" } }], isLast: true };
      else if (url.includes("/wiki/api/v2/pages/42")) {
        body = { title: "Portal HLD", body: { storage: { value: "<p>Use Experience Cloud.</p>" } }, _links: { webui: "/spaces/SA/pages/42" } };
      } else return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const sfRunner = async (args: string[]) => {
      if (args[1] === "display") return { alias: "dev", username: "sa@example.com", instanceUrl: "https://dev.my.salesforce.com", accessToken: "SECRET" };
      if (args[1] === "list") return ["Policy__c"];
      return { name: "Policy__c", label: "Policy", custom: true, fields: [], recordTypeInfos: [], childRelationships: [] };
    };
    const server = createServer({
      workspaceDir: workspace,
      atlassian: new AtlassianClient({ siteUrl: "https://x.atlassian.net", email: "e", apiToken: "t" }, fakeFetch),
      salesforce: (alias) => new SalesforceOrg(alias, sfRunner),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterEach(async () => {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0].text, isError: r.isError };
  };

  it("builds a requirement context from every kind of source", async () => {
    await call("context_add_file", { context: "renewal", path: path.join(fixtures, "inputs") });
    await call("context_add_metadata", { context: "renewal", provider: "local", location: path.join(fixtures, "sfdx-project") });
    await call("context_add_jira", { context: "renewal", keys: ["PORT-1"] });
    await call("context_add_confluence", { context: "renewal", pages: ["42"] });
    await call("context_add_org", { context: "renewal", targetOrg: "dev", objects: ["Policy__c"] });
    await call("context_add_text", { context: "renewal", title: "SA notes", content: "Prefer Flow.", kind: "design" });

    const shown = await call("context_show", { context: "renewal" });
    expect(shown.text).toContain("8 documents");

    const full = await call("context_read", { context: "renewal" });
    expect(full.text).toContain("MFA is mandatory");
    expect(full.text).toContain("### Policy__c (Policy)");
    expect(full.text).toContain("PORT-1 Online renewal");
    expect(full.text).toContain("Use Experience Cloud.");
    expect(full.text).not.toContain("SECRET");

    const jiraOnly = await call("context_read", { context: "renewal", kinds: ["jira"] });
    expect(jiraOnly.text).toContain("PORT-1");
    expect(jiraOnly.text).not.toContain("MFA");

    expect((await call("context_list")).text).toBe("renewal");
  });

  it("re-adding the same source replaces it instead of duplicating", async () => {
    const file = path.join(fixtures, "inputs", "kickoff-notes.md");
    await call("context_add_file", { path: file });
    await call("context_add_file", { path: file, kind: "meeting-notes" });
    const shown = await call("context_show");
    expect(shown.text).toContain("1 documents");
    expect(shown.text).toContain("meeting-notes");
  });

  it("keeps every document when tools run in parallel", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => call("context_add_text", { title: `Note ${i}`, content: `Body ${i}`, kind: "meeting-notes" })),
    );
    expect((await call("context_show")).text).toContain("10 documents");
  });

  it("stores an issue once when it is listed by key and returned by JQL", async () => {
    await call("context_add_jira", { keys: ["PORT-1"], jql: "project = PORT" });
    const shown = await call("context_show");
    expect(shown.text).toContain("2 documents");
  });

  it("rejects a metadata location or ref that could be read as a CLI option", async () => {
    const r = await call("context_add_metadata", { provider: "git", location: "--upload-pack=touch /tmp/pwned" });
    expect(r.isError).toBe(true);
    const ref = await call("context_add_metadata", { provider: "github", location: "acme/core", ref: "-c" });
    expect(ref.isError).toBe(true);
  });

  it("clones a git repository, then updates it on the next call", async () => {
    const repo = path.join(workspace, "origin");
    await cp(path.join(fixtures, "sfdx-project"), repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "init");

    const first = await call("context_add_metadata", { provider: "git", location: `file://${repo}` });
    expect(first.isError).toBeFalsy();
    const second = await call("context_add_metadata", { provider: "git", location: `file://${repo}` });
    expect(second.isError).toBeFalsy();
    const full = await call("context_read", { kinds: ["metadata"] });
    expect(full.text).toContain("### Policy__c (Policy)");
    // Real git processes: about 1 s on Linux, but Windows runners have taken over 5 s.
  }, 30_000);

  it("reports errors as tool errors", async () => {
    const r = await call("context_add_jira", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Provide issue keys or a JQL query");
  });
});
