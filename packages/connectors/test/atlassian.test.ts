import { describe, expect, it } from "vitest";
import { AtlassianClient, AtlassianError, adfToText, atlassianConfigFromEnv, confluencePageId } from "../src/atlassian.js";

describe("Atlassian helpers", () => {
  it("converts ADF to text", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Goal" }] },
        { type: "paragraph", content: [{ type: "text", text: "Renew online." }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "MFA" }] }] }] },
      ],
    };
    expect(adfToText(adf)).toBe("## Goal\n\nRenew online.\n\n- MFA\n\n");
  });

  it("keeps task items, links, cards and status in ADF", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { state: "DONE" }, content: [{ type: "text", text: "Confirm MFA vendor" }] },
            { type: "taskItem", attrs: { state: "TODO" }, content: [{ type: "text", text: "Agree SLA" }] },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "See spec", marks: [{ type: "link", attrs: { href: "https://example.com/spec" } }] },
            { type: "text", text: " " },
            { type: "status", attrs: { text: "APPROVED" } },
            { type: "text", text: " " },
            { type: "inlineCard", attrs: { url: "https://example.com/card" } },
          ],
        },
      ],
    };
    expect(adfToText(adf)).toBe(
      "- [x] Confirm MFA vendor\n- [ ] Agree SLA\n\nSee spec (https://example.com/spec) [APPROVED] https://example.com/card\n\n",
    );
  });

  it("extracts Confluence page ids from URLs", () => {
    expect(confluencePageId("12345")).toBe("12345");
    expect(confluencePageId("https://x.atlassian.net/wiki/spaces/SA/pages/98765/Design")).toBe("98765");
    expect(confluencePageId("https://x.atlassian.net/wiki/spaces/SA/pages/edit-v2/98765")).toBe("98765");
    expect(() => confluencePageId("not a page")).toThrow();
  });

  it("pages through Jira search results", async () => {
    const bodies: any[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      bodies.push(body);
      const page = body.nextPageToken ? 2 : 1;
      const issues = [1, 2].map((n) => ({ key: `PORT-${(page - 1) * 2 + n}`, fields: { summary: "s" } }));
      return new Response(JSON.stringify(page === 1 ? { issues, nextPageToken: "t2", isLast: false } : { issues, isLast: true }));
    }) as typeof fetch;
    const client = new AtlassianClient({ siteUrl: "https://x.atlassian.net", email: "e", apiToken: "t" }, fakeFetch);

    const docs = await client.searchIssues("project = PORT", 3);
    expect(docs.map((d) => d.metadata?.key)).toEqual(["PORT-1", "PORT-2", "PORT-3"]);
    expect(bodies.map((b) => [b.maxResults, b.nextPageToken])).toEqual([
      [3, undefined],
      [1, "t2"],
    ]);
  });
});

describe("AtlassianClient", () => {
  interface Call {
    method: string;
    path: string;
    auth: string | null;
    body?: any;
  }
  /** A fake site: `routes` maps "METHOD /path" prefixes to a status and body. */
  const site = (routes: Record<string, { status?: number; body?: unknown }>) => {
    const calls: Call[] = [];
    const fakeFetch = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = url.replace("https://x.atlassian.net", "");
      const headers = new Headers(init.headers);
      calls.push({ method, path, auth: headers.get("Authorization"), body: init.body ? JSON.parse(init.body as string) : undefined });
      const route = Object.entries(routes).find(([k]) => `${method} ${path}`.startsWith(k))?.[1];
      if (!route) return new Response("not found", { status: 404 });
      return new Response(route.body === undefined ? null : JSON.stringify(route.body), { status: route.status ?? 200 });
    }) as typeof fetch;
    return { calls, client: new AtlassianClient({ siteUrl: "https://x.atlassian.net", email: "me@example.com", apiToken: "tok" }, fakeFetch) };
  };

  it("reads the site settings from the environment", () => {
    expect(atlassianConfigFromEnv({ ATLASSIAN_SITE_URL: "https://x.atlassian.net//", ATLASSIAN_EMAIL: "e", ATLASSIAN_API_TOKEN: "t" })).toEqual({
      siteUrl: "https://x.atlassian.net",
      email: "e",
      apiToken: "t",
    });
    expect(atlassianConfigFromEnv({ ATLASSIAN_SITE_URL: "https://x.atlassian.net" })).toBeUndefined();
  });

  it("reads an issue as a document, with basic authentication", async () => {
    const { client, calls } = site({
      "GET /rest/api/3/issue/LUX-7": {
        body: {
          key: "LUX-7",
          fields: {
            summary: "Clienteling app",
            issuetype: { name: "Story" },
            status: { name: "To Do" },
            priority: { name: "High" },
            parent: { key: "LUX-1", fields: { summary: "Boutique" } },
            labels: ["paris"],
            description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "As an advisor..." }] }] },
          },
        },
      },
    });
    const doc = await client.getIssue("LUX-7");
    expect(doc).toEqual({
      kind: "jira",
      title: "LUX-7 Clienteling app",
      source: "https://x.atlassian.net/browse/LUX-7",
      content: "Type: Story\nStatus: To Do\nPriority: High\nParent: LUX-1 Boutique\nLabels: paris\n\nAs an advisor...",
      metadata: { key: "LUX-7", type: "Story", status: "To Do" },
    });
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from("me@example.com:tok").toString("base64")}`);
  });

  it("reads a Confluence page as text", async () => {
    const { client } = site({
      "GET /wiki/api/v2/pages/42?body-format=storage": {
        body: { title: "HLD", spaceId: "7", version: { number: 3 }, body: { storage: { value: "<p>Use &amp; reuse.</p>" } }, _links: { webui: "/spaces/SA/pages/42" } },
      },
    });
    expect(await client.getPage("https://x.atlassian.net/wiki/spaces/SA/pages/42/HLD")).toEqual({
      kind: "confluence",
      title: "HLD",
      source: "https://x.atlassian.net/wiki/spaces/SA/pages/42",
      content: "Use & reuse.",
      metadata: { pageId: "42", spaceId: "7", version: 3 },
    });
  });

  it("creates and updates issues, and links them the right way round", async () => {
    const { client, calls } = site({
      // Routes match by prefix, so the longer path comes first.
      "POST /rest/api/3/issueLink": { status: 201 },
      "POST /rest/api/3/issue": { status: 201, body: { key: "LUX-8" } },
      "PUT /rest/api/3/issue/LUX-8": { status: 204 },
      "GET /rest/api/3/issue/LUX-8?fields=updated": { body: { fields: { updated: "2026-11-07T10:00:00.000+0100", summary: "S", parent: { key: "LUX-1" } } } },
    });
    expect(await client.createIssue({ summary: "S" })).toEqual({ key: "LUX-8", url: "https://x.atlassian.net/browse/LUX-8" });
    expect(await client.updateIssue("LUX-8", { summary: "T" })).toEqual({ key: "LUX-8", url: "https://x.atlassian.net/browse/LUX-8" });
    await client.linkBlocks("LUX-8", "LUX-9");
    expect(await client.getIssueState("LUX-8")).toEqual({ updated: "2026-11-07T10:00:00.000+0100", summary: "S", parentKey: "LUX-1", labels: [] });
    expect(calls.find((c) => c.path === "/rest/api/3/issueLink")?.body).toEqual({
      type: { name: "Blocks" },
      inwardIssue: { key: "LUX-8" },
      outwardIssue: { key: "LUX-9" },
    });
  });

  it("reads stories in bulk, 100 per call, with only the status category", async () => {
    const issues = Array.from({ length: 150 }, (_, i) => ({
      key: `LUX-${i + 1}`,
      fields: { summary: `S${i + 1}`, status: { name: "Waiting for the CFO", statusCategory: { key: i ? "indeterminate" : "unknown" } }, updated: "u", customfield_10016: i === 1 ? 5 : null },
    }));
    const { client, calls } = site({ "POST /rest/api/3/issue/bulkfetch": { body: { issues: issues.slice(0, 2) } } });
    const keys = issues.map((i) => i.key);
    const got = await client.getStories(keys, "customfield_10016");
    expect(calls.map((c) => c.body.issueIdsOrKeys.length)).toEqual([100, 50]);
    expect(calls[0]!.body.fields).toEqual(["summary", "description", "status", "updated", "customfield_10016"]);
    // The status name is the team's text: only its category comes back.
    expect(got.get("LUX-1")).toEqual({ summary: "S1", updated: "u" });
    expect(got.get("LUX-2")).toEqual({ summary: "S2", status: "indeterminate", updated: "u", points: 5 });
    await expect(client.getStories(["LUX-1"], "summary")).rejects.toThrow(/Not a custom field id/);
  });

  it("creates pages and updates them only from the version the user saw", async () => {
    const { client, calls } = site({
      "GET /wiki/api/v2/spaces?keys=SA": { body: { results: [{ id: 7 }] } },
      "POST /wiki/api/v2/pages": { body: { id: 99, version: { number: 1 }, _links: { webui: "/spaces/SA/pages/99" } } },
      "PUT /wiki/api/v2/pages/99": { body: { version: { number: 2 } } },
      "PUT /wiki/api/v2/pages/100": { status: 409, body: { message: "version conflict" } },
    });
    const spaceId = await client.getSpaceId("SA");
    expect(await client.createPage({ spaceId, parentId: "5", title: "HLD", storage: "<p>x</p>" })).toEqual({
      pageId: "99",
      url: "https://x.atlassian.net/wiki/spaces/SA/pages/99",
      version: 1,
    });
    expect((await client.updatePage({ pageId: "99", expectedVersion: 1, title: "HLD", storage: "<p>y</p>" })).version).toBe(2);
    expect(calls.find((c) => c.method === "PUT")?.body.version).toEqual({ number: 2, message: "Updated by sf-agent-po" });
    await expect(client.updatePage({ pageId: "100", expectedVersion: 4, title: "HLD", storage: "" })).rejects.toThrow(/no longer at version 4\). Nothing was written/);
  });

  it("reports failed requests with their status", async () => {
    const { client } = site({});
    await expect(client.getSpaceId("NOPE")).rejects.toBeInstanceOf(AtlassianError);
    await expect(client.getProject("NOPE")).rejects.toMatchObject({ status: 404 });
  });
});
