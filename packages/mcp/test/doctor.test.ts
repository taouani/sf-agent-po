import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ContextRepository, Database, Masker, MetadataIndex, newVaultKey, openVault, Vault, type KeyStore } from "@sf-agent-po/core";
import { ApprovalServer, createServer } from "../src/index.js";
import { DOCTOR_USAGE, formatChecks, parseDoctorArgs, runDoctor, tidyPath, tidyText, type DoctorDeps, type DoctorOptions } from "../src/doctor.js";
import { hostFiles } from "../src/hosts/files.js";
import { databaseFile } from "../src/startup.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sfpo-doctor-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function memoryStore(): KeyStore {
  const keys = new Map<string, Buffer>();
  return { name: "the test keychain", get: (i) => keys.get(i), set: (i, k) => (keys.set(i, Buffer.from(k)), { where: "memory" }) };
}

const ORG_ID = "00D5g000000AbCdEAF";

// Built at run time, so that no token-shaped literal sits in the repository.
const TOKEN = ["tok", "en", "-", "x".repeat(20)].join("");

function deps(home: string, over: Partial<DoctorDeps> = {}): DoctorDeps & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    env: { PATH: "", SF_AGENT_PO_MODEL_DIR: path.join(home, "models") },
    platform: "linux",
    nodeVersion: "24.11.0",
    home,
    keyStore: memoryStore,
    keyTool: () => ({ name: "secret-tool", present: false }),
    runtimePresent: () => true,
    loadModel: async () => ({ detect: async () => [{ start: 0, end: 15, type: "PERSON", source: "ner" as const }], stats: { tokens: 0, unaligned: 0 }, release: async () => {} }),
    fetch: (async (url: string | URL | Request) => {
      fetched.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    run: async (cmd) => {
      if (cmd === "git") return { stdout: "git version 2.43.0\n" };
      throw new Error(`Command "${cmd}" was not found. Install it and make sure it is on PATH.`);
    },
    sf: async () => ({
      nonScratchOrgs: [{ username: "a@b.c", alias: "uat", orgId: ORG_ID, connectedStatus: "Connected" }],
      scratchOrgs: [{ username: "s@b.c", status: "Active", isExpired: false }],
    }),
    now: () => new Date("2026-11-10T12:00:00Z"),
    ...over,
  };
}

const byCheck = (results: Awaited<ReturnType<typeof runDoctor>>, check: string) => results.filter((r) => r.check === check);

describe("doctor", () => {
  it("reads its options", () => {
    const cwd = path.resolve("/work");
    expect(parseDoctorArgs([], {}, cwd)).toEqual({ workspace: path.join(cwd, ".sf-agent"), project: cwd, atlassianCalls: true });
    expect(parseDoctorArgs(["--no-calls", "--dir", "p", "--workspace", "w"], {}, cwd)).toEqual({ workspace: path.join(cwd, "w"), project: path.join(cwd, "p"), atlassianCalls: false });
    expect(parseDoctorArgs([], { SF_AGENT_WORKSPACE: "ws" }, cwd)).toMatchObject({ workspace: path.join(cwd, "ws") });
    expect(parseDoctorArgs(["-h"], {}, cwd)).toEqual({ help: DOCTOR_USAGE });
    expect(() => parseDoctorArgs(["--fix"], {}, cwd)).toThrow(/Unknown option "--fix"/);
    expect(() => parseDoctorArgs(["--dir"], {}, cwd)).toThrow(/--dir needs a value/);
  });

  it("shows the home folder as ~", () => {
    const home = path.resolve("/home/tarek");
    expect(tidyPath(path.join(home, "p", ".sf-agent"), home)).toBe(path.join("~", "p", ".sf-agent"));
    expect(tidyPath(home, home)).toBe("~");
    expect(tidyPath(path.resolve("/srv/x"), home)).toBe(path.resolve("/srv/x"));
  });

  it("warns on a new machine, and says what to do for each check", async () => {
    const home = tempDir();
    const project = path.join(home, "proj");
    const opts: DoctorOptions = { workspace: path.join(project, ".sf-agent"), project, atlassianCalls: true, model: "load" };
    const results = await runDoctor(opts, deps(home));
    expect(byCheck(results, "Node")[0]).toMatchObject({ level: "pass", detail: "Node 24.11.0" });
    expect(byCheck(results, "Workspace")[0]).toMatchObject({ level: "warn", detail: expect.stringContaining(path.join("~", "proj", ".sf-agent")) });
    // No workspace was created to check it.
    expect(() => new Database(databaseFile(opts.workspace), [], { readOnly: true })).toThrow();
    expect(byCheck(results, "Masking key")[0]).toMatchObject({ level: "warn", detail: expect.stringContaining("secret-tool is not installed") });
    expect(byCheck(results, "Name model")[0]).toMatchObject({ level: "warn", detail: expect.stringContaining("not downloaded yet") });
    expect(byCheck(results, "Salesforce CLI")[0]).toMatchObject({ level: "pass", detail: "sf is logged in to 2 org(s), all connected." });
    expect(byCheck(results, "Jira and Confluence")[0]).toMatchObject({ level: "warn" });
    expect(byCheck(results, "git")[0]).toMatchObject({ level: "pass", detail: "git version 2.43.0" });
    expect(byCheck(results, "gh")[0]).toMatchObject({ level: "warn", fix: expect.stringContaining("cli.github.com") });
    expect(byCheck(results, "AI tool files")[0]).toMatchObject({ level: "warn", fix: expect.stringContaining("init --host") });
    expect(byCheck(results, "Metadata index")).toEqual([]);
    for (const r of results.filter((r) => r.level !== "pass")) expect(r.fix, r.check).toBeTruthy();
    const text = formatChecks(results);
    expect(text).not.toContain(home);
    expect(text).not.toContain("a@b.c");
    expect(text).toMatch(/\d+ passed, \d+ warning\(s\), 0 failed\.$/);
  });

  it("checks a set-up workspace: key, model, host files, index age, and the Atlassian calls", async () => {
    const home = tempDir();
    const project = path.join(home, "proj");
    const workspace = path.join(project, ".sf-agent");
    const store = memoryStore();
    mkdirSync(workspace, { recursive: true });
    const db = new Database(databaseFile(workspace));
    openVault(db, store);
    const index = new MetadataIndex(db);
    await index.build({ source: `org:${ORG_ID}`, kind: "org" }, async () => ({ components: [], edges: [], skipped: [] }) as never);
    await index.build({ source: "repo:proj#abcd1234", kind: "repo" }, async () => ({ components: [], edges: [], skipped: [] }) as never);
    db.close();
    for (const [i, f] of hostFiles("claude-code").entries()) {
      mkdirSync(path.dirname(path.join(project, f.path)), { recursive: true });
      // One edited, one with CRLF line ends as a Windows checkout has them (the same file).
      writeFileSync(path.join(project, f.path), i === 0 ? "edited" : i === 1 ? f.content.replace(/\n/g, "\r\n") : f.content);
    }
    // A command an earlier version wrote for Cursor, which a skill now replaces.
    mkdirSync(path.join(project, ".cursor/commands"), { recursive: true });
    writeFileSync(path.join(project, ".cursor/commands/po-review.md"), "old");
    const { DEFAULT_MODEL } = await import("@sf-agent-po/core");
    const modelDir = path.join(home, "models", DEFAULT_MODEL.id, DEFAULT_MODEL.revision);
    for (const f of Object.values(DEFAULT_MODEL.files)) {
      mkdirSync(path.dirname(path.join(modelDir, f.path)), { recursive: true });
      writeFileSync(path.join(modelDir, f.path), Buffer.alloc(f.size));
    }
    const calls: string[] = [];
    const d = deps(home, {
      keyStore: () => store,
      env: { PATH: "", SF_AGENT_PO_MODEL_DIR: path.join(home, "models"), ATLASSIAN_SITE_URL: "https://x.atlassian.net", ATLASSIAN_EMAIL: "me@x.com", ATLASSIAN_API_TOKEN: TOKEN },
      fetch: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return String(url).includes("/wiki/") ? new Response("no", { status: 401 }) : new Response("{}", { status: 200 });
      }) as typeof fetch,
      now: () => new Date(Date.now() + 9 * 86_400_000),
    });
    const results = await runDoctor({ workspace, project, atlassianCalls: true, model: "load" }, d);
    expect(byCheck(results, "Workspace")[0]).toMatchObject({ level: "pass", detail: expect.stringContaining("0 context(s)") });
    expect(byCheck(results, "Masking key")[0]).toMatchObject({ level: "pass", detail: expect.stringContaining("is in the test keychain") });
    expect(byCheck(results, "Name model")[0]).toMatchObject({ level: "pass", detail: expect.stringContaining("finds the name") });
    expect(byCheck(results, "Jira and Confluence").map((r) => r.level)).toEqual(["pass", "fail"]);
    expect(calls).toEqual(["https://x.atlassian.net/rest/api/3/myself", "https://x.atlassian.net/wiki/api/v2/spaces?limit=1"]);
    expect(byCheck(results, "AI tool files")).toEqual([
      expect.objectContaining({ level: "warn", detail: expect.stringContaining("1 from another version or edited") }),
      expect.objectContaining({ level: "warn", detail: expect.stringMatching(/^cursor: 1 file\(s\) from an earlier version/), fix: "Delete .cursor/commands/po-review.md, so your AI tool does not offer both." }),
    ]);
    expect(byCheck(results, "Metadata index")).toEqual([
      expect.objectContaining({ level: "warn", detail: `repo:proj#abcd1234 was indexed 9 day(s) ago.`, fix: expect.stringContaining("index --project <its folder>") }),
      expect.objectContaining({ level: "warn", detail: `org:${ORG_ID} (uat) was indexed 9 day(s) ago.`, fix: expect.stringContaining("index --org uat") }),
    ]);
    expect(formatChecks(results)).not.toContain(TOKEN);

    // Another computer: the key is missing, and the fix names key import.
    const other = await runDoctor({ workspace, project, atlassianCalls: false, model: "files" }, deps(home, { env: d.env }));
    expect(byCheck(other, "Masking key")[0]).toMatchObject({ level: "fail", fix: expect.stringContaining("key import --workspace") });
    expect(byCheck(other, "Jira and Confluence")[0]).toMatchObject({ level: "pass", detail: expect.stringContaining("not called from the server") });
    expect(byCheck(other, "Name model")[0]).toMatchObject({ level: "pass", detail: expect.stringContaining("loads it on first use") });
  });

  it("fails clearly: old Node, a half-set Atlassian config, huggingface.co out of reach, a broken sf", async () => {
    const home = tempDir();
    const d = deps(home, {
      nodeVersion: "22.3.0",
      env: { PATH: "", SF_AGENT_PO_MODEL_DIR: path.join(home, "models"), ATLASSIAN_EMAIL: "me@x.com" },
      fetch: (async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND huggingface.co"), { code: "ENOTFOUND" }) });
      }) as typeof fetch,
      sf: async () => {
        throw new Error("sf org list failed: boom");
      },
    });
    const results = await runDoctor({ workspace: path.join(home, "w"), project: home, atlassianCalls: true, model: "load" }, d);
    expect(byCheck(results, "Node")[0]).toMatchObject({ level: "fail" });
    expect(byCheck(results, "Jira and Confluence")[0]).toMatchObject({ level: "fail", detail: "ATLASSIAN_SITE_URL and ATLASSIAN_API_TOKEN are not set in this shell." });
    expect(byCheck(results, "Name model")[0]).toMatchObject({ level: "fail", detail: expect.stringContaining("ENOTFOUND"), fix: expect.stringContaining("HTTPS_PROXY") });
    expect(byCheck(results, "Salesforce CLI")[0]).toMatchObject({ level: "fail", detail: "sf org list failed: boom" });
    expect(formatChecks(results)).toMatch(/FAIL {2}Node: Node 22\.3\.0.*\n {6}Fix: Install Node 24/);
  });

  it("keeps the home folder, emails and address passwords out of any message", () => {
    expect(tidyText("open C:/Users/Tarek/p and c:\\users\\tarek\\q and \"C:\\\\Users\\\\Tarek\\\\r\"", "C:\\Users\\Tarek", "win32")).toBe('open ~/p and ~\\q and "~\\\\r"');
    expect(tidyText("/home/al/x and /home/alice/y", "/home/al", "linux")).toBe("~/x and /home/alice/y");
    expect(tidyText("/HOME/al/x", "/home/al", "linux")).toBe("/HOME/al/x");
    expect(tidyText("sf failed for tarek.a+uat@acme.example.com at https://me:pw@x.example.com/", "/h", "linux")).toBe("sf failed for <email> at https://x.example.com/");
    expect(formatChecks([{ check: "x", level: "warn", detail: "a\nb", fix: "c" }])).toContain("WARN  x: a\n      b\n      Fix: c");
  });

  it("tells a missing sf on Windows, an unreadable database and an older workspace apart", async () => {
    const home = tempDir();
    const missing = await runDoctor(
      { workspace: path.join(home, "w"), project: home, atlassianCalls: false, model: "files" },
      deps(home, {
        platform: "win32",
        sf: async () => {
          throw new Error("sf org list failed: 'sf' is not recognized as an internal or external command, operable program or batch file.");
        },
      }),
    );
    expect(byCheck(missing, "Salesforce CLI")[0]).toMatchObject({ level: "warn", detail: expect.stringContaining("not installed") });

    const broken = path.join(home, "broken");
    mkdirSync(broken);
    writeFileSync(databaseFile(broken), "not a database at all, but long enough to be read as one ".repeat(20));
    const bad = await runDoctor({ workspace: broken, project: home, atlassianCalls: false, model: "files" }, deps(home));
    expect(byCheck(bad, "Workspace")[0]!.level).toBe("fail");
    expect(byCheck(bad, "Masking key")[0]).toMatchObject({ level: "warn", detail: expect.stringContaining("Not checked") });

    const older = path.join(home, "older");
    mkdirSync(older);
    const db = new Database(databaseFile(older));
    db.db.exec("DELETE FROM schema_migration WHERE version = (SELECT max(version) FROM schema_migration)");
    db.close();
    const old = await runDoctor({ workspace: older, project: home, atlassianCalls: false, model: "files" }, deps(home));
    expect(byCheck(old, "Workspace")[0]).toMatchObject({ level: "warn", fix: expect.stringContaining("upgrades it") });
    expect(byCheck(old, "Metadata index")).toEqual([]);
  });

  it("is offered to the model as server_status when the server has the checks", async () => {
    const db = new Database(":memory:");
    const approval = new ApprovalServer();
    const base = { contexts: new ContextRepository(db), masker: new Masker({ vault: new Vault(db, newVaultKey()) }), approval, recognizer: async () => Promise.reject(new Error("no OCR")), version: "1.0.0" };
    const tools = async (server: ReturnType<typeof createServer>) => {
      const client = new Client({ name: "test", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      return client;
    };
    try {
      const without = await tools(createServer(base));
      expect((await without.listTools()).tools.map((t) => t.name)).not.toContain("server_status");
      await without.close();
      const client = await tools(createServer({ ...base, status: async () => "FAIL  Salesforce CLI: sf failed for sarah.whitfield@acme.example.com" }));
      const r = (await client.callTool({ name: "server_status", arguments: {} })) as { content: { text: string }[] };
      // Masked like any input before the model sees it.
      expect(r.content[0]!.text).toMatch(/^FAIL {2}Salesforce CLI: sf failed for \[EMAIL_1\]$/);
      await client.close();
    } finally {
      await approval.close();
      db.close();
    }
  });
});
