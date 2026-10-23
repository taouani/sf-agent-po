import { describe, expect, it } from "vitest";
import { XMLValidator } from "fast-xml-parser";
import { markdownToStorage } from "../src/publish/storage.js";

/**
 * Confluence storage format must be well-formed XML once the ac: namespace is declared.
 * XMLValidator is lenient about entities and control characters, so check those separately.
 */
function wellFormed(storage: string): true | unknown {
  const outsideCdata = storage.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const badEntity = outsideCdata.match(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)\S{0,10}/);
  if (badEntity) return `undefined entity: ${badEntity[0]}`;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(storage)) return "control character";
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

  it("escapes stray ampersands and drops control characters, leaving code untouched", () => {
    const storage = markdownToStorage("AT&T; and &nbsp; \u000c [link](https://x.com/?a=1&b=2)\n\n```js title=x\n<img src=x> & more\n```");
    expect(storage).toContain("AT&amp;T;");
    expect(storage).toContain('href="https://x.com/?a=1&amp;b=2"');
    expect(storage).toContain('<ac:parameter ac:name="language">js</ac:parameter>');
    expect(storage).toContain("<![CDATA[<img src=x> & more]]>");
    expect(wellFormed(storage)).toBe(true);
  });

  it("cannot be broken by raw HTML or a CDATA terminator in the Markdown", () => {
    const storage = markdownToStorage('<div class="x">unclosed\n\n<script>alert(1)</script>\n\n```\nend ]]> here\n```');
    expect(storage).not.toContain("<script>");
    expect(storage).toContain("&lt;script&gt;");
    expect(wellFormed(storage)).toBe(true);
  });
});
