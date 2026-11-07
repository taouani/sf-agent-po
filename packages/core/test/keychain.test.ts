import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  configDir,
  Database,
  exportVaultKey,
  importVaultKey,
  KeychainUnavailable,
  keyFile,
  macosKeychain,
  newVaultKey,
  openVault,
  runCommand,
  secretService,
  storedVaultKeyId,
  systemKeyStore,
  Vault,
  VaultKeyMissingError,
  vaultKeyId,
  windowsDpapi,
  withFallback,
  type CommandResult,
  type KeyStore,
  type RunCommand,
} from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "sf-agent-po-keychain-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let dirs = 0;
const freshDir = () => join(tmp, `keys-${++dirs}`);

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const id = "0123456789abcdef0123456789abcdef";

/** A fake command runner that records each call. */
function recorder(answer: (cmd: string, args: readonly string[], input?: string) => CommandResult) {
  const calls: { cmd: string; args: readonly string[]; input?: string }[] = [];
  const run: RunCommand = (cmd, args, input) => {
    calls.push({ cmd, args, input });
    return answer(cmd, args, input);
  };
  return { run, calls };
}

/** An in-memory key store. */
function memoryStore(): KeyStore & { keys: Map<string, Buffer> } {
  const keys = new Map<string, Buffer>();
  return { name: "memory", keys, get: (i) => keys.get(i), set: (i, k) => (keys.set(i, Buffer.from(k)), { where: "memory" }) };
}

describe("the OS keychains", () => {
  it("macOS: passes the key on stdin, never on the command line, and reads it back", () => {
    const key = newVaultKey();
    const { run, calls } = recorder((_, args) => (args[0] === "find-generic-password" ? ok(`${key.toString("hex")}\n`) : ok()));
    const store = macosKeychain(run);
    store.set(id, key);
    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.input).toContain(`-s sf-agent-po -a ${id}`);
    expect(calls[0]!.input).toContain(key.toString("hex"));
    expect(store.get(id)).toEqual(key);
    expect(calls[1]!.args.join(" ")).not.toContain(key.toString("hex"));
  });

  it("macOS: tells a missing entry from a keychain that cannot be used", () => {
    expect(macosKeychain(() => ({ status: 44, stdout: "", stderr: "could not be found" })).get(id)).toBeUndefined();
    expect(() => macosKeychain(() => ({ status: 51, stdout: "", stderr: "User interaction is not allowed." })).get(id)).toThrow(KeychainUnavailable);
    expect(() => macosKeychain(() => ({ status: null, stdout: "", stderr: "", error: new Error("spawn security ENOENT") })).get(id)).toThrow(/ENOENT/);
  });

  it("Secret Service: stores the key from stdin and tells not found from no keyring", () => {
    const key = newVaultKey();
    const { run, calls } = recorder(() => ok());
    secretService(run).set(id, key);
    expect(calls[0]!.args).toEqual(["store", "--label", "sf-agent-po vault key", "service", "sf-agent-po", "account", id]);
    expect(calls[0]!.input).toBe(key.toString("hex"));
    expect(secretService(() => ok(key.toString("hex"))).get(id)).toEqual(key);
    expect(secretService(() => ({ status: 1, stdout: "", stderr: "" })).get(id)).toBeUndefined();
    expect(() => secretService(() => ({ status: 1, stdout: "", stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" })).get(id)).toThrow(KeychainUnavailable);
  });

  it("Windows: keeps the key encrypted by DPAPI in the key folder", () => {
    const dir = freshDir();
    // A stand-in for DPAPI that reverses the bytes.
    const flip = (b64: string) => Buffer.from(b64, "base64").reverse().toString("base64");
    const { run, calls } = recorder((_, args, input) => ok(`${flip(input!)}\r\n`));
    const store = windowsDpapi(dir, run);
    const key = newVaultKey();
    expect(store.get(id)).toBeUndefined();
    store.set(id, key);
    expect(calls[0]!.cmd).toBe("powershell.exe");
    expect(calls[0]!.args.join(" ")).toContain("Protect(");
    expect(calls[0]!.args.join(" ")).not.toContain(key.toString("base64"));
    expect(readFileSync(join(dir, `${id}.dpapi`), "utf8")).not.toContain(key.toString("base64"));
    expect(store.get(id)).toEqual(key);
  });

  it("refuses an id that could leave the key folder", () => {
    expect(() => keyFile(freshDir()).get("../../etc/passwd")).toThrow(/Invalid vault key id/);
  });
});

describe("the key file fallback", () => {
  it("saves a key only the user can read, with a warning", () => {
    const dir = freshDir();
    const store = keyFile(dir);
    const key = newVaultKey();
    const saved = store.set(id, key);
    expect(saved.warning).toMatch(/No OS keychain.*backup/s);
    expect(store.get(id)).toEqual(key);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, `${id}.key`)).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it("is used when the keychain cannot be, and says why", () => {
    const dir = freshDir();
    const down: KeyStore = {
      name: "the test keychain",
      get: () => {
        throw new KeychainUnavailable("the test keychain", "locked");
      },
      set: () => {
        throw new KeychainUnavailable("the test keychain", "locked");
      },
    };
    const store = withFallback(down, keyFile(dir));
    const key = newVaultKey();
    expect(store.set(id, key).warning).toMatch(/locked/);
    expect(store.get(id)).toEqual(key);
  });

  it("is used when the keychain accepts a key but does not give it back", () => {
    const forgetful: KeyStore = { name: "forgetful", get: () => undefined, set: () => ({ where: "forgetful" }) };
    const dir = freshDir();
    const saved = withFallback(forgetful, keyFile(dir)).set(id, newVaultKey());
    expect(saved.where).toBe(join(dir, `${id}.key`));
    expect(saved.warning).toMatch(/did not give the key back/);
  });

  it("is not used when the keychain works", () => {
    const dir = freshDir();
    const mem = memoryStore();
    const saved = withFallback(mem, keyFile(dir)).set(id, newVaultKey());
    expect(saved).toEqual({ where: "memory" });
    expect(keyFile(dir).get(id)).toBeUndefined();
  });

  it("lives in the user's configuration folder", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe(join("/x", "sf-agent-po"));
    expect(configDir({ XDG_CONFIG_HOME: "relative" }, "linux")).toMatch(/\.config[\\/]sf-agent-po$/);
    expect(configDir({ APPDATA: "C:\\Users\\t\\AppData\\Roaming" }, "win32")).toContain("sf-agent-po");
    expect(configDir({}, "darwin")).toMatch(/Application Support[\\/]sf-agent-po$/);
  });
});

describe("opening a workspace's vault", () => {
  it("creates a key for a new vault, saves it first, and finds it again", () => {
    const store = memoryStore();
    const db = new Database(":memory:");
    const first = openVault(db, store);
    expect(first.created).toEqual({ where: "memory" });
    expect(store.keys.get(first.keyId)).toBeDefined();
    expect(storedVaultKeyId(db)).toBe(first.keyId);
    expect(vaultKeyId(store.keys.get(first.keyId)!)).toBe(first.keyId);
    first.vault.pseudonym("acme", "PERSON", "Sarah Whitfield");
    const again = openVault(db, store);
    expect(again.created).toBeUndefined();
    expect(again.vault.reveal("acme", "[PERSON_1]")).toBe("Sarah Whitfield");
  });

  it("keeps one key per vault", () => {
    const store = memoryStore();
    const a = openVault(new Database(":memory:"), store);
    const b = openVault(new Database(":memory:"), store);
    expect(a.keyId).not.toBe(b.keyId);
    expect(store.keys.size).toBe(2);
  });

  it("names the missing key, and opens again once the backup is imported", () => {
    const db = new Database(":memory:");
    const home = memoryStore();
    const { vault, keyId } = openVault(db, home);
    vault.pseudonym("acme", "PERSON", "Sarah Whitfield");
    const backup = exportVaultKey(db, home);
    expect(backup).toMatch(/^sfpo-key-1-[A-Za-z0-9_-]{43}$/);

    const laptop = memoryStore();
    expect(() => openVault(db, laptop)).toThrow(VaultKeyMissingError);
    expect(() => openVault(db, laptop)).toThrow(new RegExp(`id ${keyId}.*Import it from your key backup`, "s"));
    // A backup copied with line breaks or spaces still reads.
    const imported = importVaultKey(db, `${backup.slice(0, 20)}\n ${backup.slice(20)}`, laptop);
    expect(imported.keyId).toBe(keyId);
    expect(openVault(db, laptop).vault.reveal("acme", "[PERSON_1]")).toBe("Sarah Whitfield");
  });

  it("refuses a backup of another vault's key, or text that is not a backup", () => {
    const store = memoryStore();
    const db = new Database(":memory:");
    openVault(db, store);
    const other = new Database(":memory:");
    const otherBackup = exportVaultKey(other, (openVault(other, store), store));
    expect(() => importVaultKey(db, otherBackup, memoryStore())).toThrow(/but the vault of .* was written with the key with id/);
    expect(() => importVaultKey(db, "sfpo-key-1-tooshort", memoryStore())).toThrow(/not an sf-agent-po key backup/);
    expect(() => importVaultKey(db, randomBytes(32).toString("hex"), memoryStore())).toThrow(/not an sf-agent-po key backup/);
    expect(() => importVaultKey(new Database(":memory:"), exportVaultKey(db, store), memoryStore())).toThrow(/no vault yet/);
    expect(() => exportVaultKey(new Database(":memory:"), store)).toThrow(/no vault yet/);
  });

  it("uses the key of a process that created the vault at the same time", () => {
    const db = new Database(":memory:");
    const store = memoryStore();
    const theirs = newVaultKey();
    // While this process saves its new key, another one creates the vault with its own.
    const racing: KeyStore = {
      name: "racing",
      get: (i) => store.get(i),
      set: (i, k) => {
        if (!store.keys.size) {
          store.set(vaultKeyId(theirs), theirs);
          new Vault(db, theirs).pseudonym("acme", "PERSON", "Tom Baker");
        }
        return store.set(i, k);
      },
    };
    const opened = openVault(db, racing);
    expect(opened.keyId).toBe(vaultKeyId(theirs));
    expect(opened.vault.reveal("acme", "[PERSON_1]")).toBe("Tom Baker");
  });
});

// Runs against this computer's real keychain (CI sets SF_AGENT_PO_KEYCHAIN_TEST on all three OSes).
describe.runIf(process.env.SF_AGENT_PO_KEYCHAIN_TEST === "1")("this computer's key store", () => {
  it("saves a key and gives it back", () => {
    const store = systemKeyStore({ dir: freshDir() });
    const key = newVaultKey();
    const keyId = vaultKeyId(key);
    try {
      const saved = store.set(keyId, key);
      console.log(`Key saved in ${saved.where}${saved.warning ? " (fallback)" : ""}`);
      expect(store.get(keyId)).toEqual(key);
    } finally {
      if (process.platform === "darwin") runCommand("security", ["delete-generic-password", "-s", "sf-agent-po", "-a", keyId]);
      if (process.platform === "linux") runCommand("secret-tool", ["clear", "service", "sf-agent-po", "account", keyId]);
    }
    // Each Windows PowerShell start takes a second or two, and saving reads the key back.
  }, 60_000);
});
