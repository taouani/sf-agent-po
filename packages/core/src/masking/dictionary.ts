import { normaliseType, type Span } from "./spans.js";

/** A value the context already knows must be masked, for example an org user's name. */
export interface DictionaryEntry {
  value: string;
  type: string;
}

/** Scripts written without spaces between words: Chinese, Japanese kana and Korean Hangul. */
const isCjk = (s: string) => /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯豈-﫿]/u.test(s);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Finds known values. CJK values match anywhere (those scripts have no spaces); others
 * must stand as whole words, ignoring case, and the words of a name may be written with
 * any spacing or joined ("Sarah  Whitfield", "SarahWhitfield", "sarah.whitfield").
 * Values shorter than two characters are skipped, since they would match almost everywhere.
 */
export function detectWithDictionary(text: string, entries: readonly DictionaryEntry[]): Span[] {
  const spans: Span[] = [];
  for (const e of entries) {
    const value = e.value.trim();
    if ([...value].length < 2) continue;
    const type = normaliseType(e.type);
    const re = isCjk(value)
      ? new RegExp(escape(value), "gu")
      : new RegExp(`(?<![\\p{L}\\p{N}])${value.split(/\s+/).map(escape).join("[\\s._-]*")}(?![\\p{L}\\p{N}])`, "giu");
    for (const m of text.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length, type, source: "dictionary" });
  }
  return spans;
}
