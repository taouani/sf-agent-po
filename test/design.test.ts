import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeRequest, idFrom, startServer, tokenFrom } from "./helpers.js";

/** A minimal stateful Confluence: one space, pages created and updated in memory. */
function fakeConfluence() {
  const pages = new Map<string, { title: string; version: number; body: string }>();
  pages.set("500", { title: "Architecture", version: 3, body: "" });
  let nextId = 900;
  return (req: FakeRequest) => {
    if (req.path.startsWith("/wiki/api/v2/spaces?keys=SA")) return { body: { results: [{ id: "77", key: "SA" }] } };
    if (req.path.startsWith("/wiki/api/v2/spaces")) return { body: { results: [] } };
    const pageMatch = req.path.match(/^\/wiki\/api\/v2\/pages\/(\d+)/);
    if (req.method === "POST" && req.path === "/wiki/api/v2/pages") {
      const id = String(nextId++);
      pages.set(id, { title: req.body.title, version: 1, body: req.body.body.value });
      return { body: { id, title: req.body.title, version: { number: 1 }, _links: { webui: `/spaces/SA/pages/${id}` } } };
    }
    if (pageMatch && pages.has(pageMatch[1])) {
      const page = pages.get(pageMatch[1])!;
      if (req.method === "PUT") {
        if (req.body.version.number !== page.version + 1) return { status: 409, body: { message: "version conflict" } };
        Object.assign(page, { title: req.body.title, version: req.body.version.number, body: req.body.body.value });
      }
      return { body: { id: pageMatch[1], title: page.title, spaceId: "77", version: { number: page.version }, _links: { webui: `/spaces/SA/pages/${pageMatch[1]}` } } };
    }
    return undefined;
  };
}

describe("Solution Architect tools", () => {
  let s: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    s = await startServer(fakeConfluence());
  });
  afterEach(() => s.close());

  it("exposes the SA prompts with the context name filled in", async () => {
    const { prompts } = await s.client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(["sa_high_level_design", "sa_detailed_design"]));

    const hld = await s.client.getPrompt({ name: "sa_high_level_design", arguments: { context: "renewal", focus: "integrations" } });
    const body = (hld.messages[0].content as { text: string }).text;
    expect(body).toContain('`context: "renewal"`');
    expect(body).toContain("Focus on: integrations");
    expect(body).toContain("## 15. Traceability");
    expect(body).toContain("design_save");

    const detailed = await s.client.getPrompt({ name: "sa_detailed_design", arguments: {} });
    expect((detailed.messages[0].content as { text: string }).text).toContain('`context: "default"`');
  });

  it("versions designs and makes them readable as context for the PO", async () => {
    const first = await s.call("design_save", { title: "Renewal portal HLD", designType: "high-level", content: "# HLD\n\nv1" });
    expect(first.text).toContain("version 1");
    const same = await s.call("design_save", { title: "Renewal portal HLD", designType: "high-level", content: "# HLD\n\nv1" });
    expect(same.text).toContain("version 1");
    const second = await s.call("design_save", { title: "Renewal portal HLD", designType: "high-level", content: "# HLD\n\nv2" });
    expect(second.text).toContain("version 2");
    expect(idFrom(second.text)).toBe(idFrom(first.text));

    const designs = await s.call("context_read", { kinds: ["design"] });
    expect(designs.text).toContain("v2");
    expect(designs.text).toContain('"artifactType":"high-level"');
  });

  it("publishes only with a token from a matching preview, then updates the same page", async () => {
    const id = idFrom((await s.call("design_save", { title: "Renewal portal HLD", designType: "high-level", content: "# HLD\n\nUse Experience Cloud." })).text);

    const noSpace = await s.call("confluence_publish_preview", { artifactId: id });
    expect(noSpace.isError).toBe(true);
    expect(noSpace.text).toContain("which Confluence space");

    const preview = await s.call("confluence_publish_preview", { artifactId: id, spaceKey: "SA", parentPageId: "500" });
    expect(preview.text).toContain("Create a new page in space SA under parent page 500");
    expect(preview.text).toContain("Use Experience Cloud.");
    expect(s.requests.some((r) => r.method !== "GET")).toBe(false);

    const forged = await s.call("confluence_publish", { artifactId: id, spaceKey: "SA", parentPageId: "500", approvalToken: "AAAAAAAAAAAAAAAAAAAAAA" });
    expect(forged.isError).toBe(true);
    const otherTarget = await s.call("confluence_publish", { artifactId: id, spaceKey: "SA", approvalToken: tokenFrom(preview.text) });
    expect(otherTarget.isError).toBe(true);

    const created = await s.call("confluence_publish", { artifactId: id, spaceKey: "SA", parentPageId: "500", approvalToken: tokenFrom(preview.text) });
    expect(created.isError).toBeFalsy();
    expect(created.text).toContain("Created Confluence page");
    const post = s.requests.find((r) => r.method === "POST")!;
    expect(post.body).toMatchObject({ spaceId: "77", parentId: "500", title: "Renewal portal HLD", body: { representation: "storage" } });
    expect(post.body.body.value).toContain("<h1>HLD</h1>");

    // Editing the design invalidates the old preview and marks the design as changed since publishing.
    const saved = await s.call("design_save", { title: "Renewal portal HLD", designType: "high-level", content: "# HLD\n\nUse Experience Cloud and SSO." });
    expect(saved.text).toContain("status: changed");
    const stale = await s.call("confluence_publish", { artifactId: id, spaceKey: "SA", parentPageId: "500", approvalToken: tokenFrom(preview.text) });
    expect(stale.isError).toBe(true);

    const updatePreview = await s.call("confluence_publish_preview", { artifactId: id });
    expect(updatePreview.text).toContain('Update existing page "Renewal portal HLD"');
    const updated = await s.call("confluence_publish", { artifactId: id, approvalToken: tokenFrom(updatePreview.text) });
    expect(updated.text).toContain("Updated Confluence page");
    expect(updated.text).toContain("version 2");
    expect((await s.call("context_show")).text).toContain(id);
    expect((await s.call("context_read", { ids: [id] })).text).toContain('"status":"published"');
  });

  it("refuses to publish an input document", async () => {
    await s.call("context_add_text", { title: "Email", content: "Encrypt everything", kind: "email" });
    const shown = await s.call("context_show");
    const id = idFrom(shown.text);
    const r = await s.call("confluence_publish_preview", { artifactId: id, spaceKey: "SA" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not an artifact");
  });
});
