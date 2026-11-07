import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspace } from "../src/startup.js";

describe("ensureWorkspace", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("creates the workspace with a .gitignore that keeps all of it out of git, and keeps one the user changed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-agent-ws-"));
    dirs.push(root);
    const ws = path.join(root, ".sf-agent");
    ensureWorkspace(ws);
    expect(readFileSync(path.join(ws, ".gitignore"), "utf8")).toMatch(/^\*$/m);
    writeFileSync(path.join(ws, ".gitignore"), "mine\n");
    ensureWorkspace(ws);
    expect(readFileSync(path.join(ws, ".gitignore"), "utf8")).toBe("mine\n");
  });

  it("never writes one into a folder the user pointed the workspace at", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-agent-ws-"));
    dirs.push(root);
    // An existing folder of another name: perhaps a repository root, perhaps a shared folder.
    ensureWorkspace(root);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
    // A repository, even one named .sf-agent.
    const repo = path.join(root, "repo", ".sf-agent");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    ensureWorkspace(repo);
    expect(existsSync(path.join(repo, ".gitignore"))).toBe(false);
    // A new folder of any name is ours.
    ensureWorkspace(path.join(root, "new-ws"));
    expect(existsSync(path.join(root, "new-ws", ".gitignore"))).toBe(true);
  });
});
