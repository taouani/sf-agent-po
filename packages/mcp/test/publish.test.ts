import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AtlassianError, type AtlassianClient } from "@sf-agent-po/connectors";
import { ContextRepository, Database, Masker, newVaultKey, RequirementRepository, Vault, WorkflowRepository, type EntityDetector, type Span } from "@sf-agent-po/core";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer, createServer, pageLink, requestDigest, saveArtifact, saveBacklog, type ApprovalRequest, type Decision, type Reviewer } from "../src/index.js";

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
      if (!p) throw new AtlassianError("Page not found: Call with Karim Benali", 404);
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
  const requirements = new RequirementRepository(db);
  const server = createServer({
    contexts,
    masker,
    approval,
    recognizer: async () => Promise.reject(new Error("no OCR")),
    version: "1.0.0",
    reviewer: () => reviewer,
    atlassian: () => confluence.client,
    workflows: { requirements, runs: new WorkflowRepository(db) },
  });
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
  return { call, contexts, seen, confluence, masker, vault, requirements };
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

  it("puts values in so that they cannot change the page: tables, newlines, links, XML", async () => {
    const { call, confluence, masker } = await connect();
    masker.remember("acme", [{ type: "PERSON", value: "*Jean* | Roux & <Co>" }, { type: "ADDRESS", value: "12 rue X\n75001 Paris" }, { type: "PERSON", value: "[x](http://evil)" }]);
    const content = "| Owner | Address |\n| --- | --- |\n| [PERSON_2] | [ADDRESS_1] |\n\nSee [PERSON_3].\n\n```\ncode [PERSON_2] ]]> end\n```";
    const saved = await call("design_save", { context: "acme", title: "Owners", designType: "detailed", content });
    const id = /as (doc-\w+)/.exec(saved.text)![1]!;
    await call("confluence_publish", { context: "acme", artifactId: id, spaceKey: "ENG" });
    const storage = confluence.writes[0]!.storage;
    expect(storage).toContain("<td>*Jean* | Roux &amp; &lt;Co&gt;</td>");
    expect(storage).toContain("12 rue X\n75001 Paris");
    expect(storage.match(/<td>/g)).toHaveLength(2);
    expect(storage).not.toContain("<a ");
    expect(storage).toContain("*Jean* | Roux & <Co>"); // verbatim in the code block's CDATA
  });

  it("masks a name the user wrote in their comment, however short", async () => {
    const { call, masker } = await connect([{ status: "rejected", comment: "Ask Li about it." }]);
    masker.remember("acme", [{ type: "PERSON", value: "Li" }]);
    const saved = await call("design_save", { context: "acme", title: "Short", designType: "detailed", content: "Owner: [PERSON_2]." });
    const id = /as (doc-\w+)/.exec(saved.text)![1]!;
    const r = await call("confluence_publish", { context: "acme", artifactId: id, spaceKey: "ENG" });
    expect(r.text).toContain("Their comment: Ask [PERSON_2] about it.");
  });

  it("takes over a 0.x design without its clear metadata, and keeps its page", async () => {
    const { call, contexts, confluence } = await connect();
    confluence.pages.set("55", { title: "Portal design", storage: "", version: 1, spaceId: "1" });
    contexts.addDocuments("acme", [
      {
        kind: "design",
        title: "Portal design",
        source: "artifact:design:high-level:portal-design",
        content: "Owner: Karim Benali",
        metadata: { artifact: true, version: 2, status: "published", owner: "Karim Benali", confluence: { pageId: "55", url: "https://x/wiki/spaces/ENG/pages/55/Portal+design+for+Karim+Benali", pageVersion: 1, artifactVersion: 2, publishedAt: "2026-10-01" } },
      },
    ]);
    const saved = await call("design_save", { context: "acme", title: "Portal design", designType: "high-level", content: "Owner: [PERSON_1]" });
    expect(saved.text).toContain("version 3");
    expect(saved.text).toContain("https://x/wiki/spaces/ENG/pages/55 (status: changed)");
    const doc = contexts.documents("acme").find((d) => d.kind === "design")!;
    expect(doc.masked).toBe(true);
    expect(JSON.stringify(doc.metadata)).not.toContain("Karim");
    const r = await call("confluence_publish", { context: "acme", artifactId: doc.id });
    expect(r.text).toContain("Updated the Confluence page");
    expect(confluence.writes.at(-1)).toMatchObject({ pageId: "55" });
  });

  it("tells the model only the status of a Confluence error", async () => {
    const { call } = await connect();
    const saved = await call("design_save", { context: "acme", title: "VIP flag", designType: "high-level", content: design });
    const id = /as (doc-\w+)/.exec(saved.text)![1]!;
    const r = await call("confluence_publish", { context: "acme", artifactId: id, pageId: "999" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 404");
    expect(r.text).not.toContain("Call with");
  });
});


describe("traceability matrix", () => {
  it("is shown in the chat, and written under the design's page at each publish, from the ids the design and backlog carry", async () => {
    const { call, contexts, seen, confluence, requirements } = await connect();
    const notes = contexts.documents("acme")[0]!;
    requirements.save("acme", [
      { kind: "functional", statement: "Flag VIP clients for [PERSON_1].", priority: "must", status: "confirmed", sourceIds: [notes.id] },
      { kind: "compliance", statement: "Keep the flag history for 5 years.", priority: "must", status: "confirmed", sourceIds: [notes.id] },
      { kind: "functional", statement: "Show the flag on mobile.", priority: "could", status: "confirmed", sourceIds: [] },
      { kind: "functional", statement: "Export the flags.", priority: "wont", status: "confirmed", sourceIds: [] },
    ]);
    // Nothing saved yet: every requirement is not covered.
    expect((await call("trace_show", { context: "acme" })).text).toContain("4 confirmed requirement(s): 0 covered, 0 partly covered, 3 not covered, 1 won't have.");

    const hld = {
      title: "VIP flag",
      solution: { overview: "", orgStrategy: "", components: [{ id: "C1", name: "VIP flag field", type: "Field", status: "new", purpose: "", requirementIds: ["R1", "R2"] }] },
      gaps: [{ requirementId: "R3", reason: "Mobile comes in release 2." }],
    };
    const design = saveArtifact(contexts, "acme", { kind: "design", title: "VIP flag for [PERSON_1]", content: "# VIP flag\n\nOwner: [PERSON_1].", artifactType: "high-level", extra: { design: hld } });
    const story = (id: string, requirementIds: string[]) => ({
      id,
      type: "story" as const,
      summary: `Flag story ${id}`,
      persona: "Account manager",
      want: "to flag VIP clients",
      benefit: "they get priority service",
      acceptanceCriteria: [{ given: "a client", when: "flagged", then: "the flag shows" }],
      requirementIds,
    });
    saveBacklog(contexts, "acme", { title: "VIP backlog", epics: [{ id: "E1", summary: "VIP flag", outcome: "VIP clients get priority", stories: [story("S1", ["R1"]), story("S2", ["R3"])] }] });

    const shown = await call("trace_show", { context: "acme" });
    expect(shown.text).toContain('Computed from the high-level design "VIP flag for [PERSON_1]"');
    expect(shown.text).toContain("4 confirmed requirement(s): 1 covered, 2 partly covered, 0 not covered, 1 won't have. Must requirements not fully covered: R2.");
    expect(shown.text).toMatch(/\| R1 \| must \| Flag VIP clients for \[PERSON_1\]\. \| Call \(doc-[0-9a-f]{10}\) \| HLD Solution: C1 VIP flag field \| S1 Flag story S1 \| covered \|/);
    expect(shown.text).toContain("| partly covered (HLD: Mobile comes in release 2.) |");
    expect(shown.text).not.toContain("Karim");
    expect((await call("trace_show", { context: "acme", backlogId: design.id })).text).toContain("is not a backlog");

    const first = await call("confluence_publish", { context: "acme", artifactId: design.id, spaceKey: "ENG" });
    expect(first.text).toMatch(/Its traceability matrix \(4 requirement\(s\)\) is at https:\/\/acme\.atlassian\.net\/wiki\/spaces\/ENG\/pages\/101/);
    const req = seen.at(-1)!;
    expect(req.kind === "publish" && req.target).toContain("and a new page under it for its traceability matrix");
    expect(req.kind === "publish" && req.body).toContain("Flag VIP clients for Karim Benali.");
    expect(confluence.writes.map((w) => w.title)).toEqual(["VIP flag for Karim Benali", "VIP flag for Karim Benali: traceability matrix"]);
    expect(confluence.writes[1]!.storage).toContain("Flag VIP clients for Karim Benali.");
    expect(first.text).not.toContain("Karim");

    // Published again: the same page is rebuilt, not a new one.
    const again = await call("confluence_publish", { context: "acme", artifactId: design.id });
    expect(again.text).toContain("pages/101");
    expect(seen.at(-1)!.kind === "publish" && (seen.at(-1) as { target: string }).target).toContain('replace the content of its traceability matrix page "VIP flag for Karim Benali: traceability matrix"');
    expect(confluence.pages.size).toBe(2);
    // Left out on request: the user is told the page is now stale.
    const without = await call("confluence_publish", { context: "acme", artifactId: design.id, traceability: false });
    expect(confluence.writes).toHaveLength(5);
    expect(without.text).toMatch(/Its traceability matrix page \(https:\/\/acme\.atlassian\.net\/wiki\/spaces\/ENG\/pages\/101\S*\) was not updated\./);
    // Deleted in Confluence: created again under the design's page.
    confluence.pages.delete("101");
    const recreated = await call("confluence_publish", { context: "acme", artifactId: design.id });
    expect(recreated.text).toContain("pages/102");
    expect(seen.at(-1)!.kind === "publish" && (seen.at(-1) as { target: string }).target).toContain("a new page under it for its traceability matrix");
    // A design saved by hand carries no ids: no matrix.
    const byHand = await call("design_save", { context: "acme", title: "Hand design", designType: "high-level", content: "# Hand" });
    await call("confluence_publish", { context: "acme", artifactId: /as (doc-\w+)/.exec(byHand.text)![1]!, spaceKey: "ENG" });
    expect(confluence.writes.at(-1)!.title).toBe("Hand design");
    expect(confluence.pages.size).toBe(3);
  });
});
