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

  it("treats spellings of the same value as one", () => {
    const { vault } = open();
    const same = (type: string, a: string, b: string) => expect(vault.pseudonym("c", type, a)).toBe(vault.pseudonym("c", type, b));
    same("PERSON", "Sarah Whitfield", "sarah.whitfield");
    same("PERSON", "Sarah  Whitfield", "SarahWhitfield");
    same("PHONE", "06 12 34 56 78", "06.12.34.56.78");
    same("EMAIL", "Sarah@Example.com", "sarah@example.com");
    same("IBAN", "FR76 3000 6000 0112 3456 7890 189", "fr7630006000011234567890189");
    expect(vault.pseudonym("c", "SECRET", "Hunter2!")).not.toBe(vault.pseudonym("c", "SECRET", "hunter2!"));
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
    const out = vault.unmask("acme", "PERSON_1, <PERSON_1>, &lt;PERSON_1&gt; and [NATIONAL_ID_1]; PERSON_9 and CASE_1 are not ours.");
    expect(out).toBe("Sarah Whitfield, Sarah Whitfield, Sarah Whitfield and 536-22-8094; PERSON_9 and CASE_1 are not ours.");
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

  it("goes with its context when the context is deleted", () => {
    const { db, vault } = open();
    vault.pseudonym("acme", "PERSON", "Sarah Whitfield");
    db.db.exec("DELETE FROM context WHERE name = 'acme'");
    expect(vault.counts("acme")).toEqual({});
  });
});
