// The version of the metadata readers, for the parse cache: a hash of their own code and of
// the XML parser's version, so that a release that changes how a file is read never reuses
// what an older one read.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The modules whose code decides what a file's components are. */
const READERS = ["scan", "model", "objects", "flows", "apex", "markup", "access", "reports", "xml", "registry", "registry-data"];

/** The version of a package this module loads, from its package.json. */
function packageVersion(name: string): string | undefined {
  try {
    let dir = dirname(createRequire(import.meta.url).resolve(name));
    for (let i = 0; i < 6; i++, dir = dirname(dir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
        if (pkg.name === name) return pkg.version;
      } catch {
        // not this folder
      }
    }
  } catch {
    // not found
  }
  return undefined;
}

function compute(): { version: string; complete: boolean } {
  const hash = createHash("sha256");
  let complete = true;
  for (const name of READERS) {
    // Built, the modules are .js files; under the test runner they are the .ts sources.
    const code = [".js", ".ts"]
      .map((ext) => {
        try {
          return readFileSync(new URL(`./${name}${ext}`, import.meta.url));
        } catch {
          return undefined;
        }
      })
      .find(Boolean);
    if (!code) complete = false;
    // A reader that cannot be found means the cache can never be trusted: no run reuses it.
    hash.update(code ?? randomUUID()).update("\0");
  }
  const xml = packageVersion("fast-xml-parser");
  if (!xml) complete = false;
  hash.update(`fast-xml-parser@${xml ?? randomUUID()}`);
  return { version: hash.digest("hex").slice(0, 16), complete };
}

// Computed when the module loads, from the code this process runs: a package upgraded in
// place under a running server must not tag what the old code parsed with the new version.
const READER = compute();

export function readerVersion(): string {
  return READER.version;
}

/** False when a reader's code or the XML parser's version could not be found: then nothing is ever reused. */
export function readerVersionComplete(): boolean {
  return READER.complete;
}
