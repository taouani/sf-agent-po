import { normaliseType, type Span } from "./spans.js";

/** A value the context already knows must be masked, for example an org user's name. */
export interface DictionaryEntry {
  value: string;
  type: string;
  /** Match the case as written (for values learned from the model, such as a one-word name). */
  caseSensitive?: boolean;
}

/** Scripts written without spaces between words: Chinese, Japanese kana and Korean Hangul. */
const isCjk = (s: string) => /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯豈-﫿]/u.test(s);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Group {
  re: RegExp;
  types: Map<string, string>;
  /** Each entry's own expression, built only if a match's type cannot be found by its key. */
  entries: () => { re: RegExp; type: string }[];
  key: (s: string) => string;
}

const SEP = "\u0000";

const lazy = <T>(make: () => T): (() => T) => {
  let value: T | undefined;
  return () => (value ??= make());
};

/**
 * One alternation shaped as a trie, so the engine follows a value's characters instead of
 * trying every value at every position: a few thousand names cost about as much as a few.
 * Whitespace inside a value matches any run of spaces, dots, underscores or dashes.
 */
function trieAlternation(values: readonly string[], fold: boolean, separators: boolean): string {
  type Node = Map<string, Node> & { end?: boolean };
  const root: Node = new Map();
  for (const v of values) {
    let node = root;
    for (const unit of units(v, fold, separators)) {
      let next = node.get(unit);
      if (!next) node.set(unit, (next = new Map()));
      node = next;
    }
    node.end = true;
  }
  const emit = (node: Node): string => {
    const branches = [...node].map(([unit, child]) => (unit === SEP ? "[\\s._-]*" : escape(unit)) + emit(child));
    if (!branches.length) return "";
    const body = branches.length === 1 ? branches[0]! : `(?:${branches.join("|")})`;
    return node.end ? `(?:${body})?` : body;
  };
  return emit(root);
}

/** A value's characters for the trie; with `fold`, lower-cased where that keeps one character. */
function units(value: string, fold: boolean, separators: boolean): string[] {
  const out: string[] = [];
  for (const ch of value) {
    if (separators && /\s/u.test(ch)) {
      if (out[out.length - 1] !== SEP) out.push(SEP);
      continue;
    }
    const lower = fold ? ch.toLowerCase() : ch;
    out.push([...lower].length === 1 ? lower : ch);
  }
  return out;
}

/** Known values compiled into a few regular expressions, so a long list costs one pass per group. */
export interface CompiledDictionary {
  readonly size: number;
  find(text: string): Span[];
}

/**
 * Compiles known values. CJK values match anywhere (those scripts have no spaces); others
 * must stand as whole words, and the words of a name may be written with any spacing or
 * joined ("Sarah  Whitfield", "SarahWhitfield", "sarah.whitfield"). Case is ignored unless
 * an entry is `caseSensitive`. Values shorter than two characters are skipped, since they
 * would match almost everywhere.
 */
export function compileDictionary(entries: readonly DictionaryEntry[]): CompiledDictionary {
  const buckets = { cjk: [] as DictionaryEntry[], nocase: [] as DictionaryEntry[], cased: [] as DictionaryEntry[] };
  for (const e of entries) {
    const value = e.value.trim();
    if ([...value].length < 2) continue;
    const entry = { ...e, value, type: normaliseType(e.type) };
    (isCjk(value) ? buckets.cjk : e.caseSensitive ? buckets.cased : buckets.nocase).push(entry);
  }
  const bounded = (body: string) => `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`;
  const loose = (s: string) => s.replace(/[\s._-]+/g, "");
  const group = (list: DictionaryEntry[], fold: boolean, words: boolean, key: (s: string) => string): Group | undefined => {
    if (!list.length) return undefined;
    const types = new Map<string, string>();
    for (const e of list) if (!types.has(key(e.value))) types.set(key(e.value), e.type);
    const flags = fold ? "giu" : "gu";
    const pattern = (values: readonly string[]) => {
      const body = trieAlternation(values, fold, words);
      return words ? bounded(body) : body;
    };
    return {
      re: new RegExp(pattern(list.map((e) => e.value)), flags),
      types,
      entries: lazy(() => list.map((e) => ({ re: new RegExp(`^(?:${pattern([e.value])})$`, flags.replace("g", "")), type: e.type }))),
      key,
    };
  };
  const groups = [
    group(buckets.cjk, false, false, (s) => s),
    group(buckets.nocase, true, true, (s) => loose(s).toLowerCase()),
    group(buckets.cased, false, true, loose),
  ].filter((g): g is Group => Boolean(g));
  return {
    size: buckets.cjk.length + buckets.nocase.length + buckets.cased.length,
    find(text) {
      const spans: Span[] = [];
      for (const g of groups) {
        for (const m of text.matchAll(g.re)) {
          // The type of the entry that matched; case folding can differ from toLowerCase, so fall back to testing each entry.
          const type = g.types.get(g.key(m[0])) ?? g.entries().find((e) => e.re.test(m[0]))?.type;
          if (type) spans.push({ start: m.index, end: m.index + m[0].length, type, source: "dictionary" });
        }
      }
      return spans;
    },
  };
}

/** Finds known values in `text` (see compileDictionary). */
export function detectWithDictionary(text: string, entries: readonly DictionaryEntry[]): Span[] {
  return compileDictionary(entries).find(text);
}
