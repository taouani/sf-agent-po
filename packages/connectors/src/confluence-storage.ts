import { Marked } from "marked";

const CODE_LANGUAGES = new Set(["java", "js", "javascript", "json", "sql", "xml", "html", "bash", "shell", "yaml", "text", "none"]);

/** The name a Mermaid block carries in its info string ("```mermaid diagram=solution"), if any. */
function diagramName(lang: string | undefined): string | undefined {
  const [first = "", ...info] = (lang ?? "").trim().split(/\s+/);
  return first.toLowerCase() === "mermaid" ? info.find((x) => x.startsWith("diagram="))?.slice("diagram=".length) || undefined : undefined;
}

/** Set while one conversion runs: the diagrams to show in place of their Mermaid source. */
let diagrams: Readonly<Record<string, string>> | undefined;

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
      // The info string can carry more than the language, e.g. "js title=x".
      const language = (lang ?? "").trim().split(/\s+/)[0]!.toLowerCase();
      // "```mermaid diagram=solution": a diagram the publisher may show another way.
      const named = diagramName(lang);
      const shown = named !== undefined && diagrams && Object.hasOwn(diagrams, named) ? diagrams[named] : undefined;
      if (shown !== undefined) return `${shown}\n`;
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

// Characters XML 1.0 does not allow anywhere, even in CDATA.
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
// An "&" that does not start one of the five XML entities or a numeric reference.
const STRAY_AMPERSAND = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g;

export interface StorageOptions {
  /**
   * Storage to put in place of a Mermaid block whose info string names it ("```mermaid
   * diagram=solution"), such as a draw.io macro. A block not named here stays a code block.
   */
  diagrams?: Readonly<Record<string, string>>;
}

/** The names of the Mermaid blocks of a Markdown text, in order, as markdownToStorage reads them. */
export function diagramNames(markdown: string): string[] {
  const names: string[] = [];
  marked.walkTokens(marked.lexer(markdown), (t) => {
    const name = t.type === "code" ? diagramName((t as { lang?: string }).lang) : undefined;
    if (name !== undefined && !names.includes(name)) names.push(name);
  });
  return names;
}

export function markdownToStorage(markdown: string, options: StorageOptions = {}): string {
  let html: string;
  diagrams = options.diagrams;
  try {
    html = marked.parse(markdown.replace(INVALID_XML_CHARS, ""), { async: false });
  } finally {
    diagrams = undefined;
  }
  // Fix up everything outside CDATA sections (code macros keep their text verbatim).
  return html
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            // Self-close void elements so the result is XHTML.
            .replace(/<(br|hr|img)((?:\s[^>]*?)?)\s*\/?>/g, "<$1$2 />")
            // HTML named entities such as &nbsp; or a literal "AT&T;" are not defined in XML.
            .replace(STRAY_AMPERSAND, "&amp;"),
    )
    .join("");
}

/** Wraps text in CDATA, splitting any "]]>" so it cannot end the section early. */
function cdata(text: string): string {
  return `<![CDATA[${text.split("]]>").join("]]]]><![CDATA[>")}]]>`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
