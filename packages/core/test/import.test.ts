import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// Files exactly as 0.x wrote them.
import { LegacyStore } from "./fixtures/legacy-store.js";
import { ContextRepository, Database, documentId, importLegacyWorkspace, parseLegacyContext } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "sf-agent-import-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const workspace = () => join(dir, `ws-${++n}`);

describe("importLegacyWorkspace", () => {
  it("imports contexts written by 0.x with their ids, dates and metadata", async () => {
    const ws = workspace();
    const legacy = new LegacyStore(ws);
    await legacy.addDocuments("renewal", [
      { kind: "meeting-notes", title: "Kick-off", source: "notes/kickoff.md", content: "Boutique opening in Paris" },
      { kind: "jira", title: "LUX-12", source: "LUX-12", content: "Clienteling story", metadata: { status: "To Do" } },
    ]);
    await legacy.addDocuments("loyalty", [{ kind: "email", title: "Re: tiers", source: "mail/tiers.eml", content: "Gold tier", metadata: { from: "x" } }]);
    const before = await legacy.load("renewal");
    const jsonBefore = readFileSync(join(ws, "contexts", "renewal.json"), "utf8");

    const db = new Database(join(ws, "sf-agent.db"));
    const report = await importLegacyWorkspace(ws, db);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.imported.map((c) => [c.name, c.documents, c.warnings])).toEqual([
      ["loyalty", 1, []],
      ["renewal", 2, []],
    ]);

    const repo = new ContextRepository(db);
    const info = repo.get("renewal")!;
    expect(info).toMatchObject({ createdAt: before.createdAt, updatedAt: before.updatedAt, settings: {}, documentCount: 2 });
    for (const old of before.documents) {
      expect(repo.getDocument("renewal", old.id)).toMatchObject({
        kind: old.kind,
        title: old.title,
        source: old.source,
        content: old.content,
        metadata: old.metadata ?? {},
        masked: false,
        addedAt: old.addedAt,
        updatedAt: old.addedAt,
      });
    }
    // The 0.x files are only read.
    expect(readFileSync(join(ws, "contexts", "renewal.json"), "utf8")).toBe(jsonBefore);
    db.close();
  });

  it("leaves contexts already in the database alone unless asked to replace them", async () => {
    const ws = workspace();
    const legacy = new LegacyStore(ws);
    await legacy.addDocuments("c", [{ kind: "other", title: "v1", source: "a.md", content: "v1" }]);
    const db = new Database(join(ws, "sf-agent.db"));
    await importLegacyWorkspace(ws, db);
    const repo = new ContextRepository(db);
    repo.addDocuments("c", [{ kind: "other", title: "new", source: "b.md", content: "added in v1" }]);

    expect(await importLegacyWorkspace(ws, db)).toEqual({ imported: [], skipped: ["c"], failed: [] });
    expect(repo.documents("c")).toHaveLength(2);

    const replaced = await importLegacyWorkspace(ws, db, { replace: true });
    expect(replaced.imported.map((c) => c.name)).toEqual(["c"]);
    expect(repo.documents("c").map((d) => d.source)).toEqual(["a.md"]);
    db.close();
  });

  it("reports broken files and goes on with the others", async () => {
    const ws = workspace();
    mkdirSync(join(ws, "contexts"), { recursive: true });
    writeFileSync(join(ws, "contexts", "broken.json"), "{ not json");
    writeFileSync(join(ws, "contexts", "not-a-context.json"), '{"hello": 1}');
    writeFileSync(join(ws, "contexts", "bad name!.json"), '{"name": "bad name!", "documents": []}');
    writeFileSync(join(ws, "contexts", "ok.json"), '{"name": "ok", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-02T00:00:00.000Z", "documents": []}');
    writeFileSync(join(ws, "contexts", "notes.txt"), "ignored");
    const db = new Database(join(ws, "sf-agent.db"));
    const report = await importLegacyWorkspace(ws, db);
    expect(report.imported.map((c) => c.name)).toEqual(["ok"]);
    expect(report.failed.map((f) => [f.file.split(/[\\/]/).pop(), f.error])).toEqual([
      ["bad name!.json", expect.stringMatching(/Invalid context name/)],
      ["broken.json", expect.stringMatching(/JSON/)],
      ["not-a-context.json", expect.stringMatching(/no documents list/)],
    ]);
    expect(new ContextRepository(db).list().map((c) => c.name)).toEqual(["ok"]);
    db.close();
  });

  it("keeps the order of documents that 0.x added in one batch", async () => {
    const ws = workspace();
    const sources = ["f", "a", "e", "b", "d", "c"].map((s) => `notes/${s}.md`);
    await new LegacyStore(ws).addDocuments("c", sources.map((source) => ({ kind: "meeting-notes" as const, title: source, source, content: "" })));
    const db = new Database(join(ws, "sf-agent.db"));
    await importLegacyWorkspace(ws, db);
    expect(new ContextRepository(db).documents("c").map((d) => d.source)).toEqual(sources);
    db.close();
  });

  it("reads files saved with a byte order mark", async () => {
    const ws = workspace();
    mkdirSync(join(ws, "contexts"), { recursive: true });
    writeFileSync(join(ws, "contexts", "bom.json"), '\uFEFF{"name": "bom", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z", "documents": []}');
    const db = new Database(":memory:");
    expect((await importLegacyWorkspace(ws, db)).imported.map((c) => c.name)).toEqual(["bom"]);
    db.close();
  });

  it("does nothing for a workspace without 0.x contexts", async () => {
    const db = new Database(":memory:");
    expect(await importLegacyWorkspace(workspace(), db)).toEqual({ imported: [], skipped: [], failed: [] });
    db.close();
  });
});

describe("parseLegacyContext", () => {
  it("recovers what it can and says what it changed", () => {
    const { context, warnings } = parseLegacyContext(
      {
        name: "other-name",
        createdAt: "yesterday",
        documents: [
          { id: "doc-0000000000", kind: "slides", source: "deck.pptx", content: "a" },
          { kind: "email", source: "", content: "no source" },
          { kind: "email", source: "m.eml", content: 42, metadata: ["x"] },
          { kind: "email", title: "Second", source: "m.eml", content: "kept", addedAt: "2026-03-01T10:00:00.000Z" },
        ],
      },
      "renewal",
    );
    const first = "2026-03-01T10:00:00.000Z";
    expect(context).toEqual({
      name: "renewal",
      // Missing or broken context dates come from the documents.
      createdAt: first,
      updatedAt: first,
      documents: [
        { kind: "other", title: "deck.pptx", source: "deck.pptx", content: "a", metadata: {}, masked: false, addedAt: first },
        { kind: "email", title: "Second", source: "m.eml", content: "kept", metadata: {}, masked: false, addedAt: first },
      ],
    });
    expect(warnings).toEqual([
      'The file says the context is "other-name"; imported as "renewal" after its file name.',
      'Document 1 (deck.pptx) has the unknown kind "slides"; imported as "other".',
      `Document 1 (deck.pptx) had the id doc-0000000000; its id is now ${documentId("deck.pptx")}.`,
      "Document 1 (deck.pptx) has no title; the source is used as its title.",
      "Document 1 (deck.pptx) has no date.",
      "Document 2 has no source and was left out.",
      "Document 3 (m.eml) has no title; the source is used as its title.",
      "Document 3 (m.eml) has no text content.",
      "Document 3 (m.eml) has metadata that is not an object; it was left out.",
      "Document 3 (m.eml) has no date.",
      'The context (createdAt) has the invalid date "yesterday".',
      "The context (updatedAt) has no date.",
      "1 duplicate document(s) from the same source; kept the last one.",
    ]);
  });

  it("stores every date as ISO 8601 in UTC and keeps empty titles", () => {
    const { context, warnings } = parseLegacyContext(
      { name: "c", createdAt: "March 5, 2026 UTC", updatedAt: "2026-03-06T00:00:00.000Z", documents: [{ kind: "email", title: "", source: "m.eml", content: "", addedAt: "2026-03-05T09:00:00Z" }] },
      "c",
    );
    expect(context.createdAt).toBe("2026-03-05T00:00:00.000Z");
    expect(context.documents[0]).toMatchObject({ title: "", addedAt: "2026-03-05T09:00:00.000Z" });
    expect(warnings).toEqual([
      'Document 1 (m.eml) has the date "2026-03-05T09:00:00Z", stored as 2026-03-05T09:00:00.000Z.',
      'The context (createdAt) has the date "March 5, 2026 UTC", stored as 2026-03-05T00:00:00.000Z.',
    ]);
  });
});
