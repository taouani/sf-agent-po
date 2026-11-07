// Masking at the edges (AR1): every input is masked when it is added, so the store and
// everything the model sees hold pseudonyms; real values come back only on publish.

import type { ContextRepository, NewDocument, SourceDocument } from "../store/contexts.js";
import { detect, DOMAIN_ALLOWLIST, type EntityDetector } from "./detect.js";
import { compileDictionary, type CompiledDictionary, type DictionaryEntry } from "./dictionary.js";
import { NEVER_UNMASKED, SOURCE, type Vault } from "./vault.js";

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
  version: { generation: string; count: number; last: number };
  entries: DictionaryEntry[];
  base: CompiledDictionary;
  recent: DictionaryEntry[];
  recentCompiled?: CompiledDictionary;
}

const RECOMPILE_AFTER = 200;

/** Types the rules find wherever they appear: looking for known ones again only costs time. */
const FOUND_BY_RULES = new Set(["EMAIL", "PHONE", "IBAN", "CARD", "IP"]);

/**
 * Whether a known value is worth looking for in every later document, and how. Short or
 * digit-only values would match unrelated text ("1234", "Al"). A one-word value must match
 * its case, so a word the model once took for a name ("May") does not mask "may".
 */
function asDictionaryEntry(e: { type: string; value: string }, allowed: Set<string>): DictionaryEntry | undefined {
  if (FOUND_BY_RULES.has(e.type)) return undefined;
  const value = e.value.trim();
  if ([...value].length < 4 || !/\p{L}/u.test(value) || allowed.has(value.toLowerCase())) return undefined;
  const oneWord = !/\s/u.test(value);
  if (oneWord && e.type === "PERSON" && !/^\p{Lu}/u.test(value)) return undefined;
  return { type: e.type, value, caseSensitive: oneWord };
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
    this.allowed = new Set((opts.allowlist ?? DOMAIN_ALLOWLIST).map((a) => a.toLowerCase()));
  }

  /** The known values of a context, compiled; brought up to date with only what changed. */
  private knownValues(context: string): CompiledDictionary[] {
    const { vault } = this.opts;
    const version = vault.version(context);
    let cache = this.known.get(context);
    if (cache) {
      const v = cache.version;
      const unchanged = v.generation === version.generation && v.count === version.count && v.last === version.last;
      // Only rows added after the cached ones: take them in. Anything else (a delete, a new context): reload.
      const added = !unchanged && v.generation === version.generation && version.last > v.last ? vault.known(context, v.last) : undefined;
      if (added && version.count === v.count + vault.countAfter(context, v.last)) {
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
      cache = { version, entries, base: compileDictionary(entries), recent: [] };
      this.known.set(context, cache);
    }
    if (cache.recent.length > RECOMPILE_AFTER) {
      cache.entries.push(...cache.recent);
      cache.base = compileDictionary(cache.entries);
      cache.recent = [];
      cache.recentCompiled = undefined;
    }
    if (cache.recent.length && !cache.recentCompiled) cache.recentCompiled = compileDictionary(cache.recent);
    return cache.recentCompiled ? [cache.base, cache.recentCompiled] : [cache.base];
  }

  /**
   * Teaches the context values to mask from now on, for example the org's users, so that
   * documents mask them even without the model.
   */
  remember(context: string, entries: readonly DictionaryEntry[]): void {
    for (const e of entries) if (e.value.trim()) this.opts.vault.pseudonym(context, e.type, e.value.trim());
  }

  /** Masks `text` for `context`. `dictionary` adds values to mask in this call only. */
  async mask(context: string, text: string, dictionary: readonly DictionaryEntry[] = []): Promise<{ text: string; report: MaskReport }> {
    const report: MaskReport = { counts: {}, model: Boolean(this.opts.model) };
    return { text: await this.maskInto(context, text, dictionary, report), report };
  }

  private async maskInto(context: string, text: string, dictionary: readonly DictionaryEntry[], report: MaskReport): Promise<string> {
    if (!text.trim()) return text;
    const spans = await detect(text, { dictionary, compiled: this.knownValues(context), model: this.opts.model, allowlist: this.opts.allowlist });
    for (const s of spans) report.counts[s.type] = (report.counts[s.type] ?? 0) + 1;
    return this.opts.vault.mask(context, text, spans);
  }

  /**
   * Masks every string in a value, object keys included. A number is checked as text (a
   * phone or card number may be stored as one) and becomes a string only when masked.
   * Items are masked one after another, so pseudonyms are numbered the same way each time.
   */
  private async maskValue(context: string, value: unknown, dictionary: readonly DictionaryEntry[], report: MaskReport): Promise<unknown> {
    if (typeof value === "string") return this.maskInto(context, value, dictionary, report);
    if (typeof value === "number" || typeof value === "bigint") {
      const text = String(value);
      const masked = await this.maskInto(context, text, dictionary, report);
      return masked === text ? value : masked;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const v of value) out.push(await this.maskValue(context, v, dictionary, report));
      return out;
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[await this.maskInto(context, k, dictionary, report)] = await this.maskValue(context, v, dictionary, report);
      return out;
    }
    return value;
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
    const title = await this.maskInto(context, doc.title, dictionary, report);
    const content = await this.maskInto(context, doc.content, dictionary, report);
    const metadata = (await this.maskValue(context, doc.metadata ?? {}, dictionary, report)) as Record<string, unknown>;
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
  unmask(context: string, text: string, { keep = NEVER_UNMASKED }: { keep?: readonly string[] } = {}): { text: string; kept: string[] } {
    const kept = new Set<string>();
    const out = this.opts.vault.unmask(context, text, { keep, kept });
    return { text: out, kept: [...kept] };
  }
}
