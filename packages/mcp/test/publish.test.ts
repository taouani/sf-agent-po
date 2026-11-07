import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AtlassianClient } from "@sf-agent-po/connectors";
import { ContextRepository, Database, Masker, newVaultKey, Vault, type EntityDetector, type Span } from "@sf-agent-po/core";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, createServer, pageLink, requestDigest, type ApprovalRequest, type Decision, type Reviewer } from "../src/index.js";

const fakeModel =
  (names: readonly string[]): EntityDetector =>
  async (text) => {
    const spans: Span[] = [];
    for (const name of names) for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) spans.push({ start: i, end: i + name.length, type: "PER", source: "ner" });
    return spans;
  };

/** Confluence as far as publishing uses it, recording what was written. */
function fakeConfluence() {
  const pages = new Map<string, { title: string; storage: string; version: number; spaceId: string }>();
  const writes: { title: string; storage: string }[] = [];
  let next = 100;
  const url = (id: string, title: string) => `https://acme.atlassian.net/wiki/spaces/ENG/pages/${id}/${encodeURIComponent(title)}`;
  const client = {
    getSpaceId: async (key: string) => (key === "ENG" ? "1" : Promise.reject(new Error(`Confluence space "${key}" was not found`))),
    getPageSummary: async (id: string) => {
      const p = pages.get(id);
      if (!p) throw new Error("not found");
      return { pageId: id, title: p.title, spaceId: p.spaceId, version: p.version, url: url(id, p.title) };
    },
    createPage: async (input: { spaceId: string; title: string; storage: string }) => {
      const id = String(next++);
      pages.set(id, { title: input.title, storage: input.storage, version: 1, spaceId: input.spaceId });
      writes.push(input);
      return { pageId: id, url: url(id, input.title), version: 1 };
    },
    updatePage: async (input: { pageId: string; expectedVersion: number; title: string; storage: string }) => {
      const p = pages.get(input.pageId)!;
      if (p.version !== input.expectedVersion) throw new Error("The page changed in Confluence after the preview.");
      Object.assign(p, { title: input.title, storage: input.storage, version: p.version + 1 });
      writes.push(input);
      return { pageId: input.pageId, url: url(input.pageId, input.title), version: p.version };
    },
  };
  return { client: client as unknown as AtlassianClient, pages, writes };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function connect(answers: (Partial<Omit<Decision, "digest">> | ((req: ApprovalRequest) => Decision))[] = []) {
  const db = new Database(":memory:");
  const vault = new Vault(db, newVaultKey());
  const contexts = new ContextRepository(db);
  const masker = new Masker({ vault, model: fakeModel(["Karim Benali", "Lea Martin"]) });
  const approval = new ApprovalServer();
  const confluence = fakeConfluence();
  const seen: ApprovalRequest[] = [];
  const reviewer: Reviewer = {
    async review(req) {
      seen.push(req);
      const a = answers.shift() ?? { status: "approved" };
      return typeof a === "function" ? a(req) : { status: "approved", missed: [], ...a, digest: requestDigest(req) };
    },
  };
  const server = createServer({ contexts, masker, approval, recognizer: async () => Promise.reject(new Error("no OCR")), version: "1.0.0", reviewer: () => reviewer, atlassian: () => confluence.client });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(async () => {
    await client.close();
    await approval.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: r.isError, text: r.content.map((c) => c.text).join("\n") };
  };
  // An input, so the context knows Karim Benali as [PERSON_1].
  await call("context_add_text", { context: "acme", title: "Call", content: "Karim Benali owns the VIP flag. Login secret: password: hunter22x", kind: "meeting-notes" });
  return { call, contexts, seen, confluence, masker };
}

const design = "# VIP flag\n\nOwner: [PERSON_1]. Reviewer: Lea Martin. Service login stays [SECRET_1].";

describe("saving designs", () => {
  it("keeps the pseudonyms the agent used, masks names written in clear, and versions the design", async () => {
    const { call, contexts } = await connect();
    const r = await call("design_save", { context: "acme", title: "VIP flag for Karim Benali", designType: "high-level", content: design });
    expect(r.text).toContain('Saved high-level design "VIP flag for [PERSON_1]"');
    expect(r.text).toContain("version 1");
    expect(r.text).toContain("2 value(s) written in clear were masked");
    const saved = contexts.documents("acme").find((d) => d.kind === "design")!;
    expect(saved.content).toBe("# VIP flag\n\nOwner: [PERSON_1]. Reviewer: [PERSON_2]. Service login stays [SECRET_1].");
    expect(saved.source).not.toContain("karim");
    expect((await call("design_save", { context: "acme", title: "VIP flag for Karim Benali", designType: "high-level", content: design + "\nMore." })).text).toContain("version 2");
  });
});

describe("publishing to Confluence", () => {
  it("shows the user the real values, writes exactly that once approved, and tells the model only pseudonyms", async () => {
    const { call, contexts, seen, confluence } = await connect();
    const saved = await call("design_save", { context: "acme", title: "VIP flag for Karim Benali", designType: "high-level", content: design });
    const id = /as (doc-\w+)/.exec(saved.text)![1]!;
    const r = await call("confluence_publish", { context: "acme", artifactId: id, spaceKey: "ENG" });
    expect(r.isError).toBeFalsy();

    const shown = seen.at(-1)!;
    expect(shown).toMatchObject({ kind: "publish", title: "VIP flag for Karim Benali", kept: ["[SECRET_1]"] });
    expect(shown.kind === "publish" && shown.body).toContain("Owner: Karim Benali. Reviewer: Lea Martin. Service login stays [SECRET_1].");
    expect(shown.kind === "publish" && shown.target).toContain("a new page in space ENG");

    expect(confluence.writes).toHaveLength(1);
    expect(confluence.writes[0]!.title).toBe("VIP flag for Karim Benali");
    expect(confluence.writes[0]!.storage).toContain("Owner: Karim Benali.");
    expect(confluence.writes[0]!.storage).not.toContain("hunter");

    expect(r.text).toContain('Created the Confluence page for "VIP flag for [PERSON_1]"');
    expect(r.text).toContain("https://acme.atlassian.net/wiki/spaces/ENG/pages/100");
    expect(r.text).not.toMatch(/Karim|Lea/);
    const meta = contexts.getDocument("acme", id)!.metadata as { status: string; confluence: { url: string } };
    expect(meta.status).toBe("published");
    expect(meta.confluence.url).toBe("https://acme.atlassian.net/wiki/spaces/ENG/pages/100");
  });

  it("writes nothing when the user rejects, and passes on their comment masked", async () => {
    const { call, confluence } = await connect([{ status: "rejected", comment: "Ask Lea Martin first." }]);
    const saved = await call("design_save", { context: "acme", title: "VIP flag", designType: "high-level", content: design });
    const id = /as (doc-\w+)/.exec(saved.text)![1]!;
    const r = await call("confluence_publish", { context: "acme", artifactId: id, spaceKey: "ENG" });
    expect(r.text).toContain("Nothing was written: the user rejected it. Their comment: Ask [PERSON_2] first.");
    expect(confluence.writes).toEqual([]);
  });

  it("refuses a decision about anything but what was shown", async () => {
    const { call, confluence } = await connect([(req) => ({ status: "approved", missed: [], digest: requestDigest({ ...req, title: "other" } as ApprovalRequest) })]);
    const saved = await call("design_save", { context: "acme", title: "VIP flag", designType: "high-level", content: design });
    const id = /as (doc-\w+)/.exec(saved.text)![1]!;
    const r = await call("confluence_publish", { context: "acme", artifactId: id, spaceKey: "ENG" });
    expect(r.isError).toBe(true);
    expect(confluence.writes).toEqual([]);
  });

  it("updates the design's own page, and warns the user when it was edited in Confluence", async () => {
    const { call, seen, confluence } = await connect();
    const saved = await call("design_save", { context: "acme", title: "VIP flag", designType: "high-level", content: design });
    const id = /as (doc-\w+)/.exec(saved.text)![1]!;
    await call("confluence_publish", { context: "acme", artifactId: id, spaceKey: "ENG" });
    confluence.pages.get("100")!.version = 3; // someone edited it
    await call("design_save", { context: "acme", title: "VIP flag", designType: "high-level", content: design + "\nv2" });
    const r = await call("confluence_publish", { context: "acme", artifactId: id });
    expect(r.text).toContain("Updated the Confluence page");
    const shown = seen.at(-1)!;
    expect(shown.kind === "publish" && shown.target).toContain("edited in Confluence since it was last published");
    expect(confluence.writes.at(-1)).toMatchObject({ pageId: "100", expectedVersion: 3 });
  });

  it("refuses to publish an input", async () => {
    const { call, contexts } = await connect();
    const input = contexts.documents("acme")[0]!;
    const r = await call("confluence_publish", { context: "acme", artifactId: input.id, spaceKey: "ENG" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not an artifact");
  });

  it("drops a page title from a link", () => {
    expect(pageLink("https://x.atlassian.net/wiki/spaces/ENG/pages/123/Call+with+Karim?focus=1")).toBe("https://x.atlassian.net/wiki/spaces/ENG/pages/123?focus=1");
    expect(pageLink("https://x.atlassian.net/wiki/pages/viewpage.action?pageId=5")).toBe("https://x.atlassian.net/wiki/pages/viewpage.action?pageId=5");
  });
});
