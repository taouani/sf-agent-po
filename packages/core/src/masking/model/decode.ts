// Turns a token-classification model's output into entity spans. It imports no runtime,
// so it is tested without the model.

import { normaliseType, type Span } from "../spans.js";

export interface TokenOffset {
  start: number;
  end: number;
  /** A sub-word piece that continues the previous word. */
  continuation: boolean;
}

const SPECIAL = /^(\[CLS\]|\[SEP\]|\[PAD\]|\[MASK\]|<s>|<\/s>|<pad>|<mask>)$/;
const UNKNOWN = /^(\[UNK\]|<unk>)$/;
const CJK = /[㐀-鿿]/u;
/** Titles before a name, in English, French, German and Spanish. */
const TITLE = /^(?:(?:M|MM|Mme|Mmes|Mlle|Mr|Mrs|Ms|Mx|Dr|Pr|Prof|Me|Sr|Sra|Srta)\.?|Sir|Dame|Lord|Lady|Madame|Mademoiselle|Monsieur|Docteur|Herr|Frau)\s+/u;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where `piece` next appears in `text` from `cursor`: exactly, else ignoring case. The
 * case-insensitive search runs on the text itself, since lowercasing can change a
 * string's length ("İ") and shift every offset after it.
 */
function find(text: string, piece: string, cursor: number): { index: number; length: number } | null {
  const exact = text.indexOf(piece, cursor);
  if (exact >= 0) return { index: exact, length: piece.length };
  const re = new RegExp(escapeRe(piece), "giu");
  re.lastIndex = cursor;
  const m = re.exec(text);
  return m ? { index: m.index, length: m[0].length } : null;
}

/**
 * Maps WordPiece, SentencePiece or byte-level tokens back to character offsets in `text`.
 * An unknown token ([UNK], a word with a character the vocabulary lacks, such as "Sarah🙂")
 * is placed on the text between its neighbours, so its label is not lost.
 */
export function alignTokens(text: string, tokens: readonly string[]): (TokenOffset | null)[] {
  const sentencePiece = tokens.some((t) => t.startsWith("▁"));
  const out: (TokenOffset | null)[] = [];
  let cursor = 0;
  let unknown: number[] = [];
  /** Gives the pending unknown tokens the non-blank text from the cursor to `end`. */
  const placeUnknown = (end: number) => {
    const gap = text.slice(cursor, end);
    const start = cursor + (gap.length - gap.trimStart().length);
    const stop = end - (gap.length - gap.trimEnd().length);
    for (const i of unknown) out[i] = stop > start ? { start, end: stop, continuation: false } : null;
    unknown = [];
  };
  for (const tok of tokens) {
    if (UNKNOWN.test(tok)) {
      unknown.push(out.length);
      out.push(null);
      continue;
    }
    if (SPECIAL.test(tok)) {
      // A closing marker: the unknown tokens before it hold the rest of the text.
      if (unknown.length && cursor > 0) placeUnknown(text.length);
      out.push(null);
      continue;
    }
    const wordPieceCont = tok.startsWith("##");
    const spStart = tok.startsWith("▁") || tok.startsWith("Ġ");
    const piece = tok.replace(/^##/, "").replace(/^[▁Ġ]/, "");
    if (piece === "") {
      out.push(null);
      continue;
    }
    const found = find(text, piece, cursor);
    if (!found || (found.index - cursor > 64 && !unknown.length)) {
      out.push(null);
      continue;
    }
    if (unknown.length) placeUnknown(found.index);
    // SentencePiece marks word starts; WordPiece marks continuations. CJK characters are always their own word.
    const glued = found.index === cursor && cursor > 0 && !/\s/.test(text[cursor - 1]!);
    const continuation = wordPieceCont || (!spStart && glued && /^[\p{L}\p{N}]/u.test(piece) && !CJK.test(piece) && sentencePiece);
    out.push({ start: found.index, end: found.index + found.length, continuation });
    cursor = found.index + found.length;
  }
  if (unknown.length) placeUnknown(text.length);
  return out;
}

/** The masking type of a model label, or null for "outside any entity". */
export function labelType(label: string): string | null {
  const tag = label.trim().replace(/^[BIES]-/i, "").toUpperCase();
  return tag === "O" || tag === "" ? null : normaliseType(tag);
}

/** Counts of tokens seen and of tokens that could not be placed in the text (their labels are lost). */
export interface DecodeStats {
  tokens: number;
  unaligned: number;
}

/** Turns per-token logits (`seqLen` × `numLabels`) into entity spans in `text`. */
export function decodeSpans(
  text: string,
  tokens: readonly string[],
  logits: Float32Array,
  seqLen: number,
  numLabels: number,
  id2label: Readonly<Record<string, string>>,
  stats: DecodeStats = { tokens: 0, unaligned: 0 },
): Span[] {
  const offsets = alignTokens(text, tokens);
  for (const [i, tok] of tokens.entries()) {
    if (SPECIAL.test(tok)) continue;
    stats.tokens++;
    if (!offsets[i]) stats.unaligned++;
  }
  const spans: Span[] = [];
  let open: Span | null = null;
  for (let t = 0; t < seqLen; t++) {
    const off = offsets[t];
    if (!off) continue;
    let best = 0;
    let max = -Infinity;
    for (let k = 0; k < numLabels; k++) {
      const v = logits[t * numLabels + k]!;
      if (v > max) {
        max = v;
        best = k;
      }
    }
    let sum = 0;
    for (let k = 0; k < numLabels; k++) sum += Math.exp(logits[t * numLabels + k]! - max);
    const label = id2label[best] ?? `LABEL_${best}`;
    const type = labelType(label);
    const score = 1 / sum;
    if (off.continuation && open) {
      // A sub-word always belongs to the word it continues.
      open.end = off.end;
      continue;
    }
    if (!type) {
      open = null;
      continue;
    }
    if (open && open.type === type && !/^[BS]-/i.test(label)) {
      open.end = off.end;
      open.score = Math.min(open.score ?? 1, score);
    } else {
      open = { start: off.start, end: off.end, type, source: "ner", score };
      spans.push(open);
    }
  }
  // Grow each span to whole words, so a name is never half masked (not for CJK), and leave a
  // leading title visible ("M. Karim Benali" masks "Karim Benali"): it is not personal data.
  const wordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch) && !CJK.test(ch);
  for (const s of spans) {
    while (s.start > 0 && wordChar(text[s.start - 1])) s.start--;
    while (s.end < text.length && wordChar(text[s.end])) s.end++;
    if (s.type === "PERSON") {
      const title = TITLE.exec(text.slice(s.start, s.end));
      if (title && title[0].length < s.end - s.start) s.start += title[0].length;
    }
  }
  return spans;
}
