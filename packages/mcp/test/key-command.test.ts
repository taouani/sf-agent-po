import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database, KeychainUnavailable, openVault, type KeyStore } from "@sf-agent-po/core";
import { KEY_USAGE, keyExportHint, keyImportHint, parseKeyArgs, runKey, type KeyIo } from "../src/key-command.js";
import { databaseFile } from "../src/startup.js";

/** An in-memory key store, so that no test touches the real keychain. */
function memoryStore(): KeyStore & { keys: Map<string, Buffer> } {
  const keys = new Map<string, Buffer>();
  return { name: "memory", keys, get: (i) => keys.get(i), set: (i, k) => (keys.set(i, Buffer.from(k)), { where: "memory", warning: "a test warning" }) };
}

function io(input = ""): KeyIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (t) => stdout.push(t), err: (t) => stderr.push(t), readLine: async () => input };
}

const dirs: string[] = [];
function workspace(store: KeyStore): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sfpo-key-"));
  dirs.push(dir);
  const db = new Database(databaseFile(dir));
  openVault(db, store).vault.pseudonym("acme", "PERSON", "Sarah Whitfield");
  db.close();
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("key command", () => {
  const cwd = path.resolve("/work");
  it("reads the action and the workspace", () => {
    expect(parseKeyArgs(["export"], {}, cwd)).toEqual({ action: "export", workspace: path.join(cwd, ".sf-agent"), allowKeyFile: false });
    expect(parseKeyArgs(["import", "--allow-key-file", "--workspace", "w"], { SF_AGENT_WORKSPACE: "/ws" }, cwd)).toEqual({
      action: "import",
      workspace: path.join(cwd, "w"),
      allowKeyFile: true,
    });
    expect(parseKeyArgs(["import"], { SF_AGENT_WORKSPACE: "/ws" }, cwd)).toMatchObject({ workspace: path.resolve("/ws") });
    expect(parseKeyArgs(["--help"], {}, cwd)).toEqual({ help: KEY_USAGE });
  });

  it("refuses a missing action, unknown words, and a key on the command line", () => {
    expect(() => parseKeyArgs([], {}, cwd)).toThrow(/Give export or import/);
    expect(() => parseKeyArgs(["show"], {}, cwd)).toThrow(/Unknown key action "show"/);
    expect(() => parseKeyArgs(["export", "--force"], {}, cwd)).toThrow(/Unknown option "--force"/);
    expect(() => parseKeyArgs(["export", "--allow-key-file"], {}, cwd)).toThrow(/only goes with import/);
    expect(() => parseKeyArgs(["import", "--workspace"], {}, cwd)).toThrow(/--workspace needs a value/);
    // Before or after the action, a key in the arguments is refused and never echoed.
    for (const argv of [["import", "sfpo-key-1-abc"], ["sfpo-key-1-abc"]]) {
      expect(() => parseKeyArgs(argv, {}, cwd)).toThrow(/Do not pass the key on the command line/);
      try {
        parseKeyArgs(argv, {}, cwd);
      } catch (err) {
        expect((err as Error).message).not.toContain("abc");
      }
    }
  });

  it("exports the key on stdout and the warning on stderr, and imports it on another machine", async () => {
    const home = memoryStore();
    const dir = workspace(home);
    const out = io();
    expect(await runKey({ action: "export", workspace: dir, allowKeyFile: false }, out, home)).toBe(0);
    expect(out.stdout).toHaveLength(1);
    expect(out.stdout[0]).toMatch(/^sfpo-key-1-[A-Za-z0-9_-]{43}$/);
    expect(out.stderr.join("\n")).toMatch(/password manager/);
    expect(out.stderr.join("\n")).not.toContain(out.stdout[0]);

    const laptop = memoryStore();
    const back = io(`  ${out.stdout[0]}  `);
    expect(await runKey({ action: "import", workspace: dir, allowKeyFile: false }, back, laptop)).toBe(0);
    expect(laptop.keys.size).toBe(1);
    expect(back.stderr.join("\n")).toMatch(/is saved in memory/);
    expect(back.stderr.join("\n")).toMatch(/a test warning/);
    const db = new Database(databaseFile(dir));
    try {
      expect(openVault(db, laptop).vault.reveal("acme", "[PERSON_1]")).toBe("Sarah Whitfield");
    } finally {
      db.close();
    }
  });

  it("refuses another workspace's key, empty input, and a folder with no workspace", async () => {
    const store = memoryStore();
    const a = workspace(store);
    const b = workspace(store);
    const out = io();
    await runKey({ action: "export", workspace: b, allowKeyFile: false }, out, store);
    await expect(runKey({ action: "import", workspace: a, allowKeyFile: false }, io(out.stdout[0]), memoryStore())).rejects.toThrow(/was written with the key with id/);
    await expect(runKey({ action: "import", workspace: a, allowKeyFile: false }, io("  "), memoryStore())).rejects.toThrow(/No key was given/);
    const empty = mkdtempSync(path.join(tmpdir(), "sfpo-key-"));
    dirs.push(empty);
    await expect(runKey({ action: "export", workspace: empty, allowKeyFile: false }, io(), store)).rejects.toThrow(/There is no sf-agent-po workspace/);
    // Nothing was created in the empty folder.
    await expect(runKey({ action: "export", workspace: empty, allowKeyFile: false }, io(), store)).rejects.toThrow(/There is no sf-agent-po workspace/);
  });

  it("names --allow-key-file when the keychain is down, and the commands in the server's hints", async () => {
    const home = memoryStore();
    const dir = workspace(home);
    const out = io();
    await runKey({ action: "export", workspace: dir, allowKeyFile: false }, out, home);
    const down: KeyStore = {
      name: "the test keychain",
      get: () => undefined,
      set: (_i, _k, o) => {
        if (o?.fallback === false) throw new KeychainUnavailable("the test keychain", "locked");
        return { where: "a key file" };
      },
    };
    await expect(runKey({ action: "import", workspace: dir, allowKeyFile: false }, io(out.stdout[0]), down)).rejects.toThrow(/locked\n.*--allow-key-file/);
    const back = io(out.stdout[0]);
    expect(await runKey({ action: "import", workspace: dir, allowKeyFile: true }, back, down)).toBe(0);
    expect(back.stderr.join("\n")).toMatch(/saved in a key file/);
    expect(keyImportHint("/w s")).toContain('key import --workspace "/w s"');
    expect(keyExportHint("/w s")).toContain('key export --workspace "/w s"');
  });
});
