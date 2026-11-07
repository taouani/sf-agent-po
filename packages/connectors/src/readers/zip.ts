// Reads the parts of an Office file (a zip archive), within limits so a crafted file cannot
// exhaust memory.

import { strFromU8, unzipSync } from "fflate";

/**
 * The most an Office file may hold once unpacked. Parsed XML takes about 80 times its size in
 * memory, so XML parts read into a tree are kept small (`xml`); parts scanned as a stream
 * (worksheets, shared strings) may be larger (`part`).
 */
export const ZIP_LIMITS = { total: 128 * 1024 * 1024, part: 64 * 1024 * 1024, xml: 8 * 1024 * 1024, parts: 10_000 };

export interface ZipParts {
  has(name: string): boolean;
  names(): string[];
  text(name: string): string | undefined;
}

/** Opens a zip archive, unpacking only the parts `wanted` accepts. */
export function openZip(raw: Uint8Array, wanted: (name: string) => boolean = () => true, partLimit: (name: string) => number = () => ZIP_LIMITS.part): ZipParts {
  let total = 0;
  let count = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(raw, {
      filter: (f) => {
        if (++count > ZIP_LIMITS.parts) throw new Error(`it has more than ${ZIP_LIMITS.parts} parts`);
        if (!wanted(f.name)) return false;
        const limit = partLimit(f.name);
        if (f.originalSize > limit) throw new Error(`its part ${f.name} is larger than ${limit / 2 ** 20} MB unpacked`);
        total += f.originalSize;
        if (total > ZIP_LIMITS.total) throw new Error(`it is larger than ${ZIP_LIMITS.total / 2 ** 20} MB unpacked`);
        return true;
      },
    });
  } catch (err) {
    throw new Error(`This file cannot be read as an Office document: ${(err as Error).message}.`);
  }
  // A stored part can be larger than its header says (fflate cuts deflated parts to the declared size).
  const actual = Object.values(files).reduce((n, f) => n + f.length, 0);
  for (const [name, f] of Object.entries(files)) if (f.length > partLimit(name)) throw new Error(`This file cannot be read: its part ${name} is too large.`);
  if (actual > ZIP_LIMITS.total) throw new Error(`This file cannot be read: it is larger than ${ZIP_LIMITS.total / 2 ** 20} MB unpacked.`);
  return {
    has: (name) => name in files,
    names: () => Object.keys(files),
    text: (name) => (files[name] ? strFromU8(files[name]) : undefined),
  };
}

/** Resolves a relationship target against the part that refers to it ("../media/x.png" from "ppt/slides/slide1.xml"). */
export function resolvePart(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** The relationships of a part: id to target part. */
export function relationships(zip: ZipParts, part: string, parse: (xml: string) => { id: string; target: string; type: string }[]): Map<string, { target: string; type: string }> {
  const dir = part.split("/").slice(0, -1).join("/");
  const file = `${dir ? `${dir}/` : ""}_rels/${part.split("/").pop()}.rels`;
  const xml = zip.text(file);
  const out = new Map<string, { target: string; type: string }>();
  if (!xml) return out;
  for (const r of parse(xml)) out.set(r.id, { target: resolvePart(part, r.target), type: r.type });
  return out;
}
