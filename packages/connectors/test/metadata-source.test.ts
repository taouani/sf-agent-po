import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { redactLocation, resolveMetadataSource } from "../src/metadata-source.js";

describe("metadata sources", () => {
  it("strips credentials from clone URLs", () => {
    expect(redactLocation("https://PAT123@dev.azure.com/acme/core/_git/salesforce")).toBe("https://dev.azure.com/acme/core/_git/salesforce");
    expect(redactLocation("https://user:secret@gitlab.com/acme/core.git")).toBe("https://gitlab.com/acme/core.git");
    expect(redactLocation("acme/core")).toBe("acme/core");
  });

  it("refuses option-like locations before running any CLI", async () => {
    await expect(resolveMetadataSource({ provider: "git", location: "--upload-pack=x" }, "/tmp/unused")).rejects.toThrow(/must not start with "-"/);
    await expect(resolveMetadataSource({ provider: "gitlab", location: "acme/core", ref: "-x" }, "/tmp/unused")).rejects.toThrow(/must not start with "-"/);
  });

  it("uses a local folder as it is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-agent-local-"));
    try {
      expect(await resolveMetadataSource({ provider: "local", location: dir }, "/tmp/unused")).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const workspace = mkdtempSync(join(tmpdir(), "sf-agent-git-"));
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  it("clones a git repository, then pulls it on the next call", async () => {
    const origin = join(workspace, "origin");
    const git = (...args: string[]) => execFileSync("git", ["-C", origin, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    execFileSync("git", ["init", "-q", origin]);
    writeFileSync(join(origin, "sfdx-project.json"), "{}");
    git("add", ".");
    git("commit", "-qm", "init");
    const spec = { provider: "git" as const, location: pathToFileURL(origin).href };

    const dest = await resolveMetadataSource(spec, workspace);
    expect(dest.startsWith(join(workspace, "repos"))).toBe(true);
    writeFileSync(join(origin, "README.md"), "new");
    git("add", ".");
    git("commit", "-qm", "second");
    expect(await resolveMetadataSource(spec, workspace)).toBe(dest);
    expect(execFileSync("git", ["-C", dest, "log", "--format=%s"]).toString().trim().split(/\r?\n/)).toEqual(["second", "init"]);
    // Real git processes: Windows runners have taken over 5 s.
  }, 30_000);
});
