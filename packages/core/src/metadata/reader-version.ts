// The version of the metadata readers, for the parse cache: a hash of their own code, so
// that a release that changes how a file is read never reuses what an older one read.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/** The modules whose code decides what a file's components are. */
const READERS = ["scan", "model", "objects", "flows", "apex", "markup", "access", "xml", "registry", "registry-data"];

let version: string | undefined;

export function readerVersion(): string {
  if (version) return version;
  const hash = createHash("sha256");
  for (const name of READERS) {
    // Built, the modules are .js files; under the test runner they are the .ts sources.
    const code = [".js", ".ts"].map((ext) => {
      try {
        return readFileSync(new URL(`./${name}${ext}`, import.meta.url));
      } catch {
        return undefined;
      }
    }).find(Boolean);
    // A reader that cannot be found means the cache can never be trusted: no run reuses it.
    hash.update(code ?? randomUUID()).update("\0");
  }
  return (version = hash.digest("hex").slice(0, 16));
}
