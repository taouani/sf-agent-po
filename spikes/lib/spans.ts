// Character spans shared by the PII and OCR spikes.

export interface Span {
  start: number; // inclusive, UTF-16 index
  end: number; // exclusive
  type: string;
  source: 'rule' | 'dictionary' | 'ner';
  score?: number;
}

/** Sort spans and merge any that overlap or touch, keeping the first type. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Share of non-space characters of [start, end) covered by the given spans. */
export function coverage(text: string, start: number, end: number, spans: Span[]): number {
  let total = 0;
  let covered = 0;
  for (let i = start; i < end; i++) {
    if (/\s/.test(text[i]!)) continue;
    total++;
    if (spans.some((s) => s.start <= i && i < s.end)) covered++;
  }
  return total === 0 ? 1 : covered / total;
}

/** Replace each span with a pseudonym like <PERSON_1>, numbering per type. */
export function maskText(text: string, spans: Span[]): string {
  const counters = new Map<string, number>();
  const seen = new Map<string, string>();
  let out = '';
  let cursor = 0;
  for (const s of mergeSpans(spans)) {
    const original = text.slice(s.start, s.end);
    const key = `${s.type}\u0000${original}`;
    let label = seen.get(key);
    if (!label) {
      const n = (counters.get(s.type) ?? 0) + 1;
      counters.set(s.type, n);
      label = `<${s.type}_${n}>`;
      seen.set(key, label);
    }
    out += text.slice(cursor, s.start) + label;
    cursor = s.end;
  }
  return out + text.slice(cursor);
}
