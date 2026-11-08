import { describe, expect, it } from "vitest";
import { ContextRepository, Database } from "@sf-agent-po/core";
import { checkRules, contextLanguage, detectLanguage, languageFinding, wordsPattern } from "../src/checks.js";
import { checkBacklog, checkRequirements, coverageFindings, type Backlog } from "../src/index.js";
import type { Requirement } from "@sf-agent-po/core";

const doc = (id: string, title: string, content: string) => ({ id, kind: "other" as const, title, source: "x", content, metadata: {}, masked: true, addedAt: "", updatedAt: "" });

describe("word lists", () => {
  it("match whole words in any case, with accents, phrases and prefixes", () => {
    const p = wordsPattern(["sécuris*", "vie privée", "rapide", "etc"]);
    expect("Les données sont SÉCURISÉES.").toMatch(p);
    expect("respect de la vie   privée").toMatch(p);
    expect("une réponse rapide").toMatch(p);
    expect("rapidement").not.toMatch(p);
    expect("etc.").toMatch(p);
    expect("etcetera").not.toMatch(p);
  });

  it("know generic personas with or without an article, in each language", () => {
    const en = checkRules("en");
    const fr = checkRules("fr");
    for (const p of ["user", "The user", "a customer", "Someone"]) expect(en.genericPersona(p), p).toBe(true);
    expect(en.genericPersona("Renewals agent")).toBe(false);
    for (const p of ["l'utilisateur", "L'utilisatrice", "un client", "Le client", "les utilisateurs"]) expect(fr.genericPersona(p), p).toBe(true);
    expect(fr.genericPersona("Gestionnaire de contrats")).toBe(false);
    // Compliance terms are found in any language: inputs need not be in the output language.
    expect("Conformément au RGPD").toMatch(en.sensitive);
    expect("GDPR applies").toMatch(fr.sensitive);
  });

  it("tell the language of a text that is long enough", () => {
    expect(detectLanguage("Le conseiller doit envoyer la lettre de renouvellement trente jours avant la date de fin du contrat.")).toBe("fr");
    expect(detectLanguage("The adviser must send the renewal letter thirty days before the end date of the contract.")).toBe("en");
    expect(detectLanguage("Send the letter.")).toBeUndefined();
    expect(languageFinding(["Le conseiller doit envoyer la lettre de renouvellement trente jours avant la date de fin du contrat."], "en", "S1")?.message).toBe(
      "This reads as French, but the context's output language is English: write it in English.",
    );
  });
});

describe("English lists against the regexes they replace", () => {
  // The 0.x regexes, as they were in backlog.ts.
  const VAGUE = /\b(fast|user[- ]friendly|easy|easily|intuitive|appropriate(ly)?|etc\.?|and so on|as needed|seamless(ly)?|robust)\b/i;
  const GENERIC_PERSONA = /^(a |an |the )?(user|users|someone|customer|person)$/i;
  const SENSITIVE = /\b(security|secure|encrypt\w*|gdpr|hipaa|pci|sox|mfa|sso|privacy|personal data|pii|compliance|audit\w*|retention|consent)\b/i;
  const en = checkRules("en");

  it("give the same answers on the cases that matter", () => {
    const vague = ["a fast page", "user-friendly", "user friendly", "Easily", "as appropriate", "appropriately", "etc.", "and so on", "as needed", "seamlessly", "robust", "quick action", "steadfast", "breakfast", "robustness"];
    for (const t of vague) expect(en.vague.test(t), t).toBe(VAGUE.test(t));
    const personas = ["user", "The user", "an Users", "customer", "a person", "Renewals agent", "user admin", "the customers"];
    for (const t of personas) expect(en.genericPersona(t), t).toBe(GENERIC_PERSONA.test(t.trim()));
    const sensitive = ["Security review", "encrypted at rest", "Encrypted__c", "Audit_Log__c", "audit trail", "GDPR", "personal data", "retention", "consent", "securely", "insecure", "PIIs", "no rules here"];
    for (const t of sensitive) expect(en.sensitive.test(t), t).toBe(SENSITIVE.test(t));
  });
});

describe("apostrophes, elisions and false friends", () => {
  it("read the typographic apostrophe as the plain one", () => {
    const fr = checkRules("fr");
    expect(fr.genericPersona("l\u2019utilisateur")).toBe(true);
    expect(fr.genericPersona("quelqu\u2019un")).toBe(true);
    expect("droits d\u2019accès").toMatch(fr.sensitive);
    expect(detectLanguage("L\u2019utilisateur d\u2019un compte qu\u2019il gère s\u2019affiche jusqu\u2019à l\u2019échéance de la période en cours")).toBe("fr");
  });

  it("count elided articles as French words", () => {
    expect(detectLanguage("L'utilisateur d'un compte qu'il gère s'affiche n'importe quand jusqu'à l'échéance aujourd'hui")).toBe("fr");
  });

  it("do not flag revenue, estimates, limits or quick actions", () => {
    const fr = checkRules("fr");
    for (const t of ["le chiffre d'affaires du trimestre", "le chiffrage des stories", "un objectif chiffré"]) expect(t, t).not.toMatch(fr.sensitive);
    expect("les données chiffrées au repos").toMatch(fr.sensitive);
    expect("les fichiers de plus de 10 Mo sont refusés").not.toMatch(fr.joining);
    expect("l'action rapide Renouveler").not.toMatch(fr.vague);
    expect("le taux de rétention des clients").not.toMatch(fr.sensitive);
    expect("la rétention des données").toMatch(fr.sensitive);
  });

  it("fall back to English for a language the context does not know", () => {
    const contexts = new ContextRepository(new Database(":memory:"));
    expect(contextLanguage(contexts, "c")).toBe("en");
    contexts.updateSettings("c", { language: "de" });
    expect(contextLanguage(contexts, "c")).toBe("en");
    contexts.updateSettings("c", { language: "fr" });
    expect(contextLanguage(contexts, "c")).toBe("fr");
  });
});

describe("checks in French", () => {
  const backlog = (persona: string, then: string): Backlog => ({
    title: "Renouvellements",
    epics: [
      {
        id: "E1",
        summary: "Lettres de renouvellement",
        outcome: "Les clients renouvellent leur contrat à temps",
        stories: [
          {
            id: "S1",
            type: "story",
            summary: "Envoyer la lettre de renouvellement",
            persona,
            want: "envoyer la lettre de renouvellement avant la date de fin",
            benefit: "le client puisse renouveler son contrat dans les délais",
            acceptanceCriteria: [{ given: "un contrat qui arrive à échéance", when: "il reste trente jours", then }],
            sourceIds: ["doc-000000000a"],
          },
        ],
      },
    ],
  });

  it("use the French lists for a French backlog, and flag one written in English", () => {
    const docs = [doc("doc-000000000a", "Atelier", "Envoyer la lettre."), doc("doc-000000000b", "Politique", "Les données personnelles sont conservées 7 ans.")];
    const fr = checkBacklog(backlog("L'utilisateur", "la lettre est envoyée rapidement"), docs, "fr").map((f) => `${f.level} ${f.where}: ${f.message}`);
    expect(fr).toContain('warning S1: Persona "L\'utilisateur" is generic; name the role, e.g. "Renewals agent".');
    expect(fr).toContain('warning S1 AC1: "rapidement" is not testable; state a measurable outcome.');
    expect(fr).toContain('warning doc-000000000b: "Politique" mentions security or compliance requirements but no epic or story cites it.');
    expect(fr.some((f) => f.includes("reads as"))).toBe(false);
    // The same backlog checked as English: the French words are not English vague words, and the language is wrong.
    const en = checkBacklog(backlog("Gestionnaire", "la lettre est envoyée rapidement"), docs, "en").map((f) => `${f.level} ${f.where}: ${f.message}`);
    expect(en).toContain("warning backlog: This reads as French, but the context's output language is English: write it in English.");
    expect(en.some((f) => f.includes("is not testable"))).toBe(false);
  });

  it("flag joined needs and the wrong language in requirements", () => {
    const docs = [doc("doc-000000000a", "Atelier", "Envoyer la lettre.")];
    const findings = checkRequirements(
      [
        { kind: "functional", statement: "Le conseiller envoie la lettre ainsi que le devis", priority: "must", sourceIds: ["doc-000000000a"] },
        { kind: "non-functional", statement: "La page s'affiche rapidement pour le conseiller", priority: "should", sourceIds: ["doc-000000000a"] },
      ],
      [],
      docs,
      "fr",
    ).map((f) => `${f.level} ${f.where}: ${f.message}`);
    expect(findings).toEqual(['warning new 1: "ainsi que" may join two needs; split the statement if it holds two.', 'warning new 2: "rapidement" cannot be tested; state a measurable target.']);
    // Several sentences: one warning, not two.
    const both = checkRequirements([{ kind: "functional", statement: "Envoyer la lettre. Envoyer aussi le devis ainsi que la facture", priority: "must", sourceIds: ["doc-000000000a"] }], [], docs, "fr");
    expect(both.filter((f) => f.level === "warning").map((f) => f.message)).toEqual(["States more than one sentence; a requirement should state one thing, so split it if it holds several."]);
    const english = checkRequirements(
      [{ kind: "functional", statement: "Le conseiller doit envoyer la lettre de renouvellement trente jours avant la date de fin du contrat", priority: "must", sourceIds: ["doc-000000000a"] }],
      [],
      docs,
      "en",
    );
    expect(english.map((f) => f.message)).toContain("This reads as French, but the context's output language is English: write it in English.");
  });
});

describe("requirement coverage", () => {
  const r = (id: string, priority: Requirement["priority"], sourceIds: string[] = []): Requirement => ({
    context: "c",
    id,
    kind: "functional",
    statement: `Statement ${id}`,
    priority,
    status: "confirmed",
    origin: "agent",
    sourceIds,
    createdAt: "",
    updatedAt: "",
  });
  const story = (id: string, requirementIds: string[], priority?: "must" | "wont") => ({
    id,
    type: "story" as const,
    summary: "Send the renewal letter",
    persona: "Renewals agent",
    want: "the letter sent",
    benefit: "clients renew",
    acceptanceCriteria: [{ given: "a policy", when: "30 days are left", then: "a letter is sent" }],
    requirementIds,
    ...(priority ? { priority } : {}),
  });
  const backlog: Backlog = {
    title: "Renewals",
    epics: [
      { id: "E1", summary: "Renewal letters", outcome: "Clients renew on time", stories: [story("S1", ["R1"]), story("S2", ["R2"], "wont")] },
      { id: "E2", summary: "Later work", outcome: "Clients renew on time", priority: "wont", stories: [story("S3", ["R3"])] },
    ],
  };

  it("counts only stories that are published, and needs no story for a won't-have requirement", () => {
    const findings = coverageFindings(backlog, [r("R1", "must"), r("R2", "must"), r("R3", "could"), r("R4", "wont")], "error");
    expect(findings.map((f) => `${f.level} ${f.where}`)).toEqual(["error R2", "warning R3"]);
    expect(coverageFindings(backlog, [r("R2", "must")], "error", new Set(["R2"]))).toEqual([]);
    expect(coverageFindings(backlog, [r("R2", "must")], "warning")[0]!.level).toBe("warning");
  });

  it("checks requirement ids, traces inputs through them, and leaves whole-backlog checks out of a draft", () => {
    const docs = [doc("doc-0000000001", "Audit policy", "Keep every letter for 10 years for the audit.")];
    const cited = checkBacklog(backlog, docs, "en", { requirements: [r("R1", "must", ["doc-0000000001"]), r("R2", "must")] });
    expect(cited.filter((f) => f.level === "error").map((f) => f.message)).toEqual(["R3 is not a confirmed requirement: cite only the confirmed ids."]);
    // The audit input is cited through R1, and the stories through their requirements.
    expect(cited.some((f) => f.where === "doc-0000000001")).toBe(false);
    expect(cited.some((f) => f.message.startsWith("No source documents"))).toBe(false);
    // Without the requirements, ids are not checked.
    expect(checkBacklog(backlog, docs).some((f) => f.message.includes("not a confirmed requirement"))).toBe(false);
    const draft = { ...backlog, epics: [{ ...backlog.epics[0]!, stories: [] }] };
    expect(checkBacklog(draft, docs, "en", { draft: true })).toEqual([]);
    expect(checkBacklog(draft, docs).map((f) => f.message)).toContain("Epic has no stories.");
  });
});
