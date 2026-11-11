// Masking at the edges (AR1): every input is masked when it is added, so the store and
// everything the model sees hold pseudonyms; real values come back only on publish.

import type { ContextRepository, NewDocument, SourceDocument } from "../store/contexts.js";
import { allowKey, detect, DOMAIN_ALLOWLIST, type EntityDetector } from "./detect.js";
import { detectWithRules } from "./rules.js";
import { blackOut, decodeImage, encodePng, orient, pageText, redactionBox, TRUSTED_FROM, UNCERTAIN_BELOW, worthChecking, type Box, type OcrResult, type RgbaImage, type TextRecognizer } from "./image.js";
import type { Span } from "./spans.js";
import { compileDictionary, type CompiledDictionary, type DictionaryEntry } from "./dictionary.js";
import { NEVER_UNMASKED, pseudonymLikeSpans, SOURCE, type Vault } from "./vault.js";

/** What masking a text or document did, for the user and the approval page. */
export interface MaskReport {
  /** Values masked, by type (each occurrence counts). */
  counts: Record<string, number>;
  /** Whether the detection model ran. Without it only rules and known values mask names. */
  model: boolean;
}

export interface MaskerOptions {
  vault: Vault;
  /**
   * The detection model. Without it, names are only found when the context already knows
   * them (or they are in `dictionary`), and each report says so.
   */
  model?: EntityDetector;
  /** Terms never masked; defaults to DOMAIN_ALLOWLIST. Also keeps them out of the known values. */
  allowlist?: readonly string[];
}

/** Known values compiled once; values learned since are kept apart until there are enough to recompile. */
interface KnownCache {
  version: { generation: string; count: number; last: number; declared: number };
  /** The values the user declared, compiled. */
  declared?: CompiledDictionary;
  entries: DictionaryEntry[];
  base: CompiledDictionary;
  recent: DictionaryEntry[];
  recentCompiled?: CompiledDictionary;
}

/** Never in what an agent writes: it keeps texts apart when they are masked together. */
const OUTPUT_MARK = "\u2063";
const OUTPUT_SEPARATOR = `\n\n${OUTPUT_MARK}\n\n`;

/** What to mask in a text an agent wrote, from what the detection found: never its pseudonyms. */
function outputSpans(text: string, found: readonly Span[]): Span[] {
  const labels = pseudonymLikeSpans(text);
  // A span that runs into a pseudonym ("[SECRET_1]hunter22", "[PERSON_1] Benali") is cut
  // around it, and the rest masked: dropping it whole would leave that rest in clear.
  const spans: Span[] = [];
  for (const s of found) {
    let start = s.start;
    for (const l of labels.filter((l) => s.start < l.end && l.start < s.end).sort((a, b) => a.start - b.start)) {
      if (l.start > start) spans.push({ ...s, start, end: l.start });
      start = Math.max(start, l.end);
    }
    if (start < s.end) spans.push({ ...s, start });
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i]!;
    const piece = text.slice(s.start, s.end);
    // Trim what is left around a cut ("] Benali" gives "Benali"); a piece with no letter or digit is not masked.
    const lead = piece.length - piece.replace(/^[\s\p{P}]+/u, "").length;
    const trail = piece.length - piece.replace(/[\s\p{P}]+$/u, "").length;
    if (s.type !== "SECRET") {
      s.start += lead;
      s.end -= trail;
    }
    if (s.end <= s.start || !/[\p{L}\p{N}]/u.test(text.slice(s.start, s.end))) spans.splice(i, 1);
  }
  return spans;
}

const RECOMPILE_AFTER = 200;

/** What masking an image gives: the redacted image for vision models, the masked text for the others. */
export interface MaskedImage {
  /** The image with personal data blacked out: upright, as PNG, with no metadata. */
  image: Buffer;
  width: number;
  height: number;
  /** The text the OCR read, masked. */
  text: string;
  report: MaskReport;
  ocr: {
    /** The OCR's confidence for the page, 0 to 100. */
    confidence: number;
    /**
     * False when the OCR read the page poorly (confidence under TRUSTED_FROM): text it did not
     * read may hold personal data, so the image must not reach a model before the user has
     * checked it.
     */
    trusted: boolean;
    /** Degrees the image was turned clockwise because its text read best that way; the returned image is turned too. */
    rotated: 0 | 90 | 180 | 270;
    words: number;
    /** The boxes blacked out. */
    redacted: Box[];
    /**
     * Words left visible that the OCR was unsure of: a misread name is still readable by a
     * vision model, so the approval page shows these for the user to check.
     */
    uncertain: Box[];
  };
}

/** Types the rules find wherever they appear: looking for known ones again only costs time. */
const FOUND_BY_RULES = new Set(["EMAIL", "PHONE", "IBAN", "CARD", "IP"]);

/**
 * Whether a known value is worth looking for in every later document, and how. Short or
 * digit-only values would match unrelated text ("1234", "Al"); CJK names are short by nature. A one-word value must match
 * its case, so a word the model once took for a name ("May") does not mask "may".
 */
function asDictionaryEntry(e: { type: string; value: string }, allowed: Set<string>): DictionaryEntry | undefined {
  const value = e.value.trim();
  if (FOUND_BY_RULES.has(e.type)) return undefined;
  // Chinese, Japanese and Korean names are two or three characters long. Only names, written
  // wholly in those scripts, may be that short: CJK values match inside words.
  const cjkName = e.type === "PERSON" && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\s・·]+$/u.test(value);
  const shortest = cjkName ? 2 : 4;
  if ([...value].length < shortest || !/\p{L}/u.test(value) || allowed.has(allowKey(value))) return undefined;
  const oneWord = !/\s/u.test(value);
  // A one-word name in lower case is more likely a word the model took for a name; scripts without case are exempt.
  const first = value[0]!;
  if (oneWord && e.type === "PERSON" && first.toLowerCase() !== first.toUpperCase() && !/^\p{Lu}/u.test(value)) return undefined;
  return { type: e.type, value, caseSensitive: oneWord };
}

/** Values the user names that are shorter than this are not taken: they would mask most words. */
export const DECLARED_MIN_LENGTH = 2;

/** A value the user named, to look for in any case (a secret exactly, as the vault keeps secrets). */
function declaredEntry(type: string, value: string): DictionaryEntry | undefined {
  if ([...value].length < DECLARED_MIN_LENGTH || !/[\p{L}\p{N}]/u.test(value)) return undefined;
  return { type, value, caseSensitive: type === "SECRET" };
}

/** Punctuation picked up around a value when it is copied ("Karim," or "(Karim)"); "+" may start a phone number. */
const EDGE = /^[\s.,;:!?¿¡()[\]{}<>"'«»“”‘’„*_~|/\\-]+|[\s.,;:!?¿¡()[\]{}<>"'«»“”‘’„*_~|/\\-]+$/gu;

/**
 * The parts of what the user typed to hide: copied text may hold a pseudonym ("[PERSON_1]
 * Benali"), which is already hidden, so the text around it is taken on its own.
 */
function declaredParts(raw: string): string[] {
  const parts: string[] = [];
  let at = 0;
  for (const s of [...pseudonymLikeSpans(raw), { start: raw.length, end: raw.length }]) {
    const part = raw.slice(at, s.start).replace(EDGE, "");
    if (part) parts.push(part);
    at = s.end;
  }
  return parts;
}

/**
 * The type of a value the user named: what a rule finds in the whole value (an email, a
 * phone number), else a name when it reads like one, else PRIVATE. The type only names the
 * pseudonym ("[PERSON_4]"); every type is masked.
 */
export function declaredType(value: string): string {
  const v = value.trim();
  const whole = detectWithRules(v).find((s) => s.start === 0 && s.end === v.length);
  if (whole) return whole.type;
  const words = v.split(/\s+/u);
  return words.length <= 4 && words.every((w) => /^\p{Lu}[\p{L}\p{M}'’.-]*$/u.test(w) || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}・·]+$/u.test(w))
    ? "PERSON"
    : "PRIVATE";
}

/**
 * Refuses OCR boxes that do not fit the image: the OCR then worked on other pixels (Tesseract
 * turns an image by any EXIF-like bytes it finds), and blacking out its boxes would miss.
 */
function checkBoxes(ocr: OcrResult, img: RgbaImage): void {
  for (const line of ocr.lines)
    for (const w of line) {
      const b = w.box;
      if (b.x0 < 0 || b.y0 < 0 || b.x1 > img.width + 1 || b.y1 > img.height + 1) throw new Error("The OCR's word positions do not fit the image, so it cannot be masked.");
    }
}

/**
 * Masks inputs with the context's vault and puts real values back on publish. Values a
 * context already has pseudonyms for are masked in every later document, even where the
 * rules and the model miss them, so a name found once stays masked.
 */
export class Masker {
  private readonly known = new Map<string, KnownCache>();
  private readonly allowed: Set<string>;

  constructor(private readonly opts: MaskerOptions) {
    this.allowed = new Set((opts.allowlist ?? DOMAIN_ALLOWLIST).map(allowKey));
  }

  /** The known values of a context, compiled; brought up to date with only what changed. */
  private knownValues(context: string): CompiledDictionary[] {
    const { vault } = this.opts;
    const version = vault.version(context);
    let cache = this.known.get(context);
    if (cache) {
      const v = cache.version;
      const unchanged = v.generation === version.generation && v.count === version.count && v.last === version.last && v.declared === version.declared;
      // Only rows added after the cached ones: take them in. Anything else (a delete, a new context): reload.
      const added = !unchanged && v.generation === version.generation && version.last > v.last ? vault.known(context, v.last) : undefined;
      // A value declared (rare: the user named it) reloads everything.
      if (added && version.count === v.count + vault.countAfter(context, v.last) && version.declared === v.declared) {
        const fresh = added.flatMap((e) => asDictionaryEntry(e, this.allowed) ?? []);
        cache.version = version;
        if (fresh.length) {
          cache.recent.push(...fresh);
          cache.recentCompiled = undefined;
        }
      } else if (!unchanged) cache = undefined;
    }
    if (!cache) {
      const entries = vault.known(context).flatMap((e) => asDictionaryEntry(e, this.allowed) ?? []);
      const declared = vault.declared(context).flatMap((e) => declaredEntry(e.type, e.value) ?? []);
      cache = { version, entries, base: compileDictionary(entries), recent: [], declared: declared.length ? compileDictionary(declared) : undefined };
      this.known.set(context, cache);
    }
    if (cache.recent.length > RECOMPILE_AFTER) {
      cache.entries.push(...cache.recent);
      cache.base = compileDictionary(cache.entries);
      cache.recent = [];
      cache.recentCompiled = undefined;
    }
    if (cache.recent.length && !cache.recentCompiled) cache.recentCompiled = compileDictionary(cache.recent);
    return [cache.base, ...(cache.recentCompiled ? [cache.recentCompiled] : []), ...(cache.declared ? [cache.declared] : [])];
  }

  /**
   * Teaches the context values to mask from now on, for example the org's users, so that
   * documents mask them even without the model.
   */
  remember(context: string, entries: readonly DictionaryEntry[]): void {
    for (const e of entries) if (e.value.trim()) this.opts.vault.pseudonym(context, e.type, e.value.trim());
  }

  /**
   * Hides values the user said are still in clear (the approval page's `missed`), in this
   * context from now on, as they wrote them, whatever their length or case. Punctuation
   * around a value is dropped, and a pseudonym inside one splits it. Returns the entries, to
   * pass as the `dictionary` of the next masking of the same input, and how many values or
   * parts were not taken (one character, or no letter or digit); those are not returned, since
   * they are what the user wants hidden.
   */
  declare(context: string, values: readonly string[]): { entries: DictionaryEntry[]; ignored: number } {
    const entries: DictionaryEntry[] = [];
    let ignored = 0;
    for (const value of values.flatMap(declaredParts)) {
      const entry = declaredEntry(declaredType(value), value);
      if (!entry) {
        ignored++;
        continue;
      }
      const label = this.opts.vault.declare(context, entry.type, entry.value);
      const type = label.slice(1, label.lastIndexOf("_"));
      entries.push({ ...entry, type, caseSensitive: type === "SECRET" });
    }
    return { entries, ignored };
  }

  /** Masks `text` for `context`. `dictionary` adds values to mask in this call only. */
  async mask(context: string, text: string, dictionary: readonly DictionaryEntry[] = []): Promise<{ text: string; report: MaskReport }> {
    const report: MaskReport = { counts: {}, model: Boolean(this.opts.model) };
    return { text: await this.maskInto(context, text, dictionary, report), report };
  }

  /** What to mask in `text`, counted into `report`. */
  private async spansFor(context: string, text: string, dictionary: readonly DictionaryEntry[], report: MaskReport): Promise<Span[]> {
    if (!text.trim()) return [];
    const spans = await detect(text, { dictionary, compiled: this.knownValues(context), model: this.opts.model, allowlist: this.opts.allowlist });
    for (const s of spans) report.counts[s.type] = (report.counts[s.type] ?? 0) + 1;
    return spans;
  }

  private async maskInto(context: string, text: string, dictionary: readonly DictionaryEntry[], report: MaskReport): Promise<string> {
    if (!text.trim()) return text;
    // Called even with no spans: the vault also hides text that looks like a pseudonym.
    return this.opts.vault.mask(context, text, await this.spansFor(context, text, dictionary, report));
  }

  /**
   * Masks what the agents wrote (a design, a backlog) before it is stored: personal data
   * they wrote in clear is masked like any input, and the pseudonyms they used are kept as
   * they are, so publishing puts their real values back. (An input's pseudonym-like text, by
   * contrast, is masked as a literal: there it is text someone wrote.)
   */
  async maskOutput(context: string, text: string): Promise<{ text: string; report: MaskReport }> {
    const out = await this.maskOutputs(context, [text]);
    return { text: out.texts[0]!, report: out.report };
  }

  /**
   * Masks several texts an agent wrote, such as the fields of a backlog, as maskOutput does,
   * with one run of the detection: the texts are joined, and only a text where something
   * found runs past its end is looked at again on its own.
   */
  async maskOutputs(context: string, texts: readonly string[]): Promise<{ texts: string[]; report: MaskReport }> {
    const report: MaskReport = { counts: {}, model: Boolean(this.opts.model) };
    const scratch: MaskReport = { counts: {}, model: report.model };
    const found: Span[][] = texts.map(() => []);
    if (texts.length > 1 && !texts.some((t) => t.includes(OUTPUT_MARK))) {
      const starts: number[] = [];
      let at = 0;
      for (const t of texts) {
        starts.push(at);
        at += t.length + OUTPUT_SEPARATOR.length;
      }
      const redo = new Set<number>();
      for (const s of await this.spansFor(context, texts.join(OUTPUT_SEPARATOR), [], scratch)) {
        let i = 0;
        while (i + 1 < texts.length && starts[i + 1]! <= s.start) i++;
        const end = starts[i]! + texts[i]!.length;
        if (s.end <= end) found[i]!.push({ ...s, start: s.start - starts[i]!, end: s.end - starts[i]! });
        else texts.forEach((t, j) => s.start < starts[j]! + t.length && starts[j]! < s.end && redo.add(j));
      }
      for (const i of redo) found[i] = await this.spansFor(context, texts[i]!, [], scratch);
    } else {
      for (const [i, t] of texts.entries()) found[i] = await this.spansFor(context, t, [], scratch);
    }
    const out = texts.map((text, i) => {
      if (!text.trim()) return text;
      const spans = outputSpans(text, found[i]!);
      for (const s of spans) report.counts[s.type] = (report.counts[s.type] ?? 0) + 1;
      return this.opts.vault.mask(context, text, spans, { literals: false });
    });
    return { texts: out, report };
  }

  /**
   * Masks an image (PNG or JPEG): the OCR reads its text, the same detection as for
   * documents finds what to hide, and every word that holds some of it is blacked out, as is
   * text that looks like a pseudonym (a model could copy it, and publishing would turn it
   * into a real name). The result is opaque and re-encoded as PNG, so EXIF data (a name, a
   * place) is dropped. A page the OCR reads poorly is tried turned a quarter, a half and
   * three quarters, and the best reading kept; if none reads well, the result is not
   * `trusted`. `redactUncertain` also blacks out words the OCR was unsure of.
   */
  async maskImage(
    context: string,
    raw: Uint8Array,
    recognizer: TextRecognizer,
    { dictionary = [], redactUncertain = false }: { dictionary?: readonly DictionaryEntry[]; redactUncertain?: boolean } = {},
  ): Promise<MaskedImage> {
    const upright = decodeImage(raw);
    // The OCR gets exactly the pixels that are blacked out and returned, so its boxes match them.
    const read = async (img: RgbaImage, rotated: 0 | 90 | 180 | 270) => {
      const png = encodePng(img);
      const ocr = await recognizer.recognize(png);
      checkBoxes(ocr, img);
      return { img, png, ocr, rotated };
    };
    let best = await read(upright, 0);
    if (best.ocr.confidence < TRUSTED_FROM) {
      for (const [orientation, rotated] of [[6, 90], [3, 180], [8, 270]] as const) {
        const tried = await read(orient(upright, orientation), rotated);
        if (tried.ocr.confidence > best.ocr.confidence) best = tried;
      }
    }
    const { img, png, ocr, rotated } = best;
    const { text, words } = pageText(ocr.lines);
    const report: MaskReport = { counts: {}, model: Boolean(this.opts.model) };
    const spans = await this.spansFor(context, text, dictionary, report);
    const hide = [...spans, ...pseudonymLikeSpans(text)];
    const hidden = (w: { start: number; end: number }) => hide.some((s) => s.start < w.end && w.start < s.end);
    const redacted = words.filter(hidden).map(redactionBox);
    const uncertain = words.filter((w) => !hidden(w) && w.confidence < UNCERTAIN_BELOW && worthChecking(w.text)).map(redactionBox);
    const boxes = redactUncertain ? [...redacted, ...uncertain] : redacted;
    return {
      image: boxes.length ? encodePng(blackOut(img, boxes)) : png,
      width: img.width,
      height: img.height,
      text: (text.trim() ? this.opts.vault.mask(context, text, spans) : "").trimEnd(),
      report,
      ocr: {
        confidence: ocr.confidence,
        trusted: ocr.confidence >= TRUSTED_FROM,
        rotated,
        words: words.length,
        redacted,
        uncertain: redactUncertain ? [] : uncertain,
      },
    };
  }

  /**
   * Masks every string in a value, object keys included. A number is checked as text (a
   * phone or card number may be stored as one) and becomes a string only when masked.
   * Items are masked one after another, so pseudonyms are numbered the same way each time.
   */
  /**
   * Masks every string in a value (keys and values; numbers as text). The detection runs on
   * all of them at once, so the model takes the short ones together; pseudonyms are then given
   * in the order the strings come, as one at a time would.
   */
  private async maskValue(context: string, value: unknown, dictionary: readonly DictionaryEntry[], report: MaskReport, extra: readonly string[] = []): Promise<{ value: unknown; extra: string[] }> {
    const strings: string[] = [...extra];
    const collect = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (typeof v === "number" || typeof v === "bigint") strings.push(String(v));
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          strings.push(k);
          collect(x);
        }
    };
    collect(value);
    const spans = await Promise.all(strings.map((t) => this.spansFor(context, t, dictionary, report)));
    let i = 0;
    // Called even with no spans: the vault also hides text that looks like a pseudonym.
    const next = () => {
      const t = strings[i]!;
      const found = spans[i++]!;
      return t.trim() ? this.opts.vault.mask(context, t, found) : t;
    };
    const masked = extra.map(() => next());
    const build = (v: unknown): unknown => {
      if (typeof v === "string") return next();
      if (typeof v === "number" || typeof v === "bigint") {
        const out = next();
        return out === String(v) ? v : out;
      }
      if (Array.isArray(v)) return v.map(build);
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [, x] of Object.entries(v)) {
          const k = next();
          out[k] = build(x);
        }
        return out;
      }
      return v;
    };
    return { value: build(value), extra: masked };
  }

  /** The pseudonym that stands for a document's source in the store, such as "[SOURCE_3]". */
  maskSource(context: string, source: string): string {
    return this.opts.vault.pseudonym(context, SOURCE, source);
  }

  /** The real source behind a stored document's source, to fetch it again. */
  realSource(context: string, maskedSource: string): string | undefined {
    return this.opts.vault.reveal(context, maskedSource);
  }

  /**
   * Masks a document's title, content and metadata (keys and values), and replaces its
   * source with a pseudonym: a file name or URL may hold a name, and the same source always
   * gets the same pseudonym, so re-adding a source still replaces its document. What was
   * masked is recorded in `metadata.masking`.
   */
  async maskDocument(context: string, doc: NewDocument, dictionary: readonly DictionaryEntry[] = []): Promise<NewDocument & { masked: true }> {
    if (doc.masked) throw new Error(`The document ${this.maskSource(context, doc.source)} is already masked.`);
    const report: MaskReport = { counts: {}, model: Boolean(this.opts.model) };
    // The title, the content and every metadata string in one go, masked in that order.
    const out = await this.maskValue(context, doc.metadata ?? {}, dictionary, report, [doc.title, doc.content]);
    const [title, content] = out.extra as [string, string];
    const metadata = out.value as Record<string, unknown>;
    return { ...doc, source: this.maskSource(context, doc.source), title, content, metadata: { ...metadata, masking: report }, masked: true };
  }

  /** Masks documents and adds them to the context. */
  async addDocuments(contexts: ContextRepository, context: string, docs: readonly NewDocument[], dictionary: readonly DictionaryEntry[] = []): Promise<SourceDocument[]> {
    const masked: NewDocument[] = [];
    for (const d of docs) masked.push(await this.maskDocument(context, d, dictionary));
    return contexts.addDocuments(context, masked);
  }

  /**
   * Masks the documents of a context that are not masked yet, such as those imported from
   * 0.x. Each one is replaced on its own, so an interrupted run can simply be started again;
   * one that changed or was removed meanwhile is left for the next run (`changed`).
   */
  async maskContext(contexts: ContextRepository, context: string, dictionary: readonly DictionaryEntry[] = []): Promise<{ masked: number; changed: number; report: MaskReport }> {
    const total: MaskReport = { counts: {}, model: Boolean(this.opts.model) };
    let masked = 0;
    let changed = 0;
    for (const doc of contexts.documents(context)) {
      if (doc.masked) continue;
      const next = await this.maskDocument(context, { kind: doc.kind, title: doc.title, source: doc.source, content: doc.content, metadata: doc.metadata }, dictionary);
      if (!contexts.replaceIfUnchanged(context, doc, next)) {
        changed++;
        continue;
      }
      for (const [t, c] of Object.entries((next.metadata!.masking as MaskReport).counts)) total.counts[t] = (total.counts[t] ?? 0) + c;
      masked++;
    }
    return { masked, changed, report: total };
  }

  /**
   * Puts the real values back into approved output, for the final write to Jira, Confluence
   * or a file. Secrets stay masked by default; `kept` lists the pseudonyms left in the text
   * (kept types, or labels this context does not know) so the approval page can show them.
   */
  unmask(
    context: string,
    text: string,
    { keep = NEVER_UNMASKED, escape }: { keep?: readonly string[]; escape?: (value: string) => string } = {},
  ): { text: string; kept: string[]; revealed: { type: string; value: string }[] } {
    const kept = new Set<string>();
    const revealed = new Map<string, { type: string; value: string }>();
    const out = this.opts.vault.unmask(context, text, { keep, kept, escape, revealed });
    return { text: out, kept: [...kept], revealed: [...revealed.values()] };
  }
}
