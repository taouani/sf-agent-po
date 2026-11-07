import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A scenario is a folder with:
 * - `scenario.json`: id, title, industry template, language, and where the inputs are
 * - `rubric.md`: one `## <title> (<task>)` section per agent task, each with `- [ ]` criteria
 * - the inputs (and optionally a local metadata repository)
 */
export interface Scenario {
  id: string;
  title: string;
  industry?: string;
  /** Language of the inputs and of the expected output, e.g. "en" or "fr". */
  language: string;
  dir: string;
  inputsDir: string;
  metadataDir?: string;
  sections: RubricSection[];
}

export interface RubricSection {
  title: string;
  /** The server prompt that produces what this section judges, e.g. "sa_high_level_design". */
  task: string;
  criteria: string[];
}

/**
 * Tasks the runner knows how to start, in the order they run: the tool that saves
 * each one's artifact, and the tool that returns it in structured form, if any.
 */
export const TASKS: Record<"sa_high_level_design" | "po_backlog", { saveTool: string; getTool?: string }> = {
  sa_high_level_design: { saveTool: "design_save" },
  po_backlog: { saveTool: "backlog_save", getTool: "backlog_get" },
};

export type Task = keyof typeof TASKS;

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The scenarios kept in the repository: the 0.x samples in `examples/` and the eval package's own. */
export const BUILTIN_SCENARIO_ROOTS = [join(REPO_ROOT, "examples"), join(REPO_ROOT, "packages", "eval", "scenarios")];

export function listScenarios(roots: readonly string[] = BUILTIN_SCENARIO_ROOTS): Scenario[] {
  const found: Scenario[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && existsSync(join(root, entry.name, "scenario.json"))) found.push(loadScenario(join(root, entry.name)));
    }
  }
  const ids = new Set<string>();
  for (const s of found) {
    if (ids.has(s.id)) throw new Error(`Two scenarios have the id "${s.id}".`);
    ids.add(s.id);
  }
  return found;
}

export function loadScenario(dir: string): Scenario {
  const file = join(dir, "scenario.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const str = (key: string, required = true): string | undefined => {
    const v = raw[key];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || !v) throw new Error(`${file}: "${key}" must be a non-empty string.`);
    return v;
  };
  const inputsDir = resolve(dir, str("inputs", false) ?? "inputs");
  if (!existsSync(inputsDir)) throw new Error(`${file}: the inputs folder ${inputsDir} does not exist.`);
  const metadata = str("metadata", false);
  const metadataDir = metadata ? resolve(dir, metadata) : undefined;
  if (metadataDir && !existsSync(metadataDir)) throw new Error(`${file}: the metadata folder ${metadataDir} does not exist.`);
  const rubricFile = join(dir, "rubric.md");
  const sections = parseRubric(readFileSync(rubricFile, "utf8"), rubricFile);
  if (!sections.length) throw new Error(`${rubricFile}: no section names a task, e.g. "## High-level design (sa_high_level_design)".`);
  return {
    id: str("id")!,
    title: str("title")!,
    industry: str("industry", false),
    language: str("language", false) ?? "en",
    dir,
    inputsDir,
    metadataDir,
    sections,
  };
}

/**
 * Reads the rubric's task sections. Sections without a task in brackets (for
 * example "Inputs") are notes for people and are skipped.
 */
export function parseRubric(markdown: string, file: string): RubricSection[] {
  const sections: RubricSection[] = [];
  let current: RubricSection | undefined;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const heading = line.match(/^## +(.+?)\s*$/);
    if (heading) {
      const task = heading[1]!.match(/^(.*?)\s*\(([a-z_]+)\)$/);
      current = undefined;
      if (task) {
        if (!(task[2]! in TASKS)) throw new Error(`${file}: unknown task "${task[2]}". Known tasks: ${Object.keys(TASKS).join(", ")}.`);
        current = { title: task[1]!, task: task[2]!, criteria: [] };
        sections.push(current);
      }
      continue;
    }
    const item = line.match(/^- \[[ xX]\] +(.+)$/);
    if (item && current) current.criteria.push(item[1]!.trim());
  }
  for (const s of sections) if (!s.criteria.length) throw new Error(`${file}: the section "${s.title}" has no "- [ ]" criteria.`);
  return sections;
}
