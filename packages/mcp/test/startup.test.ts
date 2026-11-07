import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
