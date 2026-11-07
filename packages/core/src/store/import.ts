import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ContextRepository, DOCUMENT_KINDS, documentId, type DocumentKind, type ImportedContext } from "./contexts.js";
import type { Database } from "./db.js";

/**
 * Imports the requirement contexts that sf-agent-po 0.x kept as JSON files in
 * `<workspace>/contexts/<name>.json` (MI1). The files are only read, never
 * changed or deleted, so 0.x keeps working on the same workspace.
 *
 * Imported documents are not masked (`masked` = 0): phase 2 masks them before
 * any model sees them.
 */
export interface ImportReport {
  imported: { name: string; documents: number; warnings: string[] }[];
  /** Contexts already in the database, left alone (pass `replace` to overwrite them). */
  skipped: string[];
  failed: { file: string; error: string }[];
}

export async function importLegacyWorkspace(workspaceDir: string, database: Database, { replace = false } = {}): Promise<ImportReport> {
  const report: ImportReport = { imported: [], skipped: [], failed: [] };
  const dir = join(workspaceDir, "contexts");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return report;
    throw err;
  }
  const repo = new ContextRepository(database);
  for (const f of files) {
    const file = join(dir, f);
    try {
      const { context, warnings } = parseLegacyContext(JSON.parse(await readFile(file, "utf8")), f.slice(0, -".json".length));
      if (repo.importContext(context, { replace })) report.imported.push({ name: context.name, documents: context.documents.length, warnings });
      else report.skipped.push(context.name);
    } catch (err) {
      report.failed.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

/**
 * Checks one 0.x context file and turns it into an ImportedContext. It is
 * lenient where a value can be recovered (a missing date, an unknown kind) and
 * reports it as a warning; it throws only when the file is not a context.
 */
export function parseLegacyContext(raw: unknown, fileName: string): { context: ImportedContext; warnings: string[] } {
  const warnings: string[] = [];
  if (!isObject(raw) || !Array.isArray(raw.documents)) throw new Error("Not a sf-agent-po context: no documents list.");
  // 0.x always wrote the file under its context name; trust the file name if they differ.
  const name = fileName;
  if (raw.name !== name) warnings.push(`The file says the context is "${String(raw.name)}"; imported as "${name}" after its file name.`);
  const now = new Date().toISOString();
  const createdAt = date(raw.createdAt) ?? now;
  const updatedAt = date(raw.updatedAt) ?? createdAt;

  const documents: ImportedContext["documents"] = [];
  raw.documents.forEach((d: unknown, i: number) => {
    const where = `Document ${i + 1}`;
    if (!isObject(d) || typeof d.source !== "string" || d.source === "") {
      warnings.push(`${where} has no source and was left out.`);
      return;
    }
    const kind = DOCUMENT_KINDS.includes(d.kind as DocumentKind) ? (d.kind as DocumentKind) : "other";
    if (kind !== d.kind) warnings.push(`${where} (${d.source}) has the unknown kind "${String(d.kind)}"; imported as "other".`);
    if (d.id !== undefined && d.id !== documentId(d.source)) {
      warnings.push(`${where} (${d.source}) had the id ${String(d.id)}; its id is now ${documentId(d.source)}.`);
    }
    if (typeof d.content !== "string") warnings.push(`${where} (${d.source}) has no text content.`);
    documents.push({
      kind,
      title: typeof d.title === "string" && d.title !== "" ? d.title : d.source,
      source: d.source,
      content: typeof d.content === "string" ? d.content : "",
      metadata: isObject(d.metadata) ? d.metadata : {},
      masked: false,
      addedAt: date(d.addedAt) ?? createdAt,
    });
  });
  // 0.x could store the same source twice; like addDocuments, the last one wins.
  const bySource = new Map(documents.map((d) => [d.source, d]));
  if (bySource.size < documents.length) warnings.push(`${documents.length - bySource.size} duplicate document(s) from the same source; kept the last one.`);
  return { context: { name, createdAt, updatedAt, documents: [...bySource.values()] }, warnings };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function date(v: unknown): string | undefined {
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : undefined;
}
