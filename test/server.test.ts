import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
    const fakeFetch = (async (url: string) => {
      const body = url.includes("/rest/api/3/issue/")
        ? { key: "PORT-1", fields: { summary: "Online renewal", issuetype: { name: "Epic" }, status: { name: "To Do" }, description: null } }
        : { title: "Portal HLD", body: { storage: { value: "<p>Use Experience Cloud.</p>" } }, _links: { webui: "/spaces/SA/pages/42" } };
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
    expect(shown.text).toContain("7 documents");

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

  it("reports errors as tool errors", async () => {
    const r = await call("context_add_jira", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Provide issue keys or a JQL query");
  });
});
