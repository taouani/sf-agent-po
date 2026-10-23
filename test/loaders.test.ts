import { describe, expect, it } from "vitest";
import path from "node:path";
import { htmlToText, loadLocalDocuments, textDocument } from "../src/loaders/documents.js";
import { AtlassianClient, adfToText, confluencePageId } from "../src/connectors/atlassian.js";

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

  it("keeps task items, links, cards and status in ADF", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { state: "DONE" }, content: [{ type: "text", text: "Confirm MFA vendor" }] },
            { type: "taskItem", attrs: { state: "TODO" }, content: [{ type: "text", text: "Agree SLA" }] },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "See spec", marks: [{ type: "link", attrs: { href: "https://example.com/spec" } }] },
            { type: "text", text: " " },
            { type: "status", attrs: { text: "APPROVED" } },
            { type: "text", text: " " },
            { type: "inlineCard", attrs: { url: "https://example.com/card" } },
          ],
        },
      ],
    };
    expect(adfToText(adf)).toBe(
      "- [x] Confirm MFA vendor\n- [ ] Agree SLA\n\nSee spec (https://example.com/spec) [APPROVED] https://example.com/card\n\n",
    );
  });

  it("extracts Confluence page ids from URLs", () => {
    expect(confluencePageId("12345")).toBe("12345");
    expect(confluencePageId("https://x.atlassian.net/wiki/spaces/SA/pages/98765/Design")).toBe("98765");
    expect(confluencePageId("https://x.atlassian.net/wiki/spaces/SA/pages/edit-v2/98765")).toBe("98765");
    expect(() => confluencePageId("not a page")).toThrow();
  });

  it("pages through Jira search results", async () => {
    const bodies: any[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      bodies.push(body);
      const page = body.nextPageToken ? 2 : 1;
      const issues = [1, 2].map((n) => ({ key: `PORT-${(page - 1) * 2 + n}`, fields: { summary: "s" } }));
      return new Response(JSON.stringify(page === 1 ? { issues, nextPageToken: "t2", isLast: false } : { issues, isLast: true }));
    }) as typeof fetch;
    const client = new AtlassianClient({ siteUrl: "https://x.atlassian.net", email: "e", apiToken: "t" }, fakeFetch);

    const docs = await client.searchIssues("project = PORT", 3);
    expect(docs.map((d) => d.metadata?.key)).toEqual(["PORT-1", "PORT-2", "PORT-3"]);
    expect(bodies.map((b) => [b.maxResults, b.nextPageToken])).toEqual([
      [3, undefined],
      [1, "t2"],
    ]);
  });
});
