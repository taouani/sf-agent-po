import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { validateContextName } from "../store/contexts.js";
import type { Database } from "../store/db.js";
import { replaceSpans, type Span } from "./spans.js";

/** The vault key's length: 32 random bytes, kept in the OS keychain. */
export const VAULT_KEY_BYTES = 32;

/** A new random vault key. */
export function newVaultKey(): Buffer {
  return randomBytes(VAULT_KEY_BYTES);
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

/** How a value is compared, so "06 12 34 56 78" and "0612345678" get the same pseudonym. */
function normalise(type: string, value: string): string {
  const v = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  switch (type) {
    case "PHONE":
    case "IBAN":
    case "CARD":
    case "NATIONAL_ID":
      return v.replace(/[^\p{L}\p{N}+]/gu, "").toUpperCase();
    case "EMAIL":
      return v.toLowerCase();
    case "PERSON":
      // Names written with or without spaces or dots ("Sarah Whitfield", "sarah.whitfield") are one person.
      return v.toLowerCase().replace(/[\s._-]+/gu, "");
    case "SECRET":
      return value; // exact: two secrets that differ by case are different secrets
    default:
      return v.toLowerCase();
  }
}

/** A pseudonym's type part: upper-case letters, digits and underscores only, so labels stay easy to find. */
const typePart = (type: string) => type.toUpperCase().replace(/[^A-Z0-9_]/g, "_") || "VALUE";

/** "[PERSON_3]" */
export const pseudonymLabel = (type: string, n: number) => `[${typePart(type)}_${n}]`;

/**
 * A pseudonym as a model may write it back: "[PERSON_3]", "<PERSON_3>", "&lt;PERSON_3&gt;" or
 * a bare PERSON_3. Group 1 is the type, group 2 the number.
 */
const LABEL_IN_TEXT = /(?:\[|<|&lt;)?\b([A-Z][A-Z0-9_]*?)_(\d+)\b(?:\]|>|&gt;)?/g;

/**
 * The pseudonym vault (AR1): masks values with stable, per-context pseudonyms and keeps
 * the originals encrypted, so real values come back only when output is published.
 * All methods are synchronous and each runs in one transaction.
 */
export class Vault {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  /** Opens the vault of `database` with `key`; throws VaultKeyError when the key is not the vault's. */
  constructor(
    private readonly database: Database,
    key: Buffer,
  ) {
    if (key.length !== VAULT_KEY_BYTES) throw new Error(`A vault key has ${VAULT_KEY_BYTES} bytes, not ${key.length}.`);
    const derive = (info: string) => Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `sf-agent-po vault ${info}`, 32));
    this.encKey = derive("encryption");
    this.macKey = derive("lookup");
    const check = createHmac("sha256", derive("check")).update("sf-agent-po vault key check").digest();
    database.write(() => {
      const row = this.db.prepare("SELECT key_check FROM vault WHERE id = 1").get() as { key_check: Uint8Array } | undefined;
      if (!row) this.db.prepare("INSERT INTO vault (id, key_check, created_at) VALUES (1, ?, ?)").run(check, new Date().toISOString());
      else if (row.key_check.length !== check.length || !timingSafeEqual(Buffer.from(row.key_check), check)) throw new VaultKeyError(database.file);
    });
  }

  private get db() {
    return this.database.db;
  }

  private lookup(context: string, type: string, value: string): Buffer {
    return createHmac("sha256", this.macKey).update(`${context}\0${typePart(type)}\0${normalise(typePart(type), value)}`).digest();
  }

  private encrypt(context: string, label: string, value: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encKey, iv);
    cipher.setAAD(Buffer.from(`${context}\0${label}`));
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  private decrypt(context: string, label: string, blob: Uint8Array): string {
    const b = Buffer.from(blob);
    const decipher = createDecipheriv("aes-256-gcm", this.encKey, b.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${context}\0${label}`));
    decipher.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString("utf8");
  }

  /** The pseudonym of `value` in `context`, created on first use. The same value always gets the same one. */
  pseudonym(context: string, type: string, value: string): string {
    return this.database.write(() => this.pseudonymIn(context, type, value));
  }

  private pseudonymIn(context: string, type: string, value: string): string {
    const t = typePart(type);
    const lookup = this.lookup(context, t, value);
    const found = this.db.prepare("SELECT type, n FROM pseudonym WHERE context = ? AND lookup = ?").get(context, lookup) as { type: string; n: number } | undefined;
    if (found) return pseudonymLabel(found.type, found.n);
    const now = new Date().toISOString();
    validateContextName(context);
    this.db.prepare("INSERT OR IGNORE INTO context (name, created_at, updated_at) VALUES (?, ?, ?)").run(context, now, now);
    const { n } = this.db.prepare("SELECT coalesce(max(n), 0) + 1 AS n FROM pseudonym WHERE context = ? AND type = ?").get(context, t) as { n: number };
    const label = pseudonymLabel(t, n);
    this.db
      .prepare("INSERT INTO pseudonym (context, type, n, lookup, original, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(context, t, n, lookup, this.encrypt(context, label, value), now);
    return label;
  }

  /** Replaces each span of `text` with its pseudonym, in one transaction. */
  mask(context: string, text: string, spans: readonly Span[]): string {
    return this.database.write(() => replaceSpans(text, spans, (type, original) => this.pseudonymIn(context, type, original)));
  }

  /** The original value behind a pseudonym ("[PERSON_3]" or "PERSON_3"), or undefined if the context has none. */
  reveal(context: string, label: string): string | undefined {
    const m = /^\[?([A-Z][A-Z0-9_]*?)_(\d+)\]?$/.exec(label.trim());
    if (!m) return undefined;
    const row = this.db.prepare("SELECT original FROM pseudonym WHERE context = ? AND type = ? AND n = ?").get(context, m[1]!, Number(m[2])) as
      | { original: Uint8Array }
      | undefined;
    return row ? this.decrypt(context, pseudonymLabel(m[1]!, Number(m[2])), row.original) : undefined;
  }

  /**
   * Puts the real values back into `text`, for the final write after approval. Pseudonyms
   * of types in `keep` (by default, secrets) stay as they are; text that only looks like a
   * pseudonym but is not in this context's vault is left alone.
   */
  unmask(context: string, text: string, { keep = NEVER_UNMASKED }: { keep?: readonly string[] } = {}): string {
    const cache = new Map<string, string | undefined>();
    return text.replace(LABEL_IN_TEXT, (whole, type: string, n: string) => {
      if (keep.includes(type)) return whole;
      const key = `${type}_${n}`;
      if (!cache.has(key)) cache.set(key, this.reveal(context, key));
      return cache.get(key) ?? whole;
    });
  }

  /** How many pseudonyms a context has, by type. */
  counts(context: string): Record<string, number> {
    const rows = this.db.prepare("SELECT type, count(*) AS c FROM pseudonym WHERE context = ? GROUP BY type").all(context) as { type: string; c: number }[];
    return Object.fromEntries(rows.map((r) => [r.type, r.c]));
  }
}
