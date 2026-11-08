import { ContextRepository, Database, RequirementRepository } from "@sf-agent-po/core";
import { describe, expect, it } from "vitest";
import { saveArtifact, saveBacklog, updateArtifactMeta } from "../src/index.js";
import { buildTrace, renderTrace } from "../src/trace.js";

describe("traceability matrix", () => {
  it("traces through the detailed design's stories, shows Jira keys once published, and escapes table cells", () => {
    const db = new Database(":memory:");
    const contexts = new ContextRepository(db);
    const requirements = new RequirementRepository(db);
    requirements.save("c", [
      { kind: "functional", statement: "Send the letter | by post.", priority: "must", status: "confirmed", sourceIds: [] },
      { kind: "functional", statement: "Dropped one.", priority: "must", status: "dropped", sourceIds: [] },
    ]);
    const dd = {
      title: "Letters",
      scope: { summary: "", stories: [{ ref: "S1", summary: "Send the letter", requirementIds: ["R1"], acceptanceCriteria: [] }, { ref: "PORT-9", summary: "Print it", requirementIds: ["R1"], acceptanceCriteria: [] }] },
      dataModel: { objects: [{ name: "Letter__c", status: "new", stories: ["S1"], fields: [], recordTypes: [], validationRules: [] }] },
    };
    saveArtifact(contexts, "c", { kind: "design", title: "Letters DD", content: "# DD", artifactType: "detailed", extra: { design: dd } });
    const story = { id: "S1", type: "story" as const, summary: "Send the letter", persona: "Agent", want: "to send", benefit: "clients renew", acceptanceCriteria: [{ given: "a", when: "b", then: "c" }], requirementIds: ["R1"] };
    const backlog = saveBacklog(contexts, "c", { title: "Letters backlog", epics: [{ id: "E1", summary: "Letters", outcome: "Clients renew on time", stories: [story] }] });
    updateArtifactMeta(contexts, "c", backlog, () => ({ jira: { projectKey: "PORT", items: { S1: { key: "PORT-12", url: "" } }, links: [] } }));
    // A design saved by hand carries no ids: it is skipped by default.
    saveArtifact(contexts, "c", { kind: "design", title: "Newer by hand", content: "# HLD", artifactType: "high-level" });

    const m = buildTrace(contexts, requirements, "c");
    expect(m.rows).toHaveLength(1);
    expect(m.from.highLevel).toBeUndefined();
    expect(m.rows[0]).toMatchObject({
      design: ["DD Data model: Letter__c (S1)"],
      stories: [
        { id: "S1", jiraKey: "PORT-12" },
        { id: "PORT-9", summary: "Print it" },
      ],
      status: "covered",
    });
    const md = renderTrace(m, "Matrix");
    expect(md).toContain("Send the letter \\| by post.");
    expect(md).toContain("S1 (PORT-12) Send the letter; PORT-9 Print it");
  });

  it("leaves the backlog's won't-have stories out, matches Jira keys, follows the detailed design's links, and never shows an unmasked title", () => {
    const db = new Database(":memory:");
    const contexts = new ContextRepository(db);
    const requirements = new RequirementRepository(db);
    contexts.addDocuments("c", [{ kind: "meeting-notes", title: "Call with Karim Benali", source: "old.md", content: "", masked: false }]);
    const old = contexts.documents("c")[0]!;
    requirements.save("c", [
      { kind: "functional", statement: "Send the letter.", priority: "must", status: "confirmed", sourceIds: [old.id] },
      { kind: "functional", statement: "Print the letter.", priority: "should", status: "confirmed", sourceIds: [] },
    ]);
    const story = (id: string, requirementIds: string[], priority?: "wont") => ({ id, type: "story" as const, summary: `Story ${id}`, persona: "Agent", want: "to send", benefit: "clients renew", acceptanceCriteria: [{ given: "a", when: "b", then: "c" }], requirementIds, ...(priority ? { priority } : {}) });
    const linkedBacklog = saveBacklog(contexts, "c", { title: "Linked backlog", epics: [{ id: "E1", summary: "Letters", outcome: "Clients renew on time", stories: [story("S1", ["R1"]), story("S2", ["R2"], "wont")] }] });
    updateArtifactMeta(contexts, "c", linkedBacklog, () => ({ jira: { projectKey: "PORT", items: { S1: { key: "PORT-12", url: "" } }, links: [] } }));
    const dd = {
      title: "Letters",
      scope: { summary: "", backlogId: linkedBacklog.id, stories: [{ ref: "PORT-12", summary: "Send", requirementIds: ["R1"], acceptanceCriteria: [] }, { ref: "S2", summary: "Print", requirementIds: ["R2"], acceptanceCriteria: [] }] },
    };
    const design = saveArtifact(contexts, "c", { kind: "design", title: "Letters DD", content: "# DD", artifactType: "detailed", extra: { design: dd } });
    // Newer, but not the one the design builds on.
    saveBacklog(contexts, "c", { title: "Newer backlog", epics: [{ id: "E1", summary: "Other", outcome: "Something else entirely", stories: [story("S9", ["R2"])] }] });

    const m = buildTrace(contexts, requirements, "c", { detailed: design.id });
    expect(m.from.backlog?.id).toBe(linkedBacklog.id);
    expect(m.rows[0]!.stories).toEqual([{ id: "S1", summary: "Story S1", jiraKey: "PORT-12" }]);
    expect(m.rows[0]!.sources).toEqual([{ id: old.id }]);
    expect(m.rows[1]).toMatchObject({ stories: [], status: "not covered" });
    expect(renderTrace(m, "Matrix")).not.toContain("Karim");
  });
});

