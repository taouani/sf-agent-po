import { describe, expect, it } from "vitest";
import path from "node:path";
import { htmlToText, loadLocalDocuments, textDocument } from "../src/files.js";

const inputs = path.join(import.meta.dirname, "fixtures", "inputs");

describe("loadLocalDocuments", () => {
  it("loads a folder, parsing emails and markdown notes", async () => {
    const docs = await loadLocalDocuments(inputs);
    expect(docs).toHaveLength(3);

    const notes = docs.find((d) => d.title === "Renewal portal kickoff");
    expect(notes?.kind).toBe("other");

    const email = docs.find((d) => d.title === "Requirements for policy renewal portal");
    expect(email?.kind).toBe("email");
    expect(email?.metadata?.from).toBe("Security Team <security@example.com>");
    expect(email?.content).toContain("MFA is mandatory");
    expect(email?.content).not.toContain("<p>");
  });

  it("decodes nested multipart, quoted-printable bodies, encoded headers and attachments", async () => {
    const [doc] = await loadLocalDocuments(path.join(inputs, "pi-planning-decisions.eml"));
    expect(doc.title).toBe("PI planning – decisions");
    expect(doc.content).toBe("Renewal portal is committed for PI 4.\nAgents get a dashboard of renewals due in 30 days.");
    expect(doc.metadata).toMatchObject({
      from: "Renée Martin <pm@example.com>",
      to: "sa@example.com, po@example.com",
      attachments: ["objectives.csv"],
    });
  });

  it("applies an explicit kind", async () => {
    const [doc] = await loadLocalDocuments(path.join(inputs, "kickoff-notes.md"), "meeting-notes");
    expect(doc.kind).toBe("meeting-notes");
  });

  it("keeps two pastes with the same title apart", () => {
    const a = textDocument("Sprint 1 decisions", "Use Flow.", "meeting-notes");
    const b = textDocument("Sprint 1 decisions", "Use Apex.", "meeting-notes");
    expect(a.source).not.toBe(b.source);
    expect(textDocument("Sprint 1 decisions", "Use Flow.", "meeting-notes").source).toBe(a.source);
  });
});

describe("htmlToText", () => {
  it("keeps code macro bodies and decodes entities once", () => {
    const html =
      '<p>Rule:</p><ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[if (premium > 0 && x < 3) {}]]></ac:plain-text-body></ac:structured-macro><p>Write &amp;lt; literally</p>';
    const text = htmlToText(html);
    expect(text).toContain("if (premium > 0 && x < 3) {}");
    expect(text).toContain("Write &lt; literally");
  });
});
