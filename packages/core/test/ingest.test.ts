import { describe, expect, it } from "vitest";
import { ContextRepository, Database, declaredType, Masker, newVaultKey, Vault, type EntityDetector, type Span } from "../src/index.js";

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
  it("never masks a field type, nor one an older context stored as a name", async () => {
    const { vault } = setup();
    // An older context, from before field types were allowlisted, holds "Currency" as a person.
    await new Masker({ vault, model: fakeModel(["Currency"]), allowlist: [] }).mask("acme", "Premium is a Currency field.");
    const masker = new Masker({ vault, model: fakeModel(["Currency", "Karim Benali"]) });
    expect((await masker.maskOutput("acme", 'Use one of Checkbox, Currency, Date.')).text).toBe("Use one of Checkbox, Currency, Date.");
    expect((await masker.mask("globex", "Karim Benali wants a Currency field.")).text).toBe("[PERSON_1] wants a Currency field.");
  });

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

  it("masks a document's title, content, metadata and source", async () => {
    const { masker } = setup(fakeModel(["Sarah Whitfield"]));
    const doc = await masker.maskDocument("acme", {
      kind: "meeting-notes",
      title: "Call with Sarah Whitfield",
      source: "notes/2026-11-07.md",
      content: "Sarah Whitfield wants the VIP flag. Mail: sarah@example.com",
      metadata: {
        attendees: ["Sarah Whitfield", { email: "sarah@example.com" }],
        status: { assignee: "Sarah Whitfield" },
        "sarah@example.com": "owner",
        card: 4111111111111111,
        count: 3,
      },
    });
    expect(doc.title).toBe("Call with [PERSON_1]");
    expect(doc.content).toBe("[PERSON_1] wants the VIP flag. Mail: [EMAIL_1]");
    expect(doc.source).toBe("[SOURCE_1]");
    expect(masker.realSource("acme", doc.source)).toBe("notes/2026-11-07.md");
    expect(doc.metadata).toEqual({
      attendees: ["[PERSON_1]", { email: "[EMAIL_1]" }],
      status: { assignee: "[PERSON_1]" },
      "[EMAIL_1]": "owner",
      card: "[CARD_1]",
      count: 3,
      masking: { counts: { PERSON: 4, EMAIL: 3, CARD: 1 }, model: true },
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
    expect(contexts.documents("acme").map((d) => [d.source, d.content, d.masked])).toEqual([
      ["[SOURCE_1]", "Reporter: [PERSON_1]", true],
      ["[SOURCE_2]", "Nothing personal", true],
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
    expect(contexts.documents("acme")[0]).toMatchObject({ source: "ACME-1", content: "Reporter: Tom Baker, edited", masked: false });
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

describe("known values", () => {
  it("replaces a re-added source's document, under the same pseudonym", async () => {
    const { contexts, masker } = setup();
    const doc = { kind: "email" as const, title: "Re: VIP", source: "/mail/Sarah Whitfield.eml", content: "v1" };
    await masker.addDocuments(contexts, "acme", [doc]);
    await masker.addDocuments(contexts, "acme", [{ ...doc, content: "v2" }]);
    expect(contexts.documents("acme").map((d) => [d.source, d.content])).toEqual([["[SOURCE_1]", "v2"]]);
  });

  it("does not look for secrets, sources or short values in later documents", async () => {
    const { masker } = setup();
    masker.remember("acme", [
      { value: "1234", type: "SECRET" },
      { value: "Hunter2!x", type: "SECRET" },
      { value: "Al", type: "PERSON" },
      { value: "4242", type: "PHONE" },
    ]);
    masker.maskSource("acme", "Release");
    const text = "Fix ACME-1234 and order 4242 for Al before the Release; Hunter2!x is in the doc.";
    expect((await masker.mask("acme", text)).text).toBe(text);
  });

  it("looks for two-character CJK names, which are full names", async () => {
    const { masker } = setup();
    masker.remember("acme", [
      { value: "刘洋", type: "PERSON" },
      { value: "Al", type: "PERSON" },
      { value: "上海", type: "ADDRESS" },
      { value: "Al刘", type: "PERSON" },
    ]);
    // Short values other than CJK names are not looked for: CJK values match inside words.
    expect((await masker.mask("acme", "客户：刘洋，Al，上海")).text).toBe("客户：[PERSON_1]，Al，上海");
  });

  it("matches a one-word name learned from the model in its own case only", async () => {
    const { vault } = setup();
    await new Masker({ vault, model: fakeModel(["Grace"]) }).mask("acme", "Grace approved it.");
    const without = new Masker({ vault });
    expect((await without.mask("acme", "Grace said the grace period is 30 days.")).text).toBe("[PERSON_1] said the grace period is 30 days.");
  });

  it("notices a context that was deleted and filled again", async () => {
    const { db, masker } = setup();
    masker.remember("acme", [{ value: "Karim Benali", type: "PERSON" }]);
    expect((await masker.mask("acme", "Karim Benali")).text).toBe("[PERSON_1]");
    db.db.exec("DELETE FROM context WHERE name = 'acme'");
    masker.remember("acme", [{ value: "Tom Baker", type: "PERSON" }]);
    expect((await masker.mask("acme", "Karim Benali and Tom Baker")).text).toBe("Karim Benali and [PERSON_1]");
  });

  it("stays fast with many known values", async () => {
    const { masker } = setup();
    masker.remember("acme", Array.from({ length: 2000 }, (_, i) => ({ value: `Person${i} Surname${i}`, type: "PERSON" })));
    const started = performance.now();
    const doc = await masker.maskDocument("acme", {
      kind: "other",
      title: "Big",
      source: "big",
      content: "Person1999 Surname1999 met Person7 Surname7. ".repeat(4000),
      metadata: { emails: Array.from({ length: 300 }, (_, i) => `user${i}@example.com`) },
    });
    expect(doc.content.startsWith("[PERSON_2000] met [PERSON_8].")).toBe(true);
    expect(performance.now() - started).toBeLessThan(8000);
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
    // A literal written in a source comes back as text, not as a pseudonym left masked.
    expect(masker.unmask("acme", "[LITERAL_1]")).toMatchObject({ text: "[PERSON_1]", kept: [] });
  });
});

describe("values the user declares", () => {
  it("names the type from the rules, or a name, or a private value", () => {
    expect(declaredType("karim@example.com")).toBe("EMAIL");
    expect(declaredType("+33 6 12 34 56 78")).toBe("PHONE");
    expect(declaredType("Karim Benali")).toBe("PERSON");
    expect(declaredType("O'Neil")).toBe("PERSON");
    expect(declaredType("刘洋")).toBe("PERSON");
    expect(declaredType("project bluebird")).toBe("PRIVATE");
    expect(declaredType("Room 4B")).toBe("PRIVATE");
  });

  it("masks a declared value in every later input, however short, in any case", async () => {
    const { masker, vault } = setup();
    const { entries, ignored } = masker.declare("acme", ["Al", " bluebird ", "x", "[PERSON_1]", ""]);
    expect(entries).toEqual([
      { type: "PERSON", value: "Al", caseSensitive: false },
      { type: "PRIVATE", value: "bluebird", caseSensitive: false },
    ]);
    expect(ignored).toBe(1); // "x"; the pseudonym is already hidden
    expect(vault.declared("acme")).toEqual([
      { type: "PERSON", value: "Al" },
      { type: "PRIVATE", value: "bluebird" },
    ]);
    // A learned value as short as "Al" is never looked for; a declared one is.
    expect((await masker.mask("acme", "AL and Al run Bluebird; also Alice.")).text).toBe("[PERSON_1] and [PERSON_1] run [PRIVATE_1]; also Alice.");
  });

  it("picks up a known value declared later, even from another masker, under its pseudonym", async () => {
    const { masker, vault } = setup(fakeModel(["al"]));
    await masker.mask("acme", "ask al"); // learned from the model, too short to look for again
    const other = new Masker({ vault });
    expect((await other.mask("acme", "ask al")).text).toBe("ask al");
    const before = vault.version("acme");
    masker.declare("acme", ["al"]);
    // The same pseudonym, now declared: no second one under another type.
    expect(vault.version("acme")).toMatchObject({ count: before.count, declared: 1 });
    expect((await other.mask("acme", "ask al")).text).toBe("ask [PERSON_1]");
  });

  it("masks the spelling the user wrote, when the vault knows the value in another", async () => {
    const { masker, vault } = setup(fakeModel(["O'Neil"]));
    await masker.mask("acme", "ask O'Neil, call 0612345678");
    masker.declare("acme", ["O\u2019Neil", "06/12/34/56/78"]);
    const later = new Masker({ vault });
    expect((await later.mask("acme", "ask O\u2019Neil, call 06/12/34/56/78")).text).toBe("ask [PERSON_1], call [PHONE_1]");
  });

  it("keeps declared secrets hidden, exactly as written", async () => {
    const { masker, vault } = setup();
    const secret = ["Tr0ub4", "dor&3x"].join("");
    expect((await masker.mask("acme", `password: ${secret}`)).text).toBe("password: [SECRET_1]");
    expect(masker.declare("acme", [secret]).entries).toEqual([{ type: "SECRET", value: secret, caseSensitive: true }]);
    expect((await new Masker({ vault }).mask("acme", `the pw is ${secret} ok`)).text).toBe("the pw is [SECRET_1] ok");
  });

  it("takes the text around a copied pseudonym, without the punctuation", async () => {
    const { masker } = setup();
    const { entries, ignored } = masker.declare("acme", ["[PERSON_1] Benali,", "(Karim)", "[EMAIL_2] x"]);
    expect(entries.map((e) => e.value)).toEqual(["Benali", "Karim"]);
    expect(ignored).toBe(1);
    expect((await masker.mask("acme", "Karim said Benali.")).text).toBe("[PERSON_2] said [PERSON_1].");
  });

  it("never takes a type that stays visible from an earlier value", async () => {
    const { masker, vault } = setup();
    vault.pseudonym("acme", "ORG", "Bluebird");
    expect(masker.declare("acme", ["Bluebird"]).entries).toEqual([{ type: "PERSON", value: "Bluebird", caseSensitive: false }]);
    expect((await masker.mask("acme", "project Bluebird")).text).toBe("project [PERSON_1]");
  });
});

describe("masking what the agents wrote", () => {
  it("keeps the pseudonyms they used and masks what they wrote in clear", async () => {
    const { masker } = setup(fakeModel(["Karim Benali", "Lea Martin"]));
    const input = await masker.mask("acme", "Karim Benali asked for it.");
    expect(input.text).toBe("[PERSON_1] asked for it.");
    const out = await masker.maskOutput("acme", "Owner: [PERSON_1]. Reviewer: Lea Martin (lea@example.com). Unknown: [PERSON_9].");
    expect(out.text).toBe("Owner: [PERSON_1]. Reviewer: [PERSON_2] ([EMAIL_1]). Unknown: [PERSON_9].");
    expect(out.report.counts).toEqual({ PERSON: 1, EMAIL: 1 });
    expect(masker.unmask("acme", out.text)).toMatchObject({ text: "Owner: Karim Benali. Reviewer: Lea Martin (lea@example.com). Unknown: [PERSON_9].", kept: ["[PERSON_9]"] });
  });
});

describe("masking several texts the agents wrote at once", () => {
  it("runs the detection once, and masks each text as maskOutput would", async () => {
    let runs = 0;
    const model = fakeModel(["Karim Benali", "Lea Martin"]);
    const { masker } = setup(async (text) => (runs++, model(text)));
    await masker.mask("acme", "Karim Benali asked for it.");
    runs = 0;
    const out = await masker.maskOutputs("acme", ["Owner: [PERSON_1].", "", "Reviewer: Lea Martin.", "Lea Martin"]);
    expect(out.texts).toEqual(["Owner: [PERSON_1].", "", "Reviewer: [PERSON_2].", "[PERSON_2]"]);
    expect(out.report.counts).toEqual({ PERSON: 2 });
    expect(runs).toBe(1);
  });

  it("looks again, on their own, at the texts something found runs across", async () => {
    let runs = 0;
    const { masker, vault } = setup(async (text) => {
      runs++;
      const spans = await fakeModel(["Lea Martin"])(text);
      // Wrongly, from the end of one text into the next.
      const mark = text.indexOf("\u2063");
      if (mark > 0) spans.push({ start: mark - 6, end: mark + 7, type: "PER", source: "ner" });
      return spans;
    });
    const out = await masker.maskOutputs("acme", ["Ask Lea Martin", "about the flag", "today"]);
    expect(out.texts).toEqual(["Ask [PERSON_1]", "about the flag", "today"]);
    expect(runs).toBe(3);
    expect(vault.version("acme").count).toBe(1);
  });

  it("keeps apart texts that hold the separator's mark", async () => {
    const { masker } = setup(fakeModel(["Lea Martin"]));
    const out = await masker.maskOutputs("acme", ["a\u2063b", "Lea Martin"]);
    expect(out.texts).toEqual(["a\u2063b", "[PERSON_1]"]);
  });
});

describe("masking what the agents wrote, around their pseudonyms", () => {
  it("masks what a span holds besides a pseudonym", async () => {
    const { masker } = setup(async (text) => {
      const i = text.indexOf("[PERSON_1] Benali");
      return i < 0 ? [] : [{ start: i, end: i + "[PERSON_1] Benali".length, type: "PER", source: "ner" as const }];
    });
    await masker.mask("acme", "Karim asked."); // nothing: the fake model only knows the label case
    const secret = ["hunter", "22xyz"].join("");
    const out = await masker.maskOutput("acme", `Ask [PERSON_1] Benali. password=[SECRET_1]${secret}`);
    expect(out.text).not.toContain("Benali");
    expect(out.text).not.toContain(secret);
    expect(out.text).toContain("Ask [PERSON_1] [PERSON_");
  });

  it("keeps pseudonyms in every form the model writes them", async () => {
    const { masker } = setup();
    const text = "A \\[PERSON\\_1\\], <PERSON_2>, &lt;PERSON_3&gt; and [EMAIL_1].";
    expect((await masker.maskOutput("acme", text)).text).toBe(text);
  });

  it("escapes the values it puts back when asked, and lists them", async () => {
    const { masker } = setup(fakeModel(["Jean Roux"]));
    await masker.mask("acme", "Jean Roux");
    const out = masker.unmask("acme", "<p>[PERSON_1]</p>", { escape: (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;") });
    expect(out).toEqual({ text: "<p>Jean Roux</p>", kept: [], revealed: [{ type: "PERSON", value: "Jean Roux" }] });
  });
});
