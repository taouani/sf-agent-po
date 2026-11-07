// Turning a token-classification model's output into entity spans, whatever runtime ran it.
// It imports no runtime, so the WebAssembly loader does not pull in the native one.

import type { Span } from '../lib/spans.ts';

export interface TokenOffset {
  start: number;
  end: number;
  continuation: boolean; // a sub-word piece that continues the previous word
}

const SPECIAL = /^(\[CLS\]|\[SEP\]|\[PAD\]|\[MASK\]|<s>|<\/s>|<pad>|<mask>)$/;
const UNKNOWN = /^(\[UNK\]|<unk>)$/;

/** Map WordPiece / SentencePiece / byte-level tokens back to character offsets in `text`. */
export function alignTokens(text: string, tokens: string[]): (TokenOffset | null)[] {
  const lower = text.toLowerCase();
  const out: (TokenOffset | null)[] = [];
  let cursor = 0;
  for (const tok of tokens) {
    if (SPECIAL.test(tok) || UNKNOWN.test(tok)) {
      out.push(null);
      continue;
    }
    const wordPieceCont = tok.startsWith('##');
    const spStart = tok.startsWith('▁') || tok.startsWith('Ġ');
    const piece = tok.replace(/^##/, '').replace(/^[▁Ġ]/, '');
    if (piece === '') {
      out.push(null);
      continue;
    }
    let idx = text.indexOf(piece, cursor);
    if (idx < 0) idx = lower.indexOf(piece.toLowerCase(), cursor);
    if (idx < 0 || idx - cursor > 64) {
      out.push(null);
      continue;
    }
    // Sentencepiece marks word starts; WordPiece marks continuations. CJK characters are always their own word.
    const glued = idx === cursor && cursor > 0 && !/\s/.test(text[cursor - 1]!);
    const continuation = wordPieceCont || (!spStart && glued && /^[\p{L}\p{N}]/u.test(piece) && !/[㐀-鿿]/u.test(piece) && tokens.some((t) => t.startsWith('▁')));
    out.push({ start: idx, end: idx + piece.length, continuation });
    cursor = idx + piece.length;
  }
  return out;
}

/** Normalise model labels (CoNLL-style or PII-style) to the spike's entity types. */
export function mapLabel(label: string): string | null {
  const tag = label.replace(/^[BIES]-/, '').toUpperCase();
  if (tag === 'O' || tag === '') return null;
  if (/PER|NAME|SURNAME|USERNAME/.test(tag)) return 'PERSON';
  if (/STREET|ADDRESS|BUILDING|ZIP|POSTCODE/.test(tag)) return 'ADDRESS';
  if (/LOC|CITY|GPE|STATE|COUNTRY/.test(tag)) return 'LOCATION';
  if (/ORG|COMPANY/.test(tag)) return 'ORG';
  if (/MAIL/.test(tag)) return 'EMAIL';
  if (/PHONE|TEL/.test(tag)) return 'PHONE';
  if (/PASS|SECRET|KEY/.test(tag)) return 'SECRET';
  if (/IBAN|ACCOUNT/.test(tag)) return 'IBAN';
  if (/CARD|CREDIT/.test(tag)) return 'CARD';
  if (/SSN|ID|SOCIAL|TAX|PASSPORT|LICEN/.test(tag)) return 'NATIONAL_ID';
  if (/MISC|DATE|TIME/.test(tag)) return null;
  return tag;
}

export interface NerModel {
  id: string;
  dtype: string;
  labels: string[];
  /** Tokens seen, and those that could not be mapped back to the text (their labels are lost). */
  stats: { tokens: number; unaligned: number };
  detect(text: string): Promise<Span[]>;
}

/** Turns per-token logits into entity spans in `text`. Shared by every runtime, so they can only differ in the logits. */
export function decodeSpans(
  text: string,
  tokens: string[],
  data: Float32Array,
  seqLen: number,
  numLabels: number,
  id2label: Record<string, string>,
  stats: { tokens: number; unaligned: number },
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
    let sum = 0;
    for (let k = 0; k < numLabels; k++) {
      const v = data[t * numLabels + k]!;
      if (v > max) {
        max = v;
        best = k;
      }
    }
    for (let k = 0; k < numLabels; k++) sum += Math.exp(data[t * numLabels + k]! - max);
    const label = id2label[best] ?? `LABEL_${best}`;
    const type = mapLabel(label);
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
    const begins = /^[BS]-/.test(label);
    if (open && open.type === type && !begins) {
      open.end = off.end;
      open.score = Math.min(open.score ?? 1, score);
    } else {
      open = { start: off.start, end: off.end, type, source: 'ner', score };
      spans.push(open);
    }
  }
  // Grow each span to whole words so a name is never half masked (not for CJK).
  for (const s of spans) {
    while (s.start > 0 && /[\p{L}\p{N}]/u.test(text[s.start - 1]!) && !/[㐀-鿿]/u.test(text[s.start - 1]!)) s.start--;
    while (s.end < text.length && /[\p{L}\p{N}]/u.test(text[s.end]!) && !/[㐀-鿿]/u.test(text[s.end]!)) s.end++;
  }
  return spans;
}
