// `sf-agent-po key`: backs up the vault key of a workspace, or puts a backup back. Without
// the key, masked documents keep their pseudonyms and nothing can be published with real
// values (risk 8 of the v1 plan).

import { existsSync } from "node:fs";
import path from "node:path";
import type { KeyStore } from "@sf-agent-po/core";

export const KEY_USAGE = `Usage: npx sf-agent-po@next key export [--workspace <folder>]
       npx sf-agent-po@next key import [--workspace <folder>] [--allow-key-file]

export prints the vault key of the workspace (SF_AGENT_WORKSPACE, else .sf-agent
here) as one line of text, for a password manager. Anyone with it and a copy of
the workspace can read the masked values: keep it as you would a password.

import reads such a line from the terminal (paste it, then press Enter) or from
a pipe, checks that it is this workspace's key, and saves it in your keychain.
It is never read from the command line, which other programs and your shell
history can see. --allow-key-file saves it in a key file readable only by you
when the keychain cannot be used.`;

export interface KeyArgs {
  action: "export" | "import";
  workspace: string;
  allowKeyFile: boolean;
}

export function parseKeyArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): KeyArgs | { help: string } {
  let action: KeyArgs["action"] | undefined;
  let workspace = path.resolve(env.SF_AGENT_WORKSPACE ?? path.join(cwd, ".sf-agent"));
  let allowKeyFile = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { help: KEY_USAGE };
    // A key passed as an argument would sit in the shell history and the process list.
    if (arg.startsWith("sfpo-key-")) throw new Error("Do not pass the key on the command line: run key import and paste it when asked.");
    if (arg === "--allow-key-file") allowKeyFile = true;
    else if (arg === "--workspace") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--workspace needs a value.\n\n${KEY_USAGE}`);
      workspace = path.resolve(cwd, v);
    } else if ((arg === "export" || arg === "import") && !action) action = arg;
    else if (!arg.startsWith("-") && !action) throw new Error(`Unknown key action "${arg}": use export or import.\n\n${KEY_USAGE}`);
    else throw new Error(`Unknown option "${arg}".\n\n${KEY_USAGE}`);
  }
  if (!action) throw new Error(`Give export or import.\n\n${KEY_USAGE}`);
  if (allowKeyFile && action === "export") throw new Error(`--allow-key-file only goes with import.\n\n${KEY_USAGE}`);
  return { action, workspace, allowKeyFile };
}

export interface KeyIo {
  /** The key line on export: stdout, so that it can be piped to a password manager. */
  out(text: string): void;
  /** Warnings and prompts: stderr, so that they never mix with the key. */
  err(text: string): void;
  /** One line of input: the backup on import. */
  readLine(prompt: string): Promise<string>;
}

/** Runs `key export` or `key import` on a workspace's database; returns the exit code. */
export async function runKey(opts: KeyArgs, io: KeyIo, store?: KeyStore): Promise<number> {
  const { databaseFile } = await import("./startup.js");
  const file = databaseFile(opts.workspace);
  // A missing workspace would otherwise be created, empty, just to say it has no key.
  if (!existsSync(file)) throw new Error(`There is no sf-agent-po workspace in ${opts.workspace} (no ${path.basename(file)}). Use --workspace or SF_AGENT_WORKSPACE to point at it.`);
  const { Database, exportVaultKey, importVaultKey, KeychainUnavailable } = await import("@sf-agent-po/core");
  const database = new Database(file);
  try {
    if (opts.action === "export") {
      const backup = exportVaultKey(database, store);
      io.err("This is the vault key of the workspace. Keep it in a password manager: anyone with it and a copy of the workspace can read the masked values.");
      io.out(backup);
      return 0;
    }
    const backup = (await io.readLine("Paste the key backup (it starts with sfpo-key-), then press Enter: ")).trim();
    if (!backup) throw new Error("No key was given.");
    let saved: ReturnType<typeof importVaultKey>;
    try {
      saved = importVaultKey(database, backup, store, { allowKeyFile: opts.allowKeyFile });
    } catch (err) {
      if (err instanceof KeychainUnavailable && !opts.allowKeyFile) {
        throw new Error(`${err.message}\nFix the keychain and try again, or add --allow-key-file to save the key in a file readable only by you.`);
      }
      throw err;
    }
    io.err(`The key ${saved.keyId} is saved in ${saved.where}.`);
    if (saved.warning) io.err(saved.warning);
    return 0;
  } finally {
    database.close();
  }
}

/** What the server says when it cannot start because this computer does not have the workspace's key. */
export function keyImportHint(workspace: string): string {
  return `To put the key back from your backup, run: npx sf-agent-po@next key import --workspace "${workspace}"`;
}

/** What the server says when it has just made a workspace's key: a lost key cannot be recovered. */
export function keyExportHint(workspace: string): string {
  return `A new masking key was made for the workspace ${workspace}. Back it up now, in a password manager for example: npx sf-agent-po@next key export --workspace "${workspace}"`;
}

/** Reads one line from stdin, prompting on stderr when stdin is a terminal. */
export async function readStdinLine(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  if (process.stdin.isTTY) process.stderr.write(prompt);
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of rl) return line;
    return "";
  } finally {
    rl.close();
  }
}
