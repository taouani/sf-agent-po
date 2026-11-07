/** What masking hides (decision MA1): personal data and secrets. Places and companies stay visible, except inside an address. */
export const MASKED_TYPES = ["PERSON", "EMAIL", "PHONE", "ADDRESS", "IBAN", "CARD", "NATIONAL_ID", "SECRET", "IP"] as const;
export type MaskedType = (typeof MASKED_TYPES)[number];

/** A stretch of text to mask, as UTF-16 offsets. */
export interface Span {
  /** Inclusive. */
  start: number;
  /** Exclusive. */
  end: number;
  type: string;
  /** Which layer found it. */
  source: "rule" | "dictionary" | "ner";
  /** The model's confidence, for spans from the model. */
  score?: number;
}

/**
 * Sorts spans and merges any that overlap or touch. The merged span keeps the type of
 * the one that starts first (the longer one on a tie), so "<EMAIL>" is not split by a
 * name found inside it.
 */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/**
 * Replaces each span with the label `labelFor` gives it. The spans are merged first.
 * `labelFor` sees the original text of the span, so the same value can get the same label.
 */
export function replaceSpans(text: string, spans: readonly Span[], labelFor: (type: string, original: string) => string): string {
  let out = "";
  let cursor = 0;
  for (const s of mergeSpans(spans)) {
    out += text.slice(cursor, s.start) + labelFor(s.type, text.slice(s.start, s.end));
    cursor = s.end;
  }
  return out + text.slice(cursor);
}
