import { describe, expect, it } from "vitest";
import path from "node:path";
import { loadLocalDocuments } from "../src/loaders/documents.js";
import { adfToText, confluencePageId } from "../src/connectors/atlassian.js";

const inputs = path.join(import.meta.dirname, "fixtures", "inputs");

describe("loadLocalDocuments", () => {
  it("loads a folder, parsing emails and markdown notes", async () => {
    const docs = await loadLocalDocuments(inputs);
    expect(docs).toHaveLength(2);

    const notes = docs.find((d) => d.title === "Renewal portal kickoff");
    expect(notes?.kind).toBe("other");

    const email = docs.find((d) => d.kind === "email");
    expect(email?.title).toBe("Requirements for policy renewal portal");
    expect(email?.metadata?.from).toBe("Security Team <security@example.com>");
    expect(email?.content).toContain("MFA is mandatory");
    expect(email?.content).not.toContain("<p>");
  });

  it("applies an explicit kind", async () => {
    const [doc] = await loadLocalDocuments(path.join(inputs, "kickoff-notes.md"), "meeting-notes");
    expect(doc.kind).toBe("meeting-notes");
  });
});

describe("Atlassian helpers", () => {
  it("converts ADF to text", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Goal" }] },
        { type: "paragraph", content: [{ type: "text", text: "Renew online." }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "MFA" }] }] }] },
      ],
    };
    expect(adfToText(adf)).toBe("## Goal\n\nRenew online.\n\n- MFA\n\n");
  });

  it("extracts Confluence page ids from URLs", () => {
    expect(confluencePageId("12345")).toBe("12345");
    expect(confluencePageId("https://x.atlassian.net/wiki/spaces/SA/pages/98765/Design")).toBe("98765");
    expect(() => confluencePageId("not a page")).toThrow();
  });
});
