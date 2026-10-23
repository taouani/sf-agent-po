import { Marked } from "marked";

const CODE_LANGUAGES = new Set(["java", "js", "javascript", "json", "sql", "xml", "html", "bash", "shell", "yaml", "text", "none"]);

/**
 * Converts the Markdown the agents write into Confluence storage format, which
 * must be well-formed XHTML. Fenced code (including Mermaid diagrams) becomes a
 * Confluence code macro, and raw HTML in the Markdown is escaped rather than
 * passed through, so the page body is always valid.
 */
const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? "").trim().toLowerCase();
      const param =
        language === "apex"
          ? "java" // Confluence has no Apex highlighter; Java is the closest.
          : CODE_LANGUAGES.has(language)
            ? language
            : "";
      const title = language === "mermaid" ? '<ac:parameter ac:name="title">Mermaid diagram</ac:parameter>' : "";
      return (
        '<ac:structured-macro ac:name="code">' +
        (param ? `<ac:parameter ac:name="language">${param}</ac:parameter>` : "") +
        title +
        `<ac:plain-text-body>${cdata(text)}</ac:plain-text-body></ac:structured-macro>\n`
      );
    },
    html({ text }) {
      return escapeXml(text);
    },
    checkbox({ checked }) {
      return checked ? "[x] " : "[ ] ";
    },
  },
});

export function markdownToStorage(markdown: string): string {
  const html = marked.parse(markdown, { async: false });
  // Self-close void elements so the result is XHTML.
  return html.replace(/<(br|hr|img)((?:\s[^>]*?)?)\s*\/?>/g, "<$1$2 />");
}

/** Wraps text in CDATA, splitting any "]]>" so it cannot end the section early. */
function cdata(text: string): string {
  return `<![CDATA[${text.split("]]>").join("]]]]><![CDATA[>")}]]>`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
