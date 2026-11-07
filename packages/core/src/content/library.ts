import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Domain content as Markdown files (DE4): industry templates, the agents' roles
 * and practices, and document templates. Keeping them out of the code lets an
 * SA or PO review and change them without touching TypeScript, and lets a team
 * add its own industries in another folder.
 *
 * Layout of a content folder:
 * - `industries/<id>.md`: front matter (id, name, aliases), then one `## ` section per topic
 * - `agents/<id>.md` and `templates/<id>.md`: plain Markdown, used as written
 */
export const BUILTIN_CONTENT_DIR = fileURLToPath(new URL("../../content/", import.meta.url));

export const INDUSTRY_SECTIONS = {
  products: "Salesforce products to consider",
  dataModel: "Data model",
  regulations: "Regulation and compliance",
  integrations: "Typical integrations",
  watchFor: "Watch for",
} as const;

export type IndustrySection = keyof typeof INDUSTRY_SECTIONS;

export interface IndustryTemplate extends Record<IndustrySection, string> {
  id: string;
  name: string;
  aliases: string[];
  /** The file it was read from, for error messages. */
  file: string;
}

export class ContentLibrary {
  private readonly industryById = new Map<string, IndustryTemplate>();
  private readonly aliasToId = new Map<string, string>();
  private readonly texts = new Map<string, string>();

  /**
   * Reads the given content folders in order. A later folder replaces an
   * industry, agent text or template with the same id, so a team folder can
   * override the built-in content. Invalid files throw with the file named.
   */
  constructor(dirs: readonly string[] = [BUILTIN_CONTENT_DIR]) {
    for (const dir of dirs) {
      for (const file of markdownFiles(join(dir, "industries"))) {
        const t = parseIndustry(readFileSync(file, "utf8"), file);
        this.industryById.set(t.id, t);
      }
      for (const kind of ["agents", "templates"]) {
        for (const file of markdownFiles(join(dir, kind))) {
          this.texts.set(`${kind}/${basename(file, ".md")}`, normaliseText(readFileSync(file, "utf8")).trim());
        }
      }
    }
    for (const t of this.industryById.values()) {
      for (const alias of t.aliases) {
        const other = this.aliasToId.get(alias);
        if (other && other !== t.id) {
          const first = this.industryById.get(other)!;
          throw new Error(
            `The industry alias "${alias}" is used by both ${other} (${first.file}) and ${t.id} (${t.file}). ` +
              `Remove it from one of them; to change a built-in industry's aliases, add your own ${other}.md.`,
          );
        }
        if (this.industryById.has(alias) && alias !== t.id) throw new Error(`The industry alias "${alias}" in ${t.file} is also an industry id.`);
        this.aliasToId.set(alias, t.id);
      }
    }
  }

  industries(): IndustryTemplate[] {
    return [...this.industryById.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Finds an industry by id, alias or what a user typed ("Energy & utilities", "banking"). */
  industry(value: string | undefined): IndustryTemplate | undefined {
    const key = normaliseIndustry(value);
    if (!key) return undefined;
    return this.industryById.get(key) ?? this.industryById.get(this.aliasToId.get(key) ?? "");
  }

  /** The industry block for a prompt, or "" when none is chosen. */
  industryGuidance(value: string | undefined): string {
    if (!value?.trim()) return "";
    const t = this.industry(value);
    const ids = this.industries().map((i) => i.id);
    if (!t) {
      return `## Industry\n\n"${value}" is not one of the industry templates (${ids.join(", ")}). Ask the user whether one of them fits; otherwise work without industry guidance.`;
    }
    return `## Industry: ${t.name}

- **Salesforce products to consider:** ${t.products}
- **Data model:** ${t.dataModel}
- **Regulation and compliance:** ${t.regulations}
- **Typical integrations:** ${t.integrations}
- **Watch for:** ${t.watchFor}

Product names and object names differ between releases and licences. Before relying on an industry object or feature, confirm it is licensed and present in the metadata or org documents; if it is not, say so and treat it as an option to evaluate.`;
  }

  /** An agent text, e.g. "sa-role". */
  agent(id: string): string {
    return this.text("agents", id);
  }

  /** A document template, e.g. "high-level-design". */
  template(id: string): string {
    return this.text("templates", id);
  }

  private text(kind: string, id: string): string {
    const text = this.texts.get(`${kind}/${id}`);
    if (text === undefined) throw new Error(`No ${kind} content "${id}". Available: ${this.ids(kind).join(", ") || "none"}.`);
    return text;
  }

  private ids(kind: string): string[] {
    return [...this.texts.keys()].filter((k) => k.startsWith(`${kind}/`)).map((k) => k.slice(kind.length + 1)).sort();
  }
}

/** Lowercases and turns spaces, underscores, "&" and "and" into hyphens, as 0.x did. */
export function normaliseIndustry(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s*(&|\band\b)\s*/g, "-")
    .replace(/[\s_]+/g, "-");
}

export function parseIndustry(markdown: string, file: string): IndustryTemplate {
  const { data, body } = parseFrontMatter(normaliseText(markdown), file);
  const id = data.id;
  if (typeof id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error(`${file}: "id" must be lowercase words joined by hyphens.`);
  if (basename(file, ".md") !== id) throw new Error(`${file}: the file name must be ${id}.md.`);
  if (typeof data.name !== "string" || !data.name) throw new Error(`${file}: "name" is missing.`);
  const aliases = data.aliases ?? [];
  if (!Array.isArray(aliases)) throw new Error(`${file}: "aliases" must be a list, e.g. [banking, fsi].`);

  const sections = new Map<string, string>();
  const parts = body.split(/^## +(.+?)[ \t]*$/m);
  if (parts[0]!.trim()) throw new Error(`${file}: text before the first "## " section.`);
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i]!;
    const text = parts[i + 1]!.trim();
    if (sections.has(heading)) throw new Error(`${file}: the section "## ${heading}" appears twice.`);
    // The guidance puts each section in one bullet, so headings or blank lines inside it would break the prompt.
    if (/^#/m.test(text) || /\n\s*\n/.test(text)) throw new Error(`${file}: the section "## ${heading}" must be one paragraph, without headings or blank lines.`);
    sections.set(heading, text);
  }
  const known = new Set<string>(Object.values(INDUSTRY_SECTIONS));
  const unknown = [...sections.keys()].filter((s) => !known.has(s));
  if (unknown.length) throw new Error(`${file}: unknown section(s) ${unknown.map((s) => `"${s}"`).join(", ")}. Use: ${[...known].join(", ")}.`);

  const t = { id, name: data.name, aliases: aliases.map(normaliseIndustry), file } as IndustryTemplate;
  for (const [key, heading] of Object.entries(INDUSTRY_SECTIONS) as [IndustrySection, string][]) {
    const text = sections.get(heading);
    if (!text) throw new Error(`${file}: the section "## ${heading}" is missing or empty.`);
    t[key] = text;
  }
  return t;
}

/**
 * Reads a small subset of YAML front matter: `key: value` and `key: [a, b]`.
 * That is all the content files need, and it avoids a YAML dependency.
 */
export function parseFrontMatter(markdown: string, file: string): { data: Record<string, string | string[]>; body: string } {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) throw new Error(`${file}: missing front matter (a "---" block at the top).`);
  const data: Record<string, string | string[]> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) throw new Error(`${file}: cannot read the front matter line "${line}".`);
    const value = kv[2]!.trim();
    const list = value.match(/^\[(.*)\]$/);
    if (/["']/.test(list ? list[1]! : value.replace(/^(["'])(.*)\1$/, "$2"))) {
      throw new Error(`${file}: write the front matter line "${line}" without quotes (a single value may be quoted as a whole).`);
    }
    data[kv[1]!] = list ? list[1]!.split(",").map((s) => s.trim()).filter(Boolean) : value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return { data, body: markdown.slice(m[0].length) };
}

function markdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => join(dir, f));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Drops a byte order mark and Windows line endings (git may check files out with CRLF). */
function normaliseText(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, "\n");
}
