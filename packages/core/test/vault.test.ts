import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Database, detect, newVaultKey, Vault, VaultKeyError } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "sf-agent-po-vault-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const open = (key = newVaultKey()) => {
  const db = new Database(":memory:");
  return { db, vault: new Vault(db, key), key };
};

describe("the pseudonym vault", () => {
  it("gives each value a stable pseudonym, numbered per type and context", () => {
    const { vault } = open();
    expect(vault.pseudonym("acme", "PERSON", "Sarah Whitfield")).toBe("[PERSON_1]");
    expect(vault.pseudonym("acme", "PERSON", "Tom Baker")).toBe("[PERSON_2]");
    expect(vault.pseudonym("acme", "EMAIL", "sarah@example.com")).toBe("[EMAIL_1]");
    expect(vault.pseudonym("acme", "PERSON", "Sarah Whitfield")).toBe("[PERSON_1]");
    // Another context has its own numbering (DE2).
    expect(vault.pseudonym("globex", "PERSON", "Tom Baker")).toBe("[PERSON_1]");
    expect(vault.counts("acme")).toEqual({ PERSON: 2, EMAIL: 1 });
  });

  it("treats spellings of the same value as one, but keeps different names apart", () => {
    const { vault } = open();
    const same = (type: string, a: string, b: string) => expect(vault.pseudonym("c", type, a)).toBe(vault.pseudonym("c", type, b));
    const differ = (type: string, a: string, b: string) => expect(vault.pseudonym("c", type, a)).not.toBe(vault.pseudonym("c", type, b));
    same("PERSON", "Sarah Whitfield", "sarah  WHITFIELD");
    same("PERSON", "Liam O'Brien", "Liam O\u2019Brien");
    same("PERSON", "Ren\u00e9e Dupr\u00e9", "Rene\u0301e Dupre\u0301");
    differ("PERSON", "Sarah Whitfield", "sarah.whitfield");
    differ("PERSON", "Jo Ann Smith", "Joan N. Smith");
    same("PHONE", "06 12 34 56 78", "06.12.34.56.78");
    same("EMAIL", "Sarah@Example.com", "sarah@example.com");
    same("IBAN", "FR76 3000 6000 0112 3456 7890 189", "fr7630006000011234567890189");
    differ("SECRET", "Hunter2!", "hunter2!");
  });

  it("gives back a handle exactly as written", () => {
    const { vault } = open();
    vault.pseudonym("c", "PERSON", "Sarah Whitfield");
    const label = vault.pseudonym("c", "PERSON", "sarah.whitfield");
    expect(vault.unmask("c", `Login: ${label}`)).toBe("Login: sarah.whitfield");
  });

  it("maps any masking type to a label that can be found again", () => {
    const { vault } = open();
    const label = vault.pseudonym("c", "num\u00e9ro client", "C-123");
    expect(label).toBe("[NUMERO_CLIENT_1]");
    expect(vault.pseudonym("c", "42", "x")).toBe("[T_42_1]");
    expect(vault.unmask("c", `Client ${label}`)).toBe("Client C-123");
  });

  it("masks text and unmasks it back, keeping secrets masked by default", async () => {
    const { vault } = open();
    const text = "Call Sarah Whitfield at sarah@example.com, password: Hunter2!x";
    const spans = await detect(text, { dictionary: [{ value: "Sarah Whitfield", type: "PERSON" }] });
    const masked = vault.mask("acme", text, spans);
    expect(masked).toBe("Call [PERSON_1] at [EMAIL_1], password: [SECRET_1]");
    expect(vault.unmask("acme", masked)).toBe("Call Sarah Whitfield at sarah@example.com, password: [SECRET_1]");
    expect(vault.unmask("acme", masked, { keep: [] })).toBe(text);
  });

  it("recognises pseudonyms as a model may write them back", () => {
    const { vault } = open();
    vault.pseudonym("acme", "PERSON", "Sarah Whitfield");
    vault.pseudonym("acme", "NATIONAL_ID", "536-22-8094");
    const out = vault.unmask("acme", "<PERSON_1>, \\[PERSON\\_1\\], [NATIONAL_ID_1], \\[NATIONAL\\_ID\\_1\\]; [PERSON_9] and [CASE_1] are not ours.");
    expect(out).toBe("Sarah Whitfield, Sarah Whitfield, 536-22-8094, 536-22-8094; [PERSON_9] and [CASE_1] are not ours.");
  });

  it("escapes a value that replaces an HTML-escaped pseudonym", () => {
    const { vault } = open();
    vault.pseudonym("acme", "PERSON", "Tom <Tommy> & Co");
    expect(vault.unmask("acme", "<p>&lt;PERSON_1&gt;</p>")).toBe("<p>Tom &lt;Tommy&gt; &amp; Co</p>");
  });

  it("leaves alone what is not a whole pseudonym", () => {
    const { vault } = open();
    vault.pseudonym("acme", "PERSON", "Sarah Whitfield");
    vault.pseudonym("acme", "ADDRESS", "1 rue de la Paix");
    for (const text of ["Map ADDRESS_1 to BillingStreet", "PERSON_1", "[PERSON_01]", "[PERSON_1", "PERSON_1]", "[~PERSON_1]", "[PERSON_2|https://x]", "<PERSON_1]"]) {
      expect(vault.unmask("acme", text)).toBe(text);
    }
    expect(vault.reveal("acme", "[PERSON_01]")).toBeUndefined();
  });

  it("gives back pseudonym-like text that was already in the source as written", () => {
    const { vault } = open();
    vault.pseudonym("acme", "PERSON", "Sarah Whitfield");
    const text = "Template: Dear [PERSON_1], see <EMAIL_1>. Owner: Tom Baker.";
    const masked = vault.mask("acme", text, [{ start: text.indexOf("Tom"), end: text.indexOf("Tom") + 9, type: "PERSON", source: "dictionary" }]);
    expect(masked).toBe("Template: Dear [LITERAL_1], see [LITERAL_2]. Owner: [PERSON_2].");
    expect(vault.unmask("acme", masked)).toBe(text);
  });

  it("keeps secrets masked, whatever the type was called", () => {
    const { vault } = open();
    // A model label such as "api key" is a secret, so it never comes back on publish.
    expect(vault.pseudonym("acme", "api key", "sk-live-abc")).toBe("[SECRET_1]");
    expect(vault.unmask("acme", "[SECRET_1]")).toBe("[SECRET_1]");
    const secret = vault.pseudonym("acme", "SECRET", "Hunter2!x");
    expect(vault.reveal("acme", secret)).toBeUndefined();
    expect(vault.reveal("acme", secret, { secrets: true })).toBe("Hunter2!x");
    expect(vault.unmask("acme", secret)).toBe(secret);
  });

  it("never reveals another context's values", () => {
    const { vault } = open();
    vault.pseudonym("acme", "PERSON", "Sarah Whitfield");
    expect(vault.reveal("acme", "[PERSON_1]")).toBe("Sarah Whitfield");
    expect(vault.reveal("globex", "[PERSON_1]")).toBeUndefined();
    expect(vault.unmask("globex", "[PERSON_1]")).toBe("[PERSON_1]");
  });

  it("stores no original in clear", () => {
    const { db, vault } = open();
    vault.pseudonym("acme", "PERSON", "Sarah Whitfield");
    const rows = db.db.prepare("SELECT * FROM pseudonym").all() as Record<string, unknown>[];
    const dump = JSON.stringify(rows, (_, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v));
    expect(dump).not.toMatch(/sarah|whitfield/i);
  });

  it("refuses a different key with an error that names the cause, and keeps working with the right one", () => {
    const file = join(tmp, "ws", "sf-agent.db");
    const key = newVaultKey();
    const first = new Database(file);
    new Vault(first, key).pseudonym("acme", "PERSON", "Sarah Whitfield");
    first.close();
    const again = new Database(file);
    expect(() => new Vault(again, newVaultKey())).toThrow(VaultKeyError);
    expect(() => new Vault(again, newVaultKey())).toThrow(/keychain.*Restore it from your key backup/s);
    expect(new Vault(again, key).reveal("acme", "PERSON_1")).toBe("Sarah Whitfield");
    again.close();
  });

  it("refuses a key of the wrong length", () => {
    expect(() => new Vault(new Database(":memory:"), Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it("detects a tampered or moved original", () => {
    const { db, vault } = open();
    vault.pseudonym("acme", "PERSON", "Sarah Whitfield");
    vault.pseudonym("acme", "PERSON", "Tom Baker");
    // Swapping the encrypted originals between rows breaks their authentication.
    db.db.exec("UPDATE pseudonym SET original = (SELECT original FROM pseudonym WHERE n = 2) WHERE n = 1");
    expect(() => vault.reveal("acme", "PERSON_1")).toThrow();
  });

  it("detects swapped lookups", () => {
    const { db, vault } = open();
    vault.pseudonym("acme", "PERSON", "Sarah Whitfield");
    vault.pseudonym("acme", "PERSON", "Tom Baker");
    db.db.exec(`
      CREATE TEMP TABLE l AS SELECT n, lookup FROM pseudonym;
      UPDATE pseudonym SET lookup = randomblob(32);
      UPDATE pseudonym SET lookup = (SELECT lookup FROM l WHERE l.n = 3 - pseudonym.n);`);
    expect(() => vault.pseudonym("acme", "PERSON", "Sarah Whitfield")).toThrow(/changed outside sf-agent-po/);
  });

  it("refuses to open a vault whose key check is gone", () => {
    const { db, vault } = open();
    vault.pseudonym("acme", "PERSON", "Sarah Whitfield");
    db.db.exec("DELETE FROM vault");
    expect(() => new Vault(db, newVaultKey())).toThrow(VaultKeyError);
  });

  it("goes with its context when the context is deleted", () => {
    const { db, vault } = open();
    vault.pseudonym("acme", "PERSON", "Sarah Whitfield");
    db.db.exec("DELETE FROM context WHERE name = 'acme'");
    expect(vault.counts("acme")).toEqual({});
  });
});
