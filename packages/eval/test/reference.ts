// The insurance scenario's hand-written reference backlog, with its input placeholders
// ({{inputs/<file>}}) turned into the ids of the documents the server made from those files.
// Sources are masked, so a document is found by its title, which is in its file's text.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listScenarios } from "../src/index.js";

export const insurance = listScenarios().find((s) => s.id === "insurance-renewal")!;

/** `shown` is what context_show returned for the context the inputs were added to. */
export function referenceBacklog(shown: string): { epics: { stories: { sourceIds?: string[] }[] }[] } & Record<string, unknown> {
  const docs = [...shown.matchAll(/\[(doc-[0-9a-f]{10})\] [\w-]+: (.+) \(\[SOURCE_\d+\]/g)].map((m) => ({ id: m[1]!, title: m[2]! }));
  const idFor = (file: string) => {
    const text = readFileSync(join(insurance.inputsDir, file), "utf8");
    const found = docs.filter((d) => text.includes(d.title));
    if (found.length !== 1) throw new Error(`No single document for inputs/${file} in: ${shown}`);
    return found[0]!.id;
  };
  return JSON.parse(readFileSync(join(insurance.dir, "reference-backlog.json"), "utf8").replace(/\{\{inputs\/([^}]+)\}\}/g, (_, f: string) => idFor(f)));
}
