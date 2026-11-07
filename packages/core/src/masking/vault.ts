import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { validateContextName } from "../store/contexts.js";
import type { Database } from "../store/db.js";
import { normaliseType, replaceSpans, type Span } from "./spans.js";

/** The vault key's length: 32 random bytes, kept in the OS keychain. */
export const VAULT_KEY_BYTES = 32;

/** A new random vault key. */
export function newVaultKey(): Buffer {
  return randomBytes(VAULT_KEY_BYTES);
}

/**
 * The key check stored in a vault: a keyed hash that shows whether a key is the vault's
 * without revealing it. Its start names the key in the keychain (see vaultKeyId).
 */
export function vaultKeyCheck(key: Buffer): Buffer {
  const checkKey = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "sf-agent-po vault check", 32));
  return createHmac("sha256", checkKey).update("sf-agent-po vault key check").digest();
}

/** The key in the keychain is not the one this workspace's vault was written with (or it was lost and replaced). */
export class VaultKeyError extends Error {
  constructor(file: string) {
    super(
      `The masking key in your OS keychain does not open the vault of ${file}. ` +
        `It was probably replaced or lost. Restore it from your key backup; until then the documents keep their pseudonyms ` +
        `and nothing can be unmasked.`,
    );
    this.name = "VaultKeyError";
  }
}

/** Types whose real value is never written back on publish: a credential must not land in Jira or Confluence. */
export const NEVER_UNMASKED: readonly string[] = ["SECRET"];

/** The type of a document's source (a file path, URL or issue key): kept exact, and not personal data to look for elsewhere. */
export const SOURCE = "SOURCE";

/** The type of label-like text found in a source document ("[PERSON_1]" written by someone), masked so it comes back as written. */
const LITERAL = "LITERAL";

/**
 * How a value is compared. Values that only differ in format share a pseudonym
 * ("06 12 34 56 78" and "0612345678"); unmasking writes back the first spelling seen.
 * Names only merge when they differ by case, spacing or apostrophe style, so a handle
 * such as "sarah.whitfield" keeps its own pseudonym and comes back exactly.
 */
function normalise(type: string, value: string): string {
  const v = value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u02bc`´]/gu, "'")
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .trim()
    .replace(/\s+/gu, " ");
  switch (type) {
    case "PHONE":
    case "IBAN":
    case "CARD":
    case "NATIONAL_ID":
      return v.replace(/[^\p{L}\p{N}+]/gu, "").toUpperCase();
    case "SECRET":
    case LITERAL:
    case SOURCE:
      return value; // exact: two secrets that differ by case are different secrets
    default:
      return v.toLowerCase();
  }
}

/**
 * A pseudonym's type part, from the masking type: upper-case ASCII letters, digits and
 * underscores, starting with a letter, so every label can be found again in text.
 */
export function pseudonymType(type: string): string {
  const t = normaliseType(type)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");
  return /^[A-Z]/.test(t) ? t : `T_${t}`;
}

/** "[PERSON_3]" */
export const pseudonymLabel = (type: string, n: number) => `[${pseudonymType(type)}_${n}]`;

// A pseudonym as it may come back from a model: "[PERSON_3]", "<PERSON_3>", "&lt;PERSON_3&gt;",
// or Markdown-escaped "\[PERSON\_3\]". Delimiters must come in pairs, and numbers have no
// leading zero. A bare PERSON_3 is not a pseudonym: it may be text someone wrote.
const CORE = String.raw`([A-Z][A-Z0-9_\\]*?)\\?_([1-9][0-9]*)`;
const LABEL_IN_TEXT = new RegExp(String.raw`\\?\[${CORE}\\?\]|<${CORE}>|&lt;${CORE}&gt;`, "g");
const LABEL_EXACT = /^\[?([A-Z][A-Z0-9_]*?)_([1-9][0-9]*)\]?$/;

/** The pseudonyms written in `text`, in any form unmask accepts, as "[TYPE_n]", each once. */
/** Where `text` holds something that looks like a pseudonym ("[PERSON_1]"), as offsets. */
export function pseudonymLikeSpans(text: string): { start: number; end: number }[] {
  return [...text.matchAll(LABEL_IN_TEXT)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

export function pseudonymsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(LABEL_IN_TEXT)) {
    const type = (m[1] ?? m[3] ?? m[5])!.replace(/\\/g, "");
    found.add(`[${type}_${m[2] ?? m[4] ?? m[6]}]`);
  }
  return [...found];
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The pseudonym vault (AR1): masks values with stable, per-context pseudonyms and keeps
 * the originals encrypted, so real values come back only when output is published.
 * All methods are synchronous; masking runs in one transaction.
 */
export class Vault {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;
  private readonly sql;

  /** Opens the vault of `database` with `key`; throws VaultKeyError when the key is not the vault's. */
  constructor(
    private readonly database: Database,
    key: Buffer,
  ) {
    if (key.length !== VAULT_KEY_BYTES) throw new Error(`A vault key has ${VAULT_KEY_BYTES} bytes, not ${key.length}.`);
    const derive = (info: string) => Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `sf-agent-po vault ${info}`, 32));
    this.encKey = derive("encryption");
    this.macKey = derive("lookup");
    const db = database.db;
    // Prepared once: masking a long document holds the write lock for as short a time as possible.
    this.sql = {
      find: db.prepare("SELECT type, n, original FROM pseudonym WHERE context = ? AND lookup = ?"),
      next: db.prepare("SELECT coalesce(max(n), 0) + 1 AS n FROM pseudonym WHERE context = ? AND type = ?"),
      insert: db.prepare("INSERT INTO pseudonym (context, type, n, lookup, original, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
      ensureContext: db.prepare("INSERT OR IGNORE INTO context (name, created_at, updated_at) VALUES (?, ?, ?)"),
      get: db.prepare("SELECT lookup, original FROM pseudonym WHERE context = ? AND type = ? AND n = ?"),
      counts: db.prepare("SELECT type, count(*) AS c FROM pseudonym WHERE context = ? GROUP BY type"),
      all: db.prepare(
        `SELECT type, n, lookup, original FROM pseudonym WHERE context = ? AND rowid > ? AND type NOT IN ('${LITERAL}', '${SOURCE}', 'SECRET') ORDER BY rowid`,
      ),
      after: db.prepare("SELECT count(*) AS c FROM pseudonym WHERE context = ? AND rowid > ?"),
      version: db.prepare(
        `SELECT c.vault_generation AS generation, count(p.rowid) AS count, coalesce(max(p.rowid), 0) AS last
         FROM context c LEFT JOIN pseudonym p ON p.context = c.name WHERE c.name = ? GROUP BY c.name`,
      ),
      generation: db.prepare("UPDATE context SET vault_generation = ? WHERE name = ? AND vault_generation IS NULL"),
    };
    const check = vaultKeyCheck(key);
    database.write(() => {
      const row = db.prepare("SELECT key_check FROM vault WHERE id = 1").get() as { key_check: Uint8Array } | undefined;
      if (!row) {
        // A vault with pseudonyms but no key check was damaged or restored partly: trusting a new key would give duplicates.
        if (db.prepare("SELECT 1 FROM pseudonym LIMIT 1").get()) throw new VaultKeyError(database.file);
        db.prepare("INSERT INTO vault (id, key_check, created_at) VALUES (1, ?, ?)").run(check, new Date().toISOString());
      } else if (row.key_check.length !== check.length || !timingSafeEqual(Buffer.from(row.key_check), check)) throw new VaultKeyError(database.file);
    });
  }

  private lookup(context: string, type: string, value: string): Buffer {
    return createHmac("sha256", this.macKey).update(`${context}\0${type}\0${normalise(type, value)}`).digest();
  }

  /** The authenticated data of an original: its context, label and lookup, so no part of a row can be moved or swapped. */
  private aad(context: string, label: string, lookup: Uint8Array): Buffer {
    return Buffer.concat([Buffer.from(`${context}\0${label}\0`), lookup]);
  }

  private encrypt(aad: Buffer, value: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encKey, iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  private decrypt(aad: Buffer, blob: Uint8Array): string {
    const b = Buffer.from(blob);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.encKey, b.subarray(0, 12));
      decipher.setAAD(aad);
      decipher.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      throw new Error(`A pseudonym in the vault of ${this.database.file} was changed outside sf-agent-po and cannot be trusted.`);
    }
  }

  /** The pseudonym of `value` in `context`, created on first use. The same value always gets the same one. */
  pseudonym(context: string, type: string, value: string): string {
    return this.database.write(() => this.pseudonymIn(context, type, value));
  }

  private pseudonymIn(context: string, type: string, value: string): string {
    const t = pseudonymType(type);
    const lookup = this.lookup(context, t, value);
    const found = this.sql.find.get(context, lookup) as { type: string; n: number; original: Uint8Array } | undefined;
    if (found) {
      const label = pseudonymLabel(found.type, found.n);
      this.decrypt(this.aad(context, label, lookup), found.original); // a swapped lookup fails here
      return label;
    }
    const now = new Date().toISOString();
    validateContextName(context);
    this.sql.ensureContext.run(context, now, now);
    const { n } = this.sql.next.get(context, t) as { n: number };
    const label = pseudonymLabel(t, n);
    this.sql.insert.run(context, t, n, lookup, this.encrypt(this.aad(context, label, lookup), value), now);
    return label;
  }

  /**
   * Replaces each span of `text` with its pseudonym, in one transaction. Text that already
   * looks like a pseudonym is masked too, as a literal, so unmasking gives it back as written.
   */
  mask(context: string, text: string, spans: readonly Span[]): string {
    const literals: Span[] = [...text.matchAll(LABEL_IN_TEXT)]
      .map((m) => ({ start: m.index, end: m.index + m[0].length, type: LITERAL, source: "rule" as const }))
      .filter((l) => !spans.some((s) => s.start < l.end && l.start < s.end));
    return this.database.write(() => replaceSpans(text, [...spans, ...literals], (type, original) => this.pseudonymIn(context, type, original)));
  }

  /**
   * The original value behind a pseudonym ("[PERSON_3]" or "PERSON_3"), or undefined if the
   * context has none. Secrets are only revealed when `secrets` is true.
   */
  reveal(context: string, label: string, { secrets = false }: { secrets?: boolean } = {}): string | undefined {
    const m = LABEL_EXACT.exec(label.trim());
    if (!m) return undefined;
    const type = m[1]!;
    if (!secrets && NEVER_UNMASKED.includes(type)) return undefined;
    const n = Number(m[2]);
    const row = this.sql.get.get(context, type, n) as { lookup: Uint8Array; original: Uint8Array } | undefined;
    return row ? this.decrypt(this.aad(context, pseudonymLabel(type, n), row.lookup), row.original) : undefined;
  }

  /**
   * Puts the real values back into `text`, for the final write after approval. Pseudonyms
   * of types in `keep` (by default, secrets) stay as they are; text that only looks like a
   * pseudonym but is not in this context's vault is left alone. A value that replaces
   * "&lt;PERSON_1&gt;" is HTML-escaped, since the text around it is.
   */
  unmask(context: string, text: string, { keep = NEVER_UNMASKED, kept }: { keep?: readonly string[]; kept?: Set<string> } = {}): string {
    const keepTypes = new Set(keep.map(pseudonymType));
    const cache = new Map<string, string | undefined>();
    return text.replace(LABEL_IN_TEXT, (whole, ...g: (string | undefined)[]) => {
      const entity = g[4] !== undefined;
      const type = (g[0] ?? g[2] ?? g[4])!.replace(/\\/g, "");
      const n = (g[1] ?? g[3] ?? g[5])!;
      const key = `${type}_${n}`;
      if (keepTypes.has(type)) return kept?.add(`[${key}]`), whole;
      if (!cache.has(key)) cache.set(key, this.reveal(context, key, { secrets: true }));
      const value = cache.get(key);
      if (value === undefined) return kept?.add(`[${key}]`), whole;
      return entity ? escapeHtml(value) : value;
    });
  }

  /**
   * The values a context already has pseudonyms for, so later documents mask them even
   * where the rules and the model miss them; with `after`, only those added since that
   * version's `last`. Literals, sources and secrets are left out: the first two are not
   * personal data, and a short secret ("1234") would mask every number like it.
   */
  known(context: string, after = 0): { type: string; value: string }[] {
    const rows = this.sql.all.all(context, after) as { type: string; n: number; lookup: Uint8Array; original: Uint8Array }[];
    return rows.map((r) => ({ type: r.type, value: this.decrypt(this.aad(context, pseudonymLabel(r.type, r.n), r.lookup), r.original) }));
  }

  /**
   * The context's vault version: a random id of the context's row, how many pseudonyms it
   * has and the newest one's row. Any change gives another version, including a context
   * deleted and created again (row ids can be reused, the random id is not).
   */
  version(context: string): { generation: string; count: number; last: number } {
    type Row = { generation: string | null; count: number; last: number };
    let row = this.sql.version.get(context) as Row | undefined;
    if (!row) return { generation: "", count: 0, last: 0 };
    if (row.generation === null) {
      this.database.write(() => this.sql.generation.run(randomBytes(8).toString("hex"), context));
      row = this.sql.version.get(context) as Row;
    }
    return { generation: row.generation ?? "", count: row.count, last: row.last };
  }

  /** How many pseudonyms of the context were added after row `last` (of any type). */
  countAfter(context: string, last: number): number {
    return (this.sql.after.get(context, last) as { c: number }).c;
  }

  /** How many pseudonyms a context has, by type. */
  counts(context: string): Record<string, number> {
    const rows = this.sql.counts.all(context) as { type: string; c: number }[];
    return Object.fromEntries(rows.map((r) => [r.type, r.c]));
  }
}
