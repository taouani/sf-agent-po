import { describe, expect, it } from "vitest";
import { ContextRepository, Database, Masker, newVaultKey, Vault, type EntityDetector, type Span } from "../src/index.js";

/** A stand-in for the detection model that knows a few names. */
const fakeModel =
  (names: readonly string[]): EntityDetector =>
  async (text) => {
    const spans: Span[] = [];
    for (const name of names) for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) spans.push({ start: i, end: i + name.length, type: "PER", source: "ner" });
    return spans;
  };

const setup = (model?: EntityDetector) => {
  const db = new Database(":memory:");
  const vault = new Vault(db, newVaultKey());
  return { db, vault, contexts: new ContextRepository(db), masker: new Masker({ vault, model }) };
};

describe("masking inputs", () => {
  it("masks a text and reports what it masked and whether the model ran", async () => {
    const { masker } = setup(fakeModel(["Karim Benali"]));
    const { text, report } = await masker.mask("acme", "Karim Benali (karim@example.com, +33 6 12 34 56 78) owns the Flow.");
    expect(text).toBe("[PERSON_1] ([EMAIL_1], [PHONE_1]) owns the Flow.");
    expect(report).toEqual({ counts: { PERSON: 1, EMAIL: 1, PHONE: 1 }, model: true });
    expect((await setup().masker.mask("acme", "Hi")).report.model).toBe(false);
  });

  it("keeps masking a name the context knows, even without the model", async () => {
    const { vault } = setup();
    const withModel = new Masker({ vault, model: fakeModel(["Karim Benali"]) });
    await withModel.mask("acme", "Owner: Karim Benali");
    const without = new Masker({ vault });
    // Another spelling is masked too, with its own pseudonym, so it comes back as written.
    expect((await without.mask("acme", "Ask karim benali or KarimBenali.")).text).toBe("Ask [PERSON_1] or [PERSON_2].");
    // Another context does not know him.
    expect((await without.mask("globex", "Ask Karim Benali.")).text).toBe("Ask Karim Benali.");
  });

  it("learns values it is told, such as the org's users", async () => {
    const { masker } = setup();
    masker.remember("acme", [{ value: "Léa Martin", type: "PERSON" }, { value: " ", type: "PERSON" }]);
    expect((await masker.mask("acme", "Assigned to Léa Martin.")).text).toBe("Assigned to [PERSON_1].");
  });

  it("never masks domain terms, even if they were learned", async () => {
    const { masker } = setup(fakeModel(["Flow"]));
    masker.remember("acme", [{ value: "Flow", type: "PERSON" }]);
    expect((await masker.mask("acme", "Build a Flow.")).text).toBe("Build a Flow.");
  });

  it("masks a document's title, content and metadata, but not its source", async () => {
    const { masker } = setup(fakeModel(["Sarah Whitfield"]));
    const doc = await masker.maskDocument("acme", {
      kind: "meeting-notes",
      title: "Call with Sarah Whitfield",
      source: "notes/2026-11-07.md",
      content: "Sarah Whitfield wants the VIP flag. Mail: sarah@example.com",
      metadata: { attendees: ["Sarah Whitfield", { email: "sarah@example.com" }], status: "Sarah Whitfield", count: 3 },
    });
    expect(doc.title).toBe("Call with [PERSON_1]");
    expect(doc.content).toBe("[PERSON_1] wants the VIP flag. Mail: [EMAIL_1]");
    expect(doc.source).toBe("notes/2026-11-07.md");
    expect(doc.metadata).toEqual({
      attendees: ["[PERSON_1]", { email: "[EMAIL_1]" }],
      status: "Sarah Whitfield", // a field name kept as written
      count: 3,
      masking: { counts: { PERSON: 3, EMAIL: 2 }, model: true },
    });
    expect(doc.masked).toBe(true);
    await expect(masker.maskDocument("acme", { ...doc })).rejects.toThrow(/already masked/);
  });

  it("stores added documents masked, with no original in clear", async () => {
    const { db, contexts, masker } = setup(fakeModel(["Sarah Whitfield"]));
    const [doc] = await masker.addDocuments(contexts, "acme", [{ kind: "email", title: "Re: VIP", source: "mail-1", content: "From Sarah Whitfield <sarah@example.com>" }]);
    expect(doc!.masked).toBe(true);
    expect(contexts.getDocument("acme", doc!.id)!.content).toBe("From [PERSON_1] <[EMAIL_1]>");
    const dump = JSON.stringify(db.db.prepare("SELECT * FROM document").all()) + JSON.stringify(db.db.prepare("SELECT * FROM context").all());
    expect(dump).not.toMatch(/sarah|whitfield/i);
  });

  it("masks the documents of a context imported unmasked, once", async () => {
    const { contexts, masker } = setup(fakeModel(["Tom Baker"]));
    contexts.addDocuments("acme", [
      { kind: "jira", title: "ACME-1", source: "ACME-1", content: "Reporter: Tom Baker" },
      { kind: "jira", title: "ACME-2", source: "ACME-2", content: "Nothing personal" },
    ]);
    const first = await masker.maskContext(contexts, "acme");
    expect(first).toMatchObject({ masked: 2, changed: 0, report: { counts: { PERSON: 1 } } });
    expect(contexts.documents("acme").map((d) => [d.content, d.masked])).toEqual([
      ["Reporter: [PERSON_1]", true],
      ["Nothing personal", true],
    ]);
    expect((await masker.maskContext(contexts, "acme")).masked).toBe(0);
  });

  it("leaves a document that changed while it was masked for the next run", async () => {
    const { contexts, vault } = setup();
    contexts.addDocuments("acme", [{ kind: "jira", title: "ACME-1", source: "ACME-1", content: "Reporter: Tom Baker" }]);
    let edited = false;
    const editing: EntityDetector = async () => {
      if (!edited) {
        edited = true;
        contexts.addDocuments("acme", [{ kind: "jira", title: "ACME-1", source: "ACME-1", content: "Reporter: Tom Baker, edited" }]);
      }
      return [];
    };
    const masker = new Masker({ vault, model: editing });
    expect(await masker.maskContext(contexts, "acme")).toMatchObject({ masked: 0, changed: 1 });
    expect(contexts.documents("acme")[0]).toMatchObject({ content: "Reporter: Tom Baker, edited", masked: false });
    expect(await masker.maskContext(contexts, "acme")).toMatchObject({ masked: 1, changed: 0 });
  });

  it("does not re-add a document removed while it was masked", async () => {
    const { contexts, vault } = setup();
    const [doc] = contexts.addDocuments("acme", [{ kind: "jira", title: "ACME-1", source: "ACME-1", content: "x" }]);
    const removing: EntityDetector = async () => (contexts.removeDocument("acme", doc!.id), []);
    expect(await new Masker({ vault, model: removing }).maskContext(contexts, "acme")).toMatchObject({ masked: 0, changed: 1 });
    expect(contexts.documents("acme")).toEqual([]);
  });
});

describe("unmasking on publish", () => {
  it("puts real values back, keeps secrets and lists what stays masked", async () => {
    const { masker } = setup(fakeModel(["Sarah Whitfield"]));
    const { text } = await masker.mask("acme", "Sarah Whitfield, password: Hunter2!x, wrote [PERSON_1]");
    expect(text).toBe("[PERSON_1], password: [SECRET_1], wrote [LITERAL_1]");
    const story = `As ${text.split(",")[0]}, I want my VIP flag. Login secret stays [SECRET_1]. See [PERSON_7].`;
    const out = masker.unmask("acme", story);
    expect(out.text).toBe("As Sarah Whitfield, I want my VIP flag. Login secret stays [SECRET_1]. See [PERSON_7].");
    expect(out.kept).toEqual(["[SECRET_1]", "[PERSON_7]"]);
    expect(masker.unmask("acme", "[LITERAL_1]").text).toBe("[PERSON_1]");
  });
});
