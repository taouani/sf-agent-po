import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeRequest, idFrom, startServer, tokenFrom } from "./helpers.js";
import { AtlassianClient } from "../src/connectors/atlassian.js";

type FakePage = { title: string; version: number; body: string; spaceId: string };

/** A minimal stateful Confluence: two spaces, pages created and updated in memory. Tests can edit or delete pages through `pages`. */
function fakeConfluence() {
  const pages = new Map<string, FakePage>();
  pages.set("500", { title: "Architecture", version: 3, body: "", spaceId: "77" });
  pages.set("600", { title: "Other space home", version: 1, body: "", spaceId: "88" });
  let nextId = 900;
  const handler = (req: FakeRequest) => {
    if (req.path.startsWith("/wiki/api/v2/spaces?keys=SA")) return { body: { results: [{ id: "77", key: "SA" }] } };
    if (req.path.startsWith("/wiki/api/v2/spaces")) return { body: { results: [] } };
    const pageMatch = req.path.match(/^\/wiki\/api\/v2\/pages\/(\d+)/);
    if (req.method === "POST" && req.path === "/wiki/api/v2/pages") {
      const id = String(nextId++);
      pages.set(id, { title: req.body.title, version: 1, body: req.body.body.value, spaceId: req.body.spaceId });
      return { body: { id, title: req.body.title, version: { number: 1 }, _links: { webui: `/spaces/SA/pages/${id}` } } };
    }
    if (pageMatch && pages.has(pageMatch[1])) {
      const page = pages.get(pageMatch[1])!;
      if (req.method === "PUT") {
        if (req.body.version.number !== page.version + 1) return { status: 409, body: { message: "version conflict" } };
        Object.assign(page, { title: req.body.title, version: req.body.version.number, body: req.body.body.value });
      }
      return { body: { id: pageMatch[1], title: page.title, spaceId: page.spaceId, version: { number: page.version }, _links: { webui: `/spaces/SA/pages/${pageMatch[1]}` } } };
    }
    return undefined;
  };
  return Object.assign(handler, { pages });
}

describe("Solution Architect tools", () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let confluence: ReturnType<typeof fakeConfluence>;

  beforeEach(async () => {
    confluence = fakeConfluence();
    s = await startServer(confluence);
  });
  afterEach(() => s.close());

  it("exposes the SA prompts with the context name filled in", async () => {
    const { prompts } = await s.client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(["sa_high_level_design", "sa_detailed_design"]));

    const hld = await s.client.getPrompt({ name: "sa_high_level_design", arguments: { context: "renewal", focus: "integrations" } });
    const body = (hld.messages[0].content as { text: string }).text;
    expect(body).toContain('`context: "renewal"`');
    expect(body).toContain("Focus on: integrations");
    expect(body).toContain("## 16. Traceability");
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
    expect(preview.text).toContain('create a new page in space SA under "Architecture" (500)');
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
    expect(updatePreview.text).toContain('replace the content of page "Renewal portal HLD"');
    expect(updatePreview.text).not.toContain("WARNING");
    const updated = await s.call("confluence_publish", { artifactId: id, approvalToken: tokenFrom(updatePreview.text) });
    expect(updated.text).toContain("Updated Confluence page");
    expect(updated.text).toContain("version 2");
    expect((await s.call("context_show")).text).toContain(id);
    expect((await s.call("context_read", { ids: [id] })).text).toContain('"status":"published"');
  });

  const publishNew = async (title: string, content = "# HLD") => {
    const id = idFrom((await s.call("design_save", { title, designType: "high-level", content })).text);
    const preview = await s.call("confluence_publish_preview", { artifactId: id, spaceKey: "SA" });
    const created = await s.call("confluence_publish", { artifactId: id, spaceKey: "SA", approvalToken: tokenFrom(preview.text) });
    expect(created.isError).toBeFalsy();
    return { id, pageId: created.text.match(/pages\/(\d+)/)![1] };
  };

  it("never overwrites edits made in Confluence after the preview, and warns about earlier ones", async () => {
    const { id, pageId } = await publishNew("Renewal portal HLD");
    await s.call("design_save", { title: "Renewal portal HLD", designType: "high-level", content: "# HLD v2" });

    confluence.pages.get(pageId)!.version = 3; // a BA edited the page twice
    const preview = await s.call("confluence_publish_preview", { artifactId: id });
    expect(preview.text).toContain("WARNING: the page was edited in Confluence since it was last published (version 1 then, 3 now)");

    confluence.pages.get(pageId)!.version = 4; // and once more after the preview
    const r = await s.call("confluence_publish", { artifactId: id, approvalToken: tokenFrom(preview.text) });
    expect(r.isError).toBe(true);
    expect(s.requests.filter((q) => q.method === "PUT")).toEqual([]);

    // Between the preview and the write, Confluence's own version check still catches a change.
    const client = new AtlassianClient({ siteUrl: "https://x.atlassian.net", email: "e", apiToken: "t" }, (async (url: string, init: RequestInit = {}) => {
      const res = confluence({ method: init.method ?? "GET", path: url.replace("https://x.atlassian.net", ""), body: init.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify(res!.body), { status: res!.status ?? 200 });
    }) as typeof fetch);
    await expect(client.updatePage({ pageId, expectedVersion: 3, title: "t", storage: "<p/>" })).rejects.toThrow("changed in Confluence after the preview");
    expect(confluence.pages.get(pageId)!.version).toBe(4);
  });

  it("ties the token to the title, and does not let it be replayed", async () => {
    const id = idFrom((await s.call("design_save", { title: "Renewal portal HLD", designType: "high-level", content: "# HLD" })).text);
    const preview = await s.call("confluence_publish_preview", { artifactId: id, spaceKey: "SA", newPage: true });
    const token = tokenFrom(preview.text);
    expect((await s.call("confluence_publish", { artifactId: id, spaceKey: "SA", newPage: true, title: "Other", approvalToken: token })).isError).toBe(true);
    expect((await s.call("confluence_publish", { artifactId: id, spaceKey: "SA", newPage: true, approvalToken: token })).isError).toBeFalsy();
    expect((await s.call("confluence_publish", { artifactId: id, spaceKey: "SA", newPage: true, approvalToken: token })).isError).toBe(true);
    expect(s.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  it("explains how to recover when the artifact's page was deleted", async () => {
    const { id, pageId } = await publishNew("Renewal portal HLD");
    confluence.pages.delete(pageId);
    const r = await s.call("confluence_publish_preview", { artifactId: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("pass newPage: true with a spaceKey");
  });

  it("rejects a parent page from another space", async () => {
    const id = idFrom((await s.call("design_save", { title: "Renewal portal HLD", designType: "high-level", content: "# HLD" })).text);
    const r = await s.call("confluence_publish_preview", { artifactId: id, spaceKey: "SA", parentPageId: "600" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Parent page "Other space home" is not in space SA');
  });

  it("keeps designs apart by type and by non-Latin title", async () => {
    const ids = [
      idFrom((await s.call("design_save", { title: "تصميم البوابة", designType: "high-level", content: "a" })).text),
      idFrom((await s.call("design_save", { title: "設計書の概要", designType: "detailed", content: "b" })).text),
      idFrom((await s.call("design_save", { title: "Portal", designType: "high-level", content: "c" })).text),
      idFrom((await s.call("design_save", { title: "Portal", designType: "detailed", content: "d" })).text),
    ];
    expect(new Set(ids).size).toBe(4);
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

describe("publish confirmation through elicitation", () => {
  it("writes nothing when the user declines, and publishes when they accept", async () => {
    let answer: "accept" | "decline" = "decline";
    const s = await startServer(fakeConfluence(), {
      elicit: () => (answer === "accept" ? { action: "accept", content: { confirm: true } } : { action: "decline" }),
    });
    try {
      const id = idFrom((await s.call("design_save", { title: "Renewal portal HLD", designType: "high-level", content: "# HLD" })).text);
      const preview = await s.call("confluence_publish_preview", { artifactId: id, spaceKey: "SA" });
      const declined = await s.call("confluence_publish", { artifactId: id, spaceKey: "SA", approvalToken: tokenFrom(preview.text) });
      expect(declined.isError).toBe(true);
      expect(declined.text).toContain("did not confirm");
      expect(s.elicitations).toEqual(['Create Confluence page "Renewal portal HLD" in space SA?']);
      expect(s.requests.filter((q) => q.method === "POST")).toEqual([]);

      answer = "accept";
      const accepted = await s.call("confluence_publish", { artifactId: id, spaceKey: "SA", approvalToken: tokenFrom(preview.text) });
      expect(accepted.isError).toBeFalsy();
    } finally {
      await s.close();
    }
  });
});
