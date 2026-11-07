// Keeps vault keys out of the workspace: in the OS keychain where there is one, through the
// tools each OS ships (no native module), else in a key file only the user can read.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "../store/db.js";
import { newVaultKey, Vault, VAULT_KEY_BYTES, vaultKeyCheck, VaultKeyError } from "./vault.js";

/** The keychain service name every key is stored under. */
export const KEYCHAIN_SERVICE = "sf-agent-po";

/** What running a command gave; `error` is set when it could not run at all (not installed, timed out). */
export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Runs a command without a shell, with `input` on stdin. Replaceable in tests. */
export type RunCommand = (command: string, args: readonly string[], input?: string) => CommandResult;

const TIMEOUT_MS = 15_000;

export const runCommand: RunCommand = (command, args, input) => {
  const r = spawnSync(command, args, { input, encoding: "utf8", timeout: TIMEOUT_MS, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
};

/** Where a key was saved, and a warning for the user when that place is weaker than a keychain. */
export interface KeySaved {
  where: string;
  warning?: string;
}

/** A place that keeps vault keys by id. `get` returns undefined when it has no key with that id. */
export interface KeyStore {
  readonly name: string;
  get(id: string): Buffer | undefined;
  set(id: string, key: Buffer): KeySaved;
}

/** The keychain cannot be used here (no tool, no keyring daemon, locked, timed out). */
export class KeychainUnavailable extends Error {
  constructor(store: string, detail: string) {
    super(`${store} is not available: ${detail}`);
    this.name = "KeychainUnavailable";
  }
}

const ID = /^[0-9a-f]{32}$/;
const checkId = (id: string) => {
  if (!ID.test(id)) throw new Error(`Invalid vault key id "${id}".`);
  return id;
};

const fromHex = (hex: string): Buffer | undefined => {
  const t = hex.trim();
  return /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, "hex") : undefined;
};

const failed = (r: CommandResult) => (r.error ? r.error.message : r.stderr.trim() || `exit status ${r.status}`);

/** macOS: the login keychain, through `security`. The key goes in on stdin (`security -i`), never on a command line. */
export function macosKeychain(run: RunCommand = runCommand): KeyStore {
  const name = "the macOS keychain";
  return {
    name,
    get(id) {
      const r = run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", checkId(id), "-w"]);
      if (r.error) throw new KeychainUnavailable(name, failed(r));
      if (r.status === 44) return undefined; // errSecItemNotFound
      if (r.status !== 0) throw new KeychainUnavailable(name, failed(r));
      return fromHex(r.stdout);
    },
    set(id, key) {
      const r = run("security", ["-i"], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${checkId(id)} -l sf-agent-po-vault-key -w ${key.toString("hex")}\n`);
      if (r.error || r.status !== 0) throw new KeychainUnavailable(name, failed(r));
      return { where: name };
    },
  };
}

/** Linux and other Unix systems: the Secret Service (GNOME Keyring, KWallet), through `secret-tool`. */
export function secretService(run: RunCommand = runCommand): KeyStore {
  const name = "the Secret Service keyring";
  return {
    name,
    get(id) {
      const r = run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", checkId(id)]);
      if (r.error) throw new KeychainUnavailable(name, failed(r));
      // Not found is exit 1 with nothing on stderr; a missing daemon or locked keyring says why.
      if (r.status !== 0) {
        if (r.stderr.trim()) throw new KeychainUnavailable(name, failed(r));
        return undefined;
      }
      return fromHex(r.stdout);
    },
    set(id, key) {
      const r = run("secret-tool", ["store", "--label", "sf-agent-po vault key", "service", KEYCHAIN_SERVICE, "account", checkId(id)], key.toString("hex"));
      if (r.error || r.status !== 0) throw new KeychainUnavailable(name, failed(r));
      return { where: name };
    },
  };
}

/** The user's configuration folder for sf-agent-po on this OS. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const usable = (v: string | undefined) => (v && isAbsolute(v) ? v : undefined);
  const base =
    platform === "win32"
      ? (usable(env.APPDATA) ?? join(homedir(), "AppData", "Roaming"))
      : platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : (usable(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config"));
  return join(base, "sf-agent-po");
}

/** Writes a file only the user can read, replacing any old one in one step. */
function writePrivate(file: string, data: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function readIfExists(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function keysDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  return dir;
}

const DPAPI = (op: "Protect" | "Unprotect") =>
  "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Security; " +
  "$d = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
  "$e = [Text.Encoding]::UTF8.GetBytes('sf-agent-po vault key'); " +
  `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($d, $e, [Security.Cryptography.DataProtectionScope]::CurrentUser))`;

/**
 * Windows: the key encrypted with DPAPI for the current user, in a file in the user's
 * profile. Only that Windows account can decrypt it. Uses Windows PowerShell, which every
 * Windows ships.
 */
export function windowsDpapi(dir = join(configDir(), "keys"), run: RunCommand = runCommand): KeyStore {
  const name = "Windows DPAPI";
  const ps = (op: "Protect" | "Unprotect", input: string) => {
    const r = run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI(op)], input);
    if (r.error || r.status !== 0) throw new KeychainUnavailable(name, failed(r));
    return r.stdout.trim();
  };
  return {
    name,
    get(id) {
      const blob = readIfExists(join(dir, `${checkId(id)}.dpapi`));
      if (blob === undefined) return undefined;
      const key = Buffer.from(ps("Unprotect", blob.trim()), "base64");
      return key.length === VAULT_KEY_BYTES ? key : undefined;
    },
    set(id, key) {
      const file = join(keysDir(dir), `${checkId(id)}.dpapi`);
      writePrivate(file, ps("Protect", key.toString("base64")));
      return { where: `${name} (${file})` };
    },
  };
}

/** The fallback: a key file only the user can read. Anyone with the user's account or a copy of the disk can. */
export function keyFile(dir = join(configDir(), "keys")): KeyStore {
  const name = "a key file";
  return {
    name,
    get(id) {
      const text = readIfExists(join(dir, `${checkId(id)}.key`));
      return text === undefined ? undefined : fromHex(text);
    },
    set(id, key) {
      const file = join(keysDir(dir), `${checkId(id)}.key`);
      writePrivate(file, `${key.toString("hex")}\n`);
      return {
        where: file,
        warning:
          `No OS keychain was available, so the masking key was saved in ${file}, readable only by your user account. ` +
          `Keep a backup of it: without it, masked documents cannot be unmasked.`,
      };
    },
  };
}

/**
 * Uses `primary` and falls back to `fallback` when the keychain cannot be used. A key the
 * keychain accepts is read back before it counts as saved. Reading looks in both, so a key
 * saved while the keychain was down is still found once it is back.
 */
export function withFallback(primary: KeyStore, fallback: KeyStore): KeyStore {
  return {
    name: `${primary.name}, else ${fallback.name}`,
    get(id) {
      try {
        const key = primary.get(id);
        if (key) return key;
      } catch (err) {
        if (!(err instanceof KeychainUnavailable)) throw err;
      }
      return fallback.get(id);
    },
    set(id, key) {
      let reason: string;
      try {
        const saved = primary.set(id, key);
        if (primary.get(id)?.equals(key)) return saved;
        reason = `${primary.name} did not give the key back`;
      } catch (err) {
        if (!(err instanceof KeychainUnavailable)) throw err;
        reason = err.message;
      }
      const saved = fallback.set(id, key);
      return { ...saved, warning: saved.warning && `${saved.warning} (${reason}.)` };
    },
  };
}

/** The key store for this OS: the macOS keychain, Windows DPAPI or the Secret Service, each falling back to a key file. */
export function systemKeyStore(
  { platform = process.platform, dir = join(configDir(), "keys"), run = runCommand }: { platform?: NodeJS.Platform; dir?: string; run?: RunCommand } = {},
): KeyStore {
  const primary = platform === "darwin" ? macosKeychain(run) : platform === "win32" ? windowsDpapi(dir, run) : secretService(run);
  return withFallback(primary, keyFile(dir));
}

/** A key's id in the keychain: the start of its key check, so it reveals nothing about the key. */
export function vaultKeyId(key: Buffer): string {
  return vaultKeyCheck(key).subarray(0, 16).toString("hex");
}

/** The id of the key a workspace's vault was written with, or undefined for a new vault. */
export function storedVaultKeyId(database: Database): string | undefined {
  const row = database.db.prepare("SELECT key_check FROM vault WHERE id = 1").get() as { key_check: Uint8Array } | undefined;
  return row && Buffer.from(row.key_check).subarray(0, 16).toString("hex");
}

/** The vault has a key, but the key store does not hold it (another computer, a reinstalled OS, a deleted entry). */
export class VaultKeyMissingError extends Error {
  constructor(
    file: string,
    readonly keyId: string,
  ) {
    super(
      `The masking key of ${file} (id ${keyId}) is not in your OS keychain or key folder. ` +
        `Import it from your key backup; until then the documents keep their pseudonyms and nothing can be unmasked.`,
    );
    this.name = "VaultKeyMissingError";
  }
}

/** An opened vault, the key's id, and where a new key was saved (with any warning for the user). */
export interface OpenedVault {
  vault: Vault;
  keyId: string;
  created?: KeySaved;
}

/**
 * Opens a workspace's vault with its key from `store`. A new vault gets a new key, saved
 * in the store before anything is encrypted with it.
 */
export function openVault(database: Database, store: KeyStore = systemKeyStore()): OpenedVault {
  const existing = storedVaultKeyId(database);
  if (existing) {
    const key = store.get(existing);
    if (!key) throw new VaultKeyMissingError(database.file, existing);
    return { vault: new Vault(database, key), keyId: existing };
  }
  const key = newVaultKey();
  const keyId = vaultKeyId(key);
  const created = store.set(keyId, key);
  try {
    return { vault: new Vault(database, key), keyId, created };
  } catch (err) {
    // Another process created the vault first: use its key.
    if (err instanceof VaultKeyError && storedVaultKeyId(database)) return openVault(database, store);
    throw err;
  }
}

const EXPORT_PREFIX = "sfpo-key-1-";

/**
 * The vault's key as text for a backup (a password manager, a printed copy). Anyone with it
 * and a copy of the workspace can read the masked values, so keep it as you would a password.
 */
export function exportVaultKey(database: Database, store: KeyStore = systemKeyStore()): string {
  const id = storedVaultKeyId(database);
  if (!id) throw new Error(`${database.file} has no vault yet, so there is no key to back up.`);
  const key = store.get(id);
  if (!key) throw new VaultKeyMissingError(database.file, id);
  return EXPORT_PREFIX + key.toString("base64url");
}

/** Reads a key backup and saves it in `store`. It must be the key this workspace's vault was written with. */
export function importVaultKey(database: Database, backup: string, store: KeyStore = systemKeyStore()): KeySaved & { keyId: string } {
  const text = backup.replace(/\s+/g, "");
  const key = text.startsWith(EXPORT_PREFIX) ? Buffer.from(text.slice(EXPORT_PREFIX.length), "base64url") : undefined;
  if (!key || key.length !== VAULT_KEY_BYTES || key.toString("base64url") !== text.slice(EXPORT_PREFIX.length)) {
    throw new Error(`This is not an sf-agent-po key backup: it should start with "${EXPORT_PREFIX}" followed by 43 characters.`);
  }
  const keyId = vaultKeyId(key);
  const expected = storedVaultKeyId(database);
  if (!expected) throw new Error(`${database.file} has no vault yet, so this key would not be used.`);
  if (expected !== keyId) throw new Error(`This backup is the key with id ${keyId}, but the vault of ${database.file} was written with the key with id ${expected}.`);
  return { ...store.set(keyId, key), keyId };
}
