import { describe, expect, it } from "vitest";
import { XMLValidator } from "fast-xml-parser";
import { markdownToStorage } from "../src/publish/storage.js";

/** Confluence storage format must be well-formed XML once the ac: namespace is declared. */
function wellFormed(storage: string): true | unknown {
  return XMLValidator.validate(`<root xmlns:ac="urn:ac" xmlns:ri="urn:ri">${storage}</root>`);
}

describe("markdownToStorage", () => {
  it("renders headings, lists, tables and line breaks as well-formed XHTML", () => {
    const md = [
      "# Design",
      "",
      "Line one  ",
      "line two",
      "",
      "- [x] done",
      "- [ ] todo",
      "",
      "| System | Pattern |",
      "| --- | --- |",
      "| SAP | Batch |",
      "",
      "---",
      "",
      "![diagram](https://example.com/d.png)",
    ].join("\n");
    const storage = markdownToStorage(md);
    expect(storage).toContain("<h1>Design</h1>");
    expect(storage).toContain("<br />");
    expect(storage).toContain("<hr />");
    expect(storage).toContain("[x] done");
    expect(storage).toContain("<td>SAP</td>");
    expect(wellFormed(storage)).toBe(true);
  });

  it("turns fenced code, including Mermaid, into code macros", () => {
    const storage = markdownToStorage("```mermaid\ngraph TD; A-->B\n```\n\n```apex\nif (a < b && c > d) {}\n```");
    expect(storage).toContain('<ac:structured-macro ac:name="code"><ac:parameter ac:name="title">Mermaid diagram</ac:parameter>');
    expect(storage).toContain("<![CDATA[graph TD; A-->B]]>");
    expect(storage).toContain('<ac:parameter ac:name="language">java</ac:parameter>');
    expect(storage).toContain("<![CDATA[if (a < b && c > d) {}]]>");
    expect(wellFormed(storage)).toBe(true);
  });

  it("cannot be broken by raw HTML or a CDATA terminator in the Markdown", () => {
    const storage = markdownToStorage('<div class="x">unclosed\n\n<script>alert(1)</script>\n\n```\nend ]]> here\n```');
    expect(storage).not.toContain("<script>");
    expect(storage).toContain("&lt;script&gt;");
    expect(wellFormed(storage)).toBe(true);
  });
});
