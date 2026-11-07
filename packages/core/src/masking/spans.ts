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
 * Maps a label from a model or a dictionary to a masking type: "B-PER" and "PER" become
 * PERSON, "LOC" becomes LOCATION, and so on. An unknown label is kept in upper case, so
 * the policy masks it (fail closed).
 */
export function normaliseType(label: string): string {
  const tag = label.trim().replace(/^[BIES]-/i, "").toUpperCase();
  if ((MASKED_TYPES as readonly string[]).includes(tag)) return tag;
  if (/PER|NAME|SURNAME|USERNAME/.test(tag)) return "PERSON";
  if (/STREET|ADDRESS|BUILDING|ZIP|POSTCODE/.test(tag)) return "ADDRESS";
  if (/^(?:LOC|GPE|CITY|STATE|COUNTRY)/.test(tag)) return "LOCATION";
  if (/^(?:ORG|COMPANY)/.test(tag)) return "ORG";
  if (/MAIL/.test(tag)) return "EMAIL";
  if (/PHONE|TEL/.test(tag)) return "PHONE";
  if (/PASS|SECRET|KEY|TOKEN/.test(tag)) return "SECRET";
  if (/IBAN|ACCOUNT/.test(tag)) return "IBAN";
  if (/CARD|CREDIT/.test(tag)) return "CARD";
  if (/SSN|SOCIAL|TAX|PASSPORT|LICEN|NATIONAL/.test(tag)) return "NATIONAL_ID";
  return tag;
}

/** When spans overlap, the merged span takes the type of a secret if there is one, else of the longest span. */
const outranks = (a: Span, b: Span) =>
  (a.type === "SECRET") !== (b.type === "SECRET") ? a.type === "SECRET" : a.end - a.start > b.end - b.start;

/**
 * Sorts spans and merges those that overlap. Spans that only touch stay apart, so each
 * keeps its own type. A merged span takes the type of a secret among them, otherwise of
 * the longest one, so "<EMAIL>" is not renamed by a name found inside it.
 */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  let winner: Span | undefined;
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && winner && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      if (outranks(s, winner)) {
        winner = s;
        last.type = s.type;
        last.source = s.source;
        if (s.score === undefined) delete last.score;
        else last.score = s.score;
      }
    } else {
      out.push({ ...s });
      winner = s;
    }
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
    const start = Math.max(s.start, cursor);
    const end = Math.min(s.end, text.length);
    if (end <= start) continue;
    out += text.slice(cursor, start) + labelFor(s.type, text.slice(start, end));
    cursor = end;
  }
  return out + text.slice(cursor);
}
