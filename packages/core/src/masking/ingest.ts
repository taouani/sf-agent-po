// Masking at the edges (AR1): every input is masked when it is added, so the store and
// everything the model sees hold pseudonyms; real values come back only on publish.

import type { ContextRepository, NewDocument, SourceDocument } from "../store/contexts.js";
import { detect, DOMAIN_ALLOWLIST, type EntityDetector } from "./detect.js";
import type { DictionaryEntry } from "./dictionary.js";
import { NEVER_UNMASKED, pseudonymsIn, type Vault } from "./vault.js";

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

/** Metadata keys that are never masked: they name fields, not people (ids, dates, URLs of the tool). */
const PLAIN_KEYS = new Set(["masking", "version", "kind", "format", "mimeType", "createdAt", "updatedAt", "publishedAt", "status", "type"]);

/**
 * Masks inputs with the context's vault and puts real values back on publish. Values a
 * context already has pseudonyms for are masked in every later document, even where the
 * rules and the model miss them, so a name found once stays masked.
 */
export class Masker {
  private readonly known = new Map<string, { size: number; entries: DictionaryEntry[] }>();
  private readonly allowed: Set<string>;

  constructor(private readonly opts: MaskerOptions) {
    this.allowed = new Set((opts.allowlist ?? DOMAIN_ALLOWLIST).map((a) => a.toLowerCase()));
  }

  /** The values the context already masks, read from the vault once per change. */
  private knownValues(context: string): DictionaryEntry[] {
    const size = this.opts.vault.size(context);
    const cached = this.known.get(context);
    if (cached && cached.size === size) return cached.entries;
    const entries = this.opts.vault.known(context).filter((e) => !this.allowed.has(e.value.trim().toLowerCase()));
    this.known.set(context, { size, entries });
    return entries;
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
    if (!text) return text;
    const spans = await detect(text, {
      dictionary: [...this.knownValues(context), ...dictionary],
      model: this.opts.model,
      allowlist: this.opts.allowlist,
    });
    for (const s of spans) report.counts[s.type] = (report.counts[s.type] ?? 0) + 1;
    return this.opts.vault.mask(context, text, spans);
  }

  private async maskValue(context: string, value: unknown, dictionary: readonly DictionaryEntry[], report: MaskReport, key?: string): Promise<unknown> {
    if (key !== undefined && PLAIN_KEYS.has(key)) return value;
    if (typeof value === "string") return this.maskInto(context, value, dictionary, report);
    if (Array.isArray(value)) return Promise.all(value.map((v) => this.maskValue(context, v, dictionary, report)));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = await this.maskValue(context, v, dictionary, report, k);
      return out;
    }
    return value;
  }

  /**
   * Masks a document's title, content and metadata, and records what was masked in
   * `metadata.masking`. The source stays as it is: it is how the document is fetched again,
   * and it never goes to the model unmasked (tools show the title).
   */
  async maskDocument(context: string, doc: NewDocument, dictionary: readonly DictionaryEntry[] = []): Promise<NewDocument & { masked: true }> {
    if (doc.masked) throw new Error(`The document from ${doc.source} is already masked.`);
    const report: MaskReport = { counts: {}, model: Boolean(this.opts.model) };
    const title = await this.maskInto(context, doc.title, dictionary, report);
    const content = await this.maskInto(context, doc.content, dictionary, report);
    const metadata = (await this.maskValue(context, doc.metadata ?? {}, dictionary, report)) as Record<string, unknown>;
    return { ...doc, title, content, metadata: { ...metadata, masking: report }, masked: true };
  }

  /** Masks documents and adds them to the context. */
  async addDocuments(contexts: ContextRepository, context: string, docs: readonly NewDocument[], dictionary: readonly DictionaryEntry[] = []): Promise<SourceDocument[]> {
    const masked: NewDocument[] = [];
    for (const d of docs) masked.push(await this.maskDocument(context, d, dictionary));
    return contexts.addDocuments(context, masked);
  }

  /**
   * Masks the documents of a context that are not masked yet, such as those imported from
   * 0.x. Each one is replaced on its own, so an interrupted run can simply be started again.
   */
  async maskContext(contexts: ContextRepository, context: string, dictionary: readonly DictionaryEntry[] = []): Promise<{ masked: number; changed: number; report: MaskReport }> {
    const total: MaskReport = { counts: {}, model: Boolean(this.opts.model) };
    let masked = 0;
    let changed = 0;
    for (const doc of contexts.documents(context)) {
      if (doc.masked) continue;
      const next = await this.maskDocument(context, { kind: doc.kind, title: doc.title, source: doc.source, content: doc.content, metadata: doc.metadata }, dictionary);
      // A document changed or removed while it was being masked is left for the next run.
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
   * or a file. Secrets stay masked by default; `kept` lists the pseudonyms still in the
   * text (secrets, or labels this context does not know) so the approval page can show them.
   */
  unmask(context: string, text: string, { keep = NEVER_UNMASKED }: { keep?: readonly string[] } = {}): { text: string; kept: string[] } {
    const out = this.opts.vault.unmask(context, text, { keep });
    // Judged on the input: a literal such as "[PERSON_1]" written in a source comes back as text, not as a pseudonym.
    const kept = pseudonymsIn(text).filter((label) => this.opts.vault.unmask(context, label, { keep }) === label);
    return { text: out, kept };
  }
}
