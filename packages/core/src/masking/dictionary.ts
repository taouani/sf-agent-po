import type { Span } from "./spans.js";

/** A value the context already knows must be masked, for example an org user's name. */
export interface DictionaryEntry {
  value: string;
  type: string;
}

const isCjk = (s: string) => /[\u3400-\u9fff]/u.test(s);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Finds known values. CJK values match anywhere (Chinese has no spaces); others must
 * stand as whole words, ignoring case. Values shorter than two characters are skipped,
 * since they would match almost everywhere.
 */
export function detectWithDictionary(text: string, entries: readonly DictionaryEntry[]): Span[] {
  const spans: Span[] = [];
  for (const e of entries) {
    const value = e.value.trim();
    if ([...value].length < 2) continue;
    const re = isCjk(value)
      ? new RegExp(escape(value), "gu")
      : new RegExp(`(?<![\\p{L}\\p{N}])${escape(value).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");
    for (const m of text.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length, type: e.type, source: "dictionary" });
  }
  return spans;
}
