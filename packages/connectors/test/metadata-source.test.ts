import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Database, MetadataIndex } from "@sf-agent-po/core";
import { BackgroundIndexer, indexRemote } from "../src/indexing.js";
import { parseRepoSpec, redactLocation, repoSource, resolveMetadataSource } from "../src/metadata-source.js";

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

  it("reads a repository: provider, location and branch, refusing what git could misread", () => {
    expect(parseRepoSpec("github:acme/core")).toEqual({ provider: "github", location: "acme/core" });
    expect(parseRepoSpec("gitlab:acme/sales/core#release/2.1")).toEqual({ provider: "gitlab", location: "acme/sales/core", ref: "release/2.1" });
    expect(parseRepoSpec("azure-devops:https://dev.azure.com/acme/core/_git/sf#main")).toEqual({ provider: "azure-devops", location: "https://dev.azure.com/acme/core/_git/sf", ref: "main" });
    expect(parseRepoSpec("git:git@host.example:acme/sf.git")).toMatchObject({ provider: "git", location: "git@host.example:acme/sf.git" });
    expect(() => parseRepoSpec("bitbucket:acme/core")).toThrow(/"bitbucket" is not one/);
    expect(() => parseRepoSpec("acme/core")).toThrow(/not a repository/);
    expect(() => parseRepoSpec("github:acme")).toThrow(/owner\/repo/);
    expect(() => parseRepoSpec("git:ext::sh -c touch% /tmp/x")).toThrow(/not a clone URL/);
    expect(() => parseRepoSpec("git:--upload-pack=x")).toThrow(/is not a repository/);
    for (const ref of ["-x", "a..b", "HEAD", "main/", "main.lock"]) expect(() => parseRepoSpec(`github:acme/core#${ref}`), ref).toThrow(/branch or tag after #/);
    // Hosts git could read as an option, URLs that do not parse.
    for (const bad of ["ssh://-oProxyCommand=x/y", "ssh://u@-oProxyCommand=x/y", "a@-host:x", "https://host:99999/x"]) expect(() => parseRepoSpec(`git:${bad}`), bad).toThrow(/not a clone URL/);
    // A token in the text is never quoted back, wherever it is.
    const token = ["sec", "ret"].join("");
    for (const text of [`git:http://${token}@host/x`, `azure:https://${token}@dev.azure.com/a`, `git:https://u:ab#${token}@host/x`, `git:https://${token}@host:99999/x`]) {
      expect(() => parseRepoSpec(text), text).toThrow();
      expect(() => parseRepoSpec(text), text).not.toThrow(new RegExp(token));
    }
  });

  it("takes credentials out of a location, also where Node cannot read the URL", () => {
    const token = ["P", "AT9"].join("");
    expect(redactLocation(`https://${token}@host:99999/x`)).toBe("https://host:99999/x");
    expect(redactLocation(`https://gitlab.com/a/b.git?private_token=${token}`)).toBe("https://gitlab.com/a/b.git");
    expect(redactLocation(`clone https://u:${token}@host/x failed`)).toBe("clone https://host/x failed");
  });

  it("names a repository by its name, branch and a hash of where it is, without credentials", () => {
    const a = repoSource(parseRepoSpec("azure-devops:https://dev.azure.com/acme/core/_git/salesforce#main"));
    expect(a).toMatch(/^repo:salesforce@main#[0-9a-f]{8}$/);
    const token = ["P", "AT1"].join("");
    expect(repoSource(parseRepoSpec(`azure-devops:https://${token}@dev.azure.com/acme/core/_git/salesforce#main`))).toBe(a);
    expect(repoSource(parseRepoSpec("github:acme/core"))).toMatch(/^repo:core#[0-9a-f]{8}$/);
    expect(repoSource(parseRepoSpec("github:acme/core"))).not.toBe(repoSource(parseRepoSpec("github:other/core")));
    // GitHub names do not care about case; other servers' may.
    expect(repoSource(parseRepoSpec("github:Acme/Core"))).toBe(repoSource(parseRepoSpec("github:acme/core")).replace("core#", "Core#"));
    expect(repoSource(parseRepoSpec("git:https://h/A/b"))).not.toBe(repoSource(parseRepoSpec("git:https://h/a/b")));
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
    expect(execFileSync("git", ["-C", dest, "log", "--format=%s"]).toString().trim().split(/\r?\n/)).toEqual(["second"]);
    // A folder set has a checkout of its own, beside the repository's.
    const forSet = await resolveMetadataSource(spec, workspace, { checkout: "row" });
    expect(forSet).toBe(`${dest}_row`);
    expect(execFileSync("git", ["-C", forSet, "log", "--format=%s"]).toString().trim()).toBe("second");
    // A force push (history rewritten) is followed too.
    git("commit", "-q", "--amend", "-m", "rewritten");
    await resolveMetadataSource(spec, workspace);
    expect(execFileSync("git", ["-C", dest, "log", "--format=%s"]).toString().trim()).toBe("rewritten");
    // A checkout git cannot use is cloned again.
    rmSync(join(dest, ".git", "HEAD"));
    expect(await resolveMetadataSource(spec, workspace)).toBe(dest);
    expect(execFileSync("git", ["-C", dest, "log", "--format=%s"]).toString().trim()).toBe("rewritten");
    // When the remote cannot be reached, the checkout stays for the next run, and the error says why.
    renameSync(origin, `${origin}-away`);
    try {
      await expect(resolveMetadataSource(spec, workspace)).rejects.toThrow(/Cloning again failed too/);
      expect(execFileSync("git", ["-C", dest, "log", "--format=%s"]).toString().trim()).toBe("rewritten");
    } finally {
      renameSync(`${origin}-away`, origin);
    }
    // Real git processes: Windows runners have taken over 5 s.
  }, 30_000);

  it("keeps repositories whose names differ only by a character a folder name cannot hold apart", async () => {
    const a = join(workspace, "a_b");
    const b = join(workspace, "a-b");
    for (const [dir, file] of [[a, "one"], [b, "two"]] as const) {
      execFileSync("git", ["init", "-q", dir]);
      writeFileSync(join(dir, file), file);
      execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
      execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", file]);
    }
    // Two branches whose names give the same folder characters: release/2 and release_2.
    execFileSync("git", ["-C", a, "branch", "release/2"]);
    execFileSync("git", ["-C", a, "branch", "release_2"]);
    const url = pathToFileURL(a).href;
    const one = await resolveMetadataSource({ provider: "git", location: url, ref: "release/2" }, workspace);
    const two = await resolveMetadataSource({ provider: "git", location: url, ref: "release_2" }, workspace);
    expect(one).not.toBe(two);
    expect(await resolveMetadataSource({ provider: "git", location: pathToFileURL(b).href }, workspace)).not.toBe(one);
  }, 30_000);

  it("indexes a repository, reading again only the files a new commit changed", async () => {
    const origin = join(workspace, "sf-origin");
    const git = (...args: string[]) => execFileSync("git", ["-C", origin, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    execFileSync("git", ["init", "-q", origin]);
    mkdirSync(join(origin, "force-app", "main", "default", "classes"), { recursive: true });
    for (const c of ["A", "B"]) writeFileSync(join(origin, "force-app", "main", "default", "classes", `${c}.cls`), `public class ${c} {}`);
    writeFileSync(join(origin, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }));
    git("add", ".");
    git("commit", "-qm", "init");
    const db = new Database(":memory:");
    try {
      const index = new MetadataIndex(db);
      const spec = `git:${pathToFileURL(origin).href}`;
      const progress: string[] = [];
      const first = await indexRemote(index, spec, { workspace, progress: (m) => progress.push(m) });
      expect(first).toMatchObject({ source: repoSource(parseRepoSpec(spec)), kind: "repo", status: "ready", stats: { counts: { ApexClass: 2 } } });
      expect(first.revision).toBe(git("rev-parse", "HEAD").toString().trim());
      expect(progress[0]).toMatch(/^Cloning /);
      writeFileSync(join(origin, "force-app", "main", "default", "classes", "B.cls"), "public class B { Integer x; }");
      git("commit", "-qam", "change B");
      const second = await indexRemote(index, spec, { workspace });
      expect(second.stats.files).toEqual({ read: 1, reused: first.stats.files!.read - 1 });
      expect(second.revision).toBe(git("rev-parse", "HEAD").toString().trim());

      // The server's indexer takes the same text, and a bad one fails before anything runs.
      const indexer = new BackgroundIndexer(index, { workspace });
      expect(indexer.start({ kind: "remote", repo: spec }).job.target).toBe(first.source);
      await indexer.settle();
      expect(indexer.list()[0]?.state).toBe("ready");
      expect(() => indexer.start({ kind: "remote", repo: "svn:acme" })).toThrow(/is not a repository/);
    } finally {
      db.close();
    }
  }, 60_000);
});
