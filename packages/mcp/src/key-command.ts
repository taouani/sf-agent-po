// `sf-agent-po key`: backs up the vault key of a workspace, or puts a backup back. Without
// the key, masked documents keep their pseudonyms and nothing can be published with real
// values (risk 8 of the v1 plan).

import { existsSync } from "node:fs";
import path from "node:path";
import type { KeyStore } from "@sf-agent-po/core";

export const KEY_USAGE = `Usage: npx sf-agent-po@next key export [--workspace <folder>] [--to-pipe]
       npx sf-agent-po@next key import [--workspace <folder>] [--allow-key-file]

export prints the vault key of the workspace (SF_AGENT_WORKSPACE, else .sf-agent
here) as one line of text, for a password manager. Anyone with it and a copy of
the workspace can read the masked values: keep it as you would a password. It
only prints to a terminal, so that an AI agent running commands cannot read it;
add --to-pipe to send it to another program, such as a password manager's CLI.

import reads such a line from the terminal (paste it, then press Enter; it is
not shown) or from a pipe, checks that it is this workspace's key, and saves it
in your keychain. It is never read from the command line, which other programs
and your shell history can see. --allow-key-file saves it in a key file
readable only by you when the keychain cannot be used.`;

export interface KeyArgs {
  action: "export" | "import";
  workspace: string;
  allowKeyFile: boolean;
  /** Export to a pipe or a file, not only to a terminal. */
  toPipe?: boolean;
}

/** A key backup: never echoed, never taken from the arguments. */
const KEY_SHAPED = /sfpo-key-/i;

export function parseKeyArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): KeyArgs | { help: string } {
  // A key passed as an argument would sit in the shell history and the process list, and
  // an error that quotes it would show it again: every word is checked, values included.
  if (argv.some((a) => KEY_SHAPED.test(a))) throw new Error("Do not pass the key on the command line: run key import and paste it when asked.");
  let action: KeyArgs["action"] | undefined;
  // Resolved like the server's: a relative SF_AGENT_WORKSPACE is taken from the folder it runs in.
  let workspace = path.resolve(cwd, env.SF_AGENT_WORKSPACE ?? ".sf-agent");
  let allowKeyFile = false;
  let toPipe = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { help: KEY_USAGE };
    if (arg === "--allow-key-file") allowKeyFile = true;
    else if (arg === "--to-pipe") toPipe = true;
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
  if (toPipe && action === "import") throw new Error(`--to-pipe only goes with export.\n\n${KEY_USAGE}`);
  return { action, workspace, allowKeyFile, ...(toPipe ? { toPipe } : {}) };
}

export interface KeyIo {
  /** The key line on export: stdout, so that it can be piped to a password manager. */
  out(text: string): void;
  /** Whether `out` goes to a terminal, which an agent running the command cannot read. */
  outIsTerminal: boolean;
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
  const { Database, exportVaultKey, importVaultKey, KeychainUnavailable, MIGRATIONS } = await import("@sf-agent-po/core");
  if (opts.action === "export" && !io.outIsTerminal && !opts.toPipe) {
    throw new Error("The key is only printed to a terminal, so that an AI agent running commands cannot read it. To send it to another program, add --to-pipe.");
  }
  // Read-only: the key is read or written in the key store, never in the database, and a
  // newer version than the server's must not migrate the workspace under it.
  const database = new Database(file, MIGRATIONS, { readOnly: true });
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

/** A path as one shell word: as it is when it needs no quotes, else quoted for this OS's shell. */
export function shellWord(p: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[\w@%+=:,./\\-]+$/.test(p)) return p;
  return platform === "win32" ? `"${p}"` : `'${p.replaceAll("'", "'\\''")}'`;
}

/** What the server says when it cannot start because this computer does not have the workspace's key. */
export function keyImportHint(workspace: string, platform: NodeJS.Platform = process.platform): string {
  return `To put the key back from your backup, run: npx sf-agent-po@next key import --workspace ${shellWord(workspace, platform)}`;
}

/** What the server says when it has just made a workspace's key: a lost key cannot be recovered. */
export function keyExportHint(workspace: string, platform: NodeJS.Platform = process.platform): string {
  return `A new masking key was made for the workspace ${workspace}. Back it up now, in a password manager for example: npx sf-agent-po@next key export --workspace ${shellWord(workspace, platform)}`;
}

/**
 * Reads the backup from stdin: from a terminal without showing it (it would stay in the
 * scrollback, a recording or a shared screen), from a pipe as its first line with text.
 */
export async function readStdinLine(prompt: string): Promise<string> {
  if (process.stdin.isTTY) return readHidden(prompt, process.stdin, process.stderr);
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of rl) if (line.trim()) return line;
    return "";
  } finally {
    rl.close();
  }
}

/** The input a hidden read needs: a terminal stream that can stop echoing. */
export interface HiddenInput extends NodeJS.EventEmitter {
  setRawMode(raw: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
}

/** Reads one line from a terminal in raw mode, so that nothing typed or pasted is echoed. */
export function readHidden(prompt: string, input: HiddenInput, output: { write(text: string): unknown }): Promise<string> {
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let text = "";
    const done = (err?: Error) => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (err) reject(err);
      else resolve(text);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") return done(new Error("Stopped."));
        // Enter ends the line once it has text, so that a paste starting with a newline still works.
        if (ch === "\r" || ch === "\n") {
          if (text.trim()) return done();
          continue;
        }
        if (ch === "\u0004") return done();
        if (ch === "\u007f" || ch === "\b") text = text.slice(0, -1);
        else if (ch >= " ") text += ch;
      }
    };
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
