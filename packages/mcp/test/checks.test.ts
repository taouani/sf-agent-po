import { describe, expect, it } from "vitest";
import { checkRules, detectLanguage, languageFinding, wordsPattern } from "../src/checks.js";
import { checkBacklog, checkRequirements, type Backlog } from "../src/index.js";

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
    const english = checkRequirements(
      [{ kind: "functional", statement: "Le conseiller doit envoyer la lettre de renouvellement trente jours avant la date de fin du contrat", priority: "must", sourceIds: ["doc-000000000a"] }],
      [],
      docs,
      "en",
    );
    expect(english.map((f) => f.message)).toContain("This reads as French, but the context's output language is English: write it in English.");
  });
});
