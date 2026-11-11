// `sf-agent-po doctor`: checks what the server needs, one line per check, each with the fix.
// The output never shows a token, a username or a value from the vault, and the home folder
// shows as ~, so that it can be pasted into a GitHub issue. The `server_status` tool runs the
// same checks from inside the server, without the Atlassian calls.

import { existsSync, statSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Database, DetectionModel, KeyStore } from "@sf-agent-po/core";
import { hostFiles, HOSTS, type Host } from "./hosts/files.js";

export const DOCTOR_USAGE = `Usage: npx sf-agent-po@next doctor [--workspace <folder>] [--dir <project folder>] [--no-calls]

Checks Node, the workspace (SF_AGENT_WORKSPACE, else .sf-agent here), its masking key,
the name detection model, the sf CLI and its orgs, the Jira and Confluence settings,
git, gh and glab, the AI tool files in the project folder (--dir, else here) and the
age of each metadata index. --no-calls skips the calls to Jira and Confluence.
The output shows no token, username or masked value, and ~ for your home folder.`;

export type Level = "pass" | "warn" | "fail";

export interface CheckResult {
  check: string;
  level: Level;
  detail: string;
  /** What to do about a warn or a fail. */
  fix?: string;
}

export interface DoctorOptions {
  workspace: string;
  /** The project folder whose AI tool files are checked. */
  project: string;
  /** Whether to call Jira and Confluence; the server does not. */
  atlassianCalls: boolean;
  /** "load" runs the model on a test sentence; "files" only checks its files, for a server that has its own. */
  model: "load" | "files";
  /** The server's open database, so that the checks do not open a second one. */
  database?: Database;
  /** Whether the server already loaded the model. */
  modelLoaded?: boolean;
  /** Whether the server opened the vault with its key, so that the keychain need not be asked again. */
  keyLoaded?: boolean;
}

/** A command's output, or an error when it is missing or fails. */
export type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  nodeVersion: string;
  home: string;
  keyStore: () => KeyStore;
  /** Whether the package's model runtime (WebAssembly) is there. */
  runtimePresent: () => boolean;
  /** The program this OS keeps the key with, and whether it is installed. */
  keyTool: () => { name: string; present: boolean };
  loadModel: () => Promise<DetectionModel>;
  fetch: typeof fetch;
  run: Runner;
  /** `sf <args> --json`, returning its result. */
  sf: (args: string[]) => Promise<unknown>;
  now: () => Date;
}

export async function defaultDoctorDeps(): Promise<DoctorDeps> {
  const { loadDetectionModel, SECURITY, secretToolPath, systemKeyStore, VENDORED_RUNTIME, windowsPowerShell } = await import("@sf-agent-po/core");
  const { defaultSfRunner, run } = await import("@sf-agent-po/connectors");
  return {
    env: process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    home: homedir(),
    keyStore: () => systemKeyStore(),
    runtimePresent: () => existsSync(VENDORED_RUNTIME),
    // The paths the key store itself uses, not PATH, which it never searches.
    keyTool: () =>
      process.platform === "darwin"
        ? { name: "security", present: existsSync(SECURITY) }
        : process.platform === "win32"
          ? { name: "Windows PowerShell", present: existsSync(windowsPowerShell()) }
          : { name: "secret-tool", present: secretToolPath() !== undefined },
    loadModel: () => loadDetectionModel(),
    fetch,
    run: (cmd, args) => run(cmd, args, { timeoutMs: 15_000 }),
    sf: (args) => defaultSfRunner(args, { timeoutMs: 60_000 }),
    now: () => new Date(),
  };
}

/** A path with the home folder as ~, so that the user name does not show. */
export function tidyPath(p: string, home: string): string {
  if (!home) return p;
  const rel = path.relative(home, p);
  if (rel === "") return "~";
  return rel.startsWith("..") || path.isAbsolute(rel) ? p : path.join("~", rel);
}

/**
 * Every text a check shows, with the home folder as ~ even inside an error message (in any
 * separator, JSON-escaped, and in any case on Windows), and no email address or password in
 * an address: a CLI's error can quote a username.
 */
export function tidyText(text: string, home: string, platform: NodeJS.Platform = process.platform): string {
  let out = text;
  if (home && home.length > 1) {
    const parts = home.split(/[\\/]+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const lead = /^[\\/]/.test(home) ? "[\\\\/]+" : "";
    const pattern = new RegExp(`${lead}${parts.join("(?:[\\\\/]+)")}(?=$|[\\\\/"'\\s:;,)\\]])`, platform === "win32" ? "gi" : "g");
    out = out.replace(pattern, "~");
  }
  return out.replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>");
}

/** The reasons Node gives for a failed request, from the error and its causes. */
function reason(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const { message, code, cause } = e as { message?: unknown; code?: unknown; cause?: unknown };
    for (const p of [message, code]) if (typeof p === "string" && p && !parts.some((q) => q.includes(p))) parts.push(p);
    e = cause;
  }
  return parts.join(": ") || "unknown error";
}

/** Runs the checks in order; a check that throws is a fail, and the others still run. */
export async function runDoctor(opts: DoctorOptions, deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const step = async (check: string, fn: () => Promise<Omit<CheckResult, "check"> | Omit<CheckResult, "check">[]>) => {
    try {
      const out = await fn();
      for (const r of Array.isArray(out) ? out : [out]) results.push({ check, ...r });
    } catch (err) {
      results.push({ check, level: "fail", detail: (err as Error).message });
    }
  };

  await step("Node", async () => nodeCheck(deps.nodeVersion, deps.env));
  const { databaseFile } = await import("./startup.js");
  const file = databaseFile(opts.workspace);
  let database = opts.database;
  let opened = false;
  /** Whether the workspace's tables are this version's: an older workspace is read as far as it goes. */
  let current = true;
  /** Whether the database could be read at all. */
  let readable = false;
  await step("Workspace", async () => {
    if (!database && !existsSync(file)) {
      return {
        level: "warn",
        detail: `No workspace in ${tidyPath(opts.workspace, deps.home)} yet. The server makes it when it first starts there.`,
        fix: "Run doctor from the folder the server starts in, or give it the server's SF_AGENT_WORKSPACE with --workspace.",
      };
    }
    const { Database, MIGRATIONS } = await import("@sf-agent-po/core");
    if (!database) {
      // Read-only: doctor must not migrate a workspace its server has not upgraded yet.
      database = new Database(file, MIGRATIONS, { readOnly: true });
      opened = true;
    }
    const checked = await workspaceCheck(database, opts, deps.home);
    current = checked.current;
    readable = checked.readable ?? false;
    return checked.result;
  });
  try {
    await step("Masking key", async () =>
      (database || existsSync(file)) && !readable
        ? { level: "warn", detail: "Not checked: the workspace database could not be opened.", fix: "Fix the workspace first (see above), then run doctor again." }
        : keyCheck(database, opts, deps),
    );
  } finally {
    if (opened) database?.close();
  }
  await step("Name model", async () => modelCheck(opts, deps));
  /** Each logged-in org's alias by org id, to name the org a snapshot was read from. */
  const orgs = new Map<string, string>();
  await step("Salesforce CLI", async () => sfCheck(deps, orgs));
  await step("Jira and Confluence", async () => atlassianCheck(opts.atlassianCalls, deps));
  for (const tool of TOOLS) await step(tool.cmd, async () => toolCheck(tool, deps));
  await step("AI tool files", async () => hostFilesCheck(opts.project, deps.home));
  await step("Metadata index", async () => (current ? indexCheck(opts, file, deps, orgs) : []));
  return results.map((r) => ({ ...r, detail: tidyText(r.detail, deps.home, deps.platform), ...(r.fix ? { fix: tidyText(r.fix, deps.home, deps.platform) } : {}) }));
}

function nodeCheck(version: string, env: NodeJS.ProcessEnv): Omit<CheckResult, "check">[] {
  const major = Number(version.split(".")[0]);
  const results: Omit<CheckResult, "check">[] = [
    major >= 24
      ? { level: "pass", detail: `Node ${version}` }
      : { level: "fail", detail: `Node ${version}; sf-agent-po needs Node 24 or later.`, fix: "Install Node 24 LTS from nodejs.org, or with your version manager (nvm install 24)." },
  ];
  // Often set to get past a company proxy: it turns off certificate checks for every call,
  // the ones that carry the Atlassian token included.
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    results.push({
      level: "warn",
      detail: "NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks, so a machine in the middle could read the Jira and Confluence token.",
      fix: "Remove NODE_TLS_REJECT_UNAUTHORIZED from your shell and your AI tool's MCP settings. Behind a proxy that inspects HTTPS, set NODE_OPTIONS=--use-system-ca instead, so Node trusts the certificates your system trusts.",
    });
  }
  return results;
}

async function workspaceCheck(database: Database, opts: DoctorOptions, home: string): Promise<{ result: Omit<CheckResult, "check">; current: boolean; readable?: boolean }> {
  const shown = tidyPath(opts.workspace, home);
  const { DatabaseSync } = await import("node:sqlite");
  const probe = new DatabaseSync(":memory:");
  try {
    probe.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
  } catch (err) {
    return { result: { level: "fail", detail: `This Node's SQLite has no full-text search (FTS5): ${(err as Error).message}`, fix: "Use the official Node 24 build from nodejs.org." }, current: false };
  } finally {
    probe.close();
  }
  const { MIGRATIONS } = await import("@sf-agent-po/core");
  let schema: number;
  try {
    schema = (database.db.prepare("SELECT max(version) AS v FROM schema_migration").get() as { v: number | null }).v ?? 0;
  } catch (err) {
    return {
      result: { level: "fail", detail: `The database in ${shown} cannot be read: ${(err as Error).message}`, fix: "Restore the workspace folder from a backup, or move it away and index and add the inputs again." },
      current: false,
    };
  }
  const known = Math.max(...MIGRATIONS.map((m) => m.version));
  if (schema > known) {
    return { result: { level: "fail", detail: `${shown} was written by a newer sf-agent-po (schema ${schema}; this one knows ${known}).`, fix: "Run the newest version: npx -y sf-agent-po@next doctor" }, current: false, readable: true };
  }
  // The server's own database is not checked page by page: it would hold up every tool call.
  if (!opts.database) {
    const check = database.db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
    const problems = check.map((r) => r.quick_check).filter((r) => r !== "ok");
    if (problems.length) {
      return {
        result: { level: "fail", detail: `The database in ${shown} is damaged: ${problems.slice(0, 3).join("; ")}`, fix: "Restore the workspace folder from a backup, or move it away and index and add the inputs again." },
        current: false,
        readable: true,
      };
    }
  }
  const contexts = (database.db.prepare("SELECT COUNT(*) AS n FROM context").get() as { n: number }).n;
  const checked = opts.database ? "" : "database ok, ";
  if (schema < known) {
    return { result: { level: "warn", detail: `${shown}: ${checked}${contexts} context(s), written by an older sf-agent-po.`, fix: "Nothing to do: the server upgrades it when it next starts." }, current: false, readable: true };
  }
  return { result: { level: "pass", detail: `${shown}: ${checked}full-text search ok, ${contexts} context(s)` }, current: true, readable: true };
}

async function keyCheck(database: Database | undefined, opts: DoctorOptions, deps: DoctorDeps): Promise<Omit<CheckResult, "check">> {
  const { KeychainUnavailable, KeychainTimeout, storedVaultKeyId } = await import("@sf-agent-po/core");
  const { keyImportHint } = await import("./key-command.js");
  const id = database && storedVaultKeyId(database);
  if (id && opts.keyLoaded) return { level: "pass", detail: `The key (id ${id.slice(0, 8)}) is loaded by this server. Keep a backup: npx sf-agent-po@next key export` };
  const store = deps.keyStore();
  if (!id) {
    const { name: tool, present } = deps.keyTool();
    return present
      ? { level: "pass", detail: `No key yet: the server makes one on first start and keeps it in ${store.name}.` }
      : {
          level: "warn",
          detail: `No key yet, and ${tool} is not installed, so the key will go to a key file readable only by you.`,
          fix: deps.platform === "linux" ? "Install secret-tool (libsecret-tools, or libsecret on Fedora) to keep it in your keyring instead." : `Check that ${tool} is installed where your OS puts it.`,
        };
  }
  try {
    const key = store.get(id);
    if (key) return { level: "pass", detail: `The key (id ${id.slice(0, 8)}) is in ${store.name}. Keep a backup: npx sf-agent-po@next key export` };
    return { level: "fail", detail: `The workspace's key (id ${id.slice(0, 8)}) is not in ${store.name}: nothing can be unmasked.`, fix: keyImportHint(opts.workspace, deps.platform) };
  } catch (err) {
    if (err instanceof KeychainUnavailable || err instanceof KeychainTimeout) {
      return { level: "fail", detail: (err as Error).message, fix: "Unlock your keychain (or, over SSH on Linux, start a session with a keyring) and run doctor again." };
    }
    throw err;
  }
}

const PROXY_FIX =
  "Behind a company proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1 (and NODE_OPTIONS=--use-system-ca if it inspects HTTPS), in this shell and in the server's environment.";
const MODEL_FIX = `${PROXY_FIX} Without access, the server's error names each model file to download by hand, and where to save it.`;

async function modelCheck(opts: DoctorOptions, deps: DoctorDeps): Promise<Omit<CheckResult, "check">> {
  const { DEFAULT_MODEL, defaultModelDir } = await import("@sf-agent-po/core");
  if (!deps.runtimePresent()) return { level: "fail", detail: "The model runtime is missing from the package.", fix: "Reinstall: npx -y sf-agent-po@next doctor" };
  const dir = path.join(defaultModelDir(deps.env, deps.platform), DEFAULT_MODEL.id, DEFAULT_MODEL.revision);
  const files = Object.values(DEFAULT_MODEL.files);
  const missing = files.filter((f) => {
    const p = path.join(dir, f.path);
    return !existsSync(p) || statSync(p).size !== f.size;
  });
  if (missing.length) {
    const url = `https://huggingface.co/${DEFAULT_MODEL.id}/resolve/${DEFAULT_MODEL.revision}/${DEFAULT_MODEL.files.config.path}`;
    try {
      const res = await deps.fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`huggingface.co answered ${res.status}`);
    } catch (err) {
      return { level: "fail", detail: `The model (about 140 MB) is not downloaded yet, and huggingface.co cannot be reached: ${reason(err)}`, fix: MODEL_FIX };
    }
    return { level: "warn", detail: "The model (about 140 MB) is not downloaded yet; huggingface.co is reachable, so it downloads on first use.", fix: "Nothing to do, or run doctor again after adding a first input." };
  }
  if (opts.model === "files") {
    return { level: "pass", detail: `Downloaded${opts.modelLoaded ? ", and loaded by this server" : "; the server loads it on first use"}.` };
  }
  const started = deps.now().getTime();
  const model = await deps.loadModel();
  try {
    const found = await model.detect("Sarah Whitfield met the team in Lyon.");
    const seconds = ((deps.now().getTime() - started) / 1000).toFixed(1);
    if (!found.some((s) => s.type === "PERSON")) return { level: "fail", detail: "The model loads but found no name in a test sentence.", fix: `Delete ${tidyPath(dir, deps.home)} so that it downloads again.` };
    return { level: "pass", detail: `Loads in ${seconds} s and finds the name in a test sentence.` };
  } finally {
    await model.release();
  }
}

/** The orgs in `sf org list`, by username, and whether each is connected. */
function orgsOf(result: unknown, aliases: Map<string, string>): { total: number; connected: number } {
  const seen = new Map<string, boolean>();
  for (const list of Object.values((result ?? {}) as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const org of list as { username?: string; alias?: string; orgId?: string; connectedStatus?: string; isExpired?: boolean; status?: string }[]) {
      if (!org?.username) continue;
      if (org.orgId && org.alias && !aliases.has(org.orgId)) aliases.set(org.orgId, org.alias);
      const ok = org.connectedStatus ? org.connectedStatus === "Connected" : org.status === "Active" && !org.isExpired;
      seen.set(org.username, (seen.get(org.username) ?? false) || ok);
    }
  }
  return { total: seen.size, connected: [...seen.values()].filter(Boolean).length };
}

/** What a missing command looks like: ENOENT through run, or cmd.exe's message on Windows, where sf starts through a shell. */
const MISSING = /was not found|is not recognized as an internal or external command/;

async function sfCheck(deps: DoctorDeps, orgs: Map<string, string>): Promise<Omit<CheckResult, "check">> {
  let result: unknown;
  try {
    result = await deps.sf(["org", "list"]);
  } catch (err) {
    const message = (err as Error).message;
    if (MISSING.test(message)) {
      return { level: "warn", detail: "The sf CLI is not installed: indexing an org needs it.", fix: "npm install -g @salesforce/cli, then sf org login web --alias <alias>" };
    }
    return { level: "fail", detail: message, fix: "Run sf org list to see the error, and update the CLI with npm install -g @salesforce/cli." };
  }
  const { total, connected } = orgsOf(result, orgs);
  if (!total) return { level: "warn", detail: "sf is installed but logged in to no org.", fix: "sf org login web --alias <alias>" };
  if (connected < total) {
    return { level: "warn", detail: `sf is logged in to ${total} org(s); ${total - connected} cannot be reached or need a new login.`, fix: "Run sf org list to see which, then sf org login web --alias <alias> for each one you index." };
  }
  return { level: "pass", detail: `sf is logged in to ${total} org(s), all connected.` };
}

const ATLASSIAN_ENV = ["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"] as const;

async function atlassianCheck(calls: boolean, deps: DoctorDeps): Promise<Omit<CheckResult, "check">[]> {
  const missing = ATLASSIAN_ENV.filter((name) => !deps.env[name]);
  const where = calls ? "this shell" : "the server's environment";
  if (missing.length === ATLASSIAN_ENV.length) {
    return [
      {
        level: "warn",
        detail: `None of ${ATLASSIAN_ENV.join(", ")} is set in ${where}, so Jira and Confluence cannot be read or published to.`,
        fix: calls
          ? "Set them in your AI tool's MCP server settings. If they are set there already, ask the agent for server_status instead, or set them here to test the calls."
          : "Set them in your AI tool's MCP server settings, then restart the server.",
      },
    ];
  }
  if (missing.length) return [{ level: "fail", detail: `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set in ${where}.`, fix: `Set ${missing.join(" and ")} next to the others.` }];
  const { AtlassianClient, atlassianConfigFromEnv } = await import("@sf-agent-po/connectors");
  const config = atlassianConfigFromEnv(deps.env)!;
  if (!/^https:\/\//.test(config.siteUrl)) return [{ level: "fail", detail: "ATLASSIAN_SITE_URL does not start with https://.", fix: "Set it to your site's address, for example https://your-company.atlassian.net" }];
  if (!calls) return [{ level: "pass", detail: "The three settings are set (not called from the server: run doctor to test them)." }];
  // A proxy that drops the traffic would otherwise hold doctor for minutes.
  const timed: typeof fetch = (url, init) => deps.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const client = new AtlassianClient(config, timed);
  const out: Omit<CheckResult, "check">[] = [];
  for (const [product, call] of [
    ["Jira", () => client.ping("jira")],
    ["Confluence", () => client.ping("confluence")],
  ] as const) {
    try {
      await call();
      out.push({ level: "pass", detail: `${product} answers, and accepts the email and API token.` });
    } catch (err) {
      const status = (err as { status?: number }).status;
      out.push(
        status === 401
          ? { level: "fail", detail: `${product} refused the email and API token (401).`, fix: "Make a new API token at id.atlassian.com/manage-profile/security/api-tokens, for the account of ATLASSIAN_EMAIL." }
          : status === 403
            ? { level: "fail", detail: `${product} accepted the login but refused access (403).`, fix: `Ask your Atlassian admin for ${product} access for this account.` }
            : status === 404
              ? { level: "warn", detail: `${product} was not found on this site (404).`, fix: `Check ATLASSIAN_SITE_URL, or ignore this if your site has no ${product}.` }
              : err instanceof SyntaxError
                ? { level: "fail", detail: `${product} answered with a page that is not its API (a company proxy or a login page?).`, fix: `Check ATLASSIAN_SITE_URL. ${PROXY_FIX}` }
                : { level: "fail", detail: `${product} cannot be reached: ${status ? `it answered ${status}` : reason(err)}`, fix: PROXY_FIX },
      );
    }
  }
  return out;
}

interface Tool {
  cmd: string;
  why: string;
  install: string;
}

const TOOLS: Tool[] = [
  { cmd: "git", why: "indexing a remote repository needs it", install: "Install git from git-scm.com." },
  { cmd: "gh", why: "indexing a private GitHub repository uses it", install: "Install the GitHub CLI from cli.github.com, then gh auth login." },
  { cmd: "glab", why: "indexing a private GitLab repository uses it", install: "Install the GitLab CLI from gitlab.com/gitlab-org/cli, then glab auth login." },
];

async function toolCheck(tool: Tool, deps: DoctorDeps): Promise<Omit<CheckResult, "check">> {
  try {
    const { stdout } = await deps.run(tool.cmd, ["--version"]);
    return { level: "pass", detail: stdout.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "installed" };
  } catch (err) {
    if (MISSING.test((err as Error).message)) return { level: "warn", detail: `Not installed: ${tool.why}.`, fix: tool.install };
    return { level: "warn", detail: `Installed, but ${tool.cmd} --version failed: ${(err as Error).message}`, fix: tool.install };
  }
}

/** For each host, how many of its files are in the project, and how many differ from this version's. */
export async function hostFilesState(project: string): Promise<{ host: Host; expected: number; present: number; outdated: number; replaced: string[] }[]> {
  const out = [];
  for (const host of HOSTS) {
    let expected = 0;
    let present = 0;
    let outdated = 0;
    const replaced: string[] = [];
    for (const file of hostFiles(host)) {
      // An earlier version's file for the same purpose, still there.
      if (file.replaces && (await lstat(path.join(project, file.replaces)).catch(() => undefined))) replaced.push(file.replaces);
      // Not written when the other file is there, because the host would load both.
      if (file.unlessPresent && (await lstat(path.join(project, file.unlessPresent.path)).catch(() => undefined))) continue;
      expected++;
      const content = await readFile(path.join(project, file.path), "utf8").catch(() => undefined);
      if (content === undefined) continue;
      present++;
      // A checkout with CRLF line ends (core.autocrlf on Windows) holds the same file.
      if (content.replace(/\r\n/g, "\n") !== file.content) outdated++;
    }
    out.push({ host, expected, present, outdated, replaced });
  }
  return out;
}

async function hostFilesCheck(project: string, home: string): Promise<Omit<CheckResult, "check">[]> {
  const shown = tidyPath(project, home);
  const all = await hostFilesState(project);
  const state = all.filter((s) => s.present);
  const old = all
    .filter((s) => s.replaced.length)
    .map((s) => ({
      level: "warn" as const,
      detail: `${s.host}: ${s.replaced.length} file(s) from an earlier version are still in ${shown}, and newer files replace them.`,
      fix: `Delete ${s.replaced.join(", ")}, so your AI tool does not offer both.`,
    }));
  if (!state.length) {
    return [{ level: "warn", detail: `No AI tool files in ${shown}.`, fix: "Run, in your project folder: npx sf-agent-po@next init --host claude-code (or cursor, copilot, all)" }, ...old];
  }
  const files = state.map((s): Omit<CheckResult, "check"> =>
    s.present < s.expected || s.outdated
      ? {
          level: "warn",
          detail: `${s.host}: ${s.present} of ${s.expected} files in ${shown}${s.outdated ? `, ${s.outdated} from another version or edited` : ""}.`,
          fix: `npx sf-agent-po@next init --host ${s.host} --force (this replaces your edits to those files)`,
        }
      : { level: "pass", detail: `${s.host}: all ${s.expected} files in ${shown}, up to date.` },
  );
  return [...files, ...old];
}

/** An index older than this gets a warning: Salesforce changes keep coming. */
export const STALE_INDEX_DAYS = 7;

async function indexCheck(opts: DoctorOptions, file: string, deps: DoctorDeps, orgs: Map<string, string>): Promise<Omit<CheckResult, "check">[]> {
  if (!opts.database && !existsSync(file)) return [];
  const { Database, MetadataIndex, MIGRATIONS } = await import("@sf-agent-po/core");
  const database = opts.database ?? new Database(file, MIGRATIONS, { readOnly: true });
  try {
    const seen = new Set<string>();
    const latest = new MetadataIndex(database).snapshots().filter((s) => s.status === "ready" && !seen.has(s.source) && (seen.add(s.source), true));
    if (!latest.length) return [{ level: "warn", detail: "Nothing is indexed: the agents cannot check the org's metadata.", fix: "npx sf-agent-po@next index --org <alias> (or --project <folder>)" }];
    return latest.map((s) => {
      const days = Math.floor((deps.now().getTime() - Date.parse(s.finishedAt ?? s.startedAt)) / 86_400_000);
      // Sources hold no path: a project is "repo:<folder name>#<hash>", an org "org:<org id>".
      const alias = s.kind === "org" ? orgs.get(s.source.replace(/^org:/, "")) : undefined;
      const name = alias ? `${s.source} (${alias})` : s.source;
      const age = days < 1 ? "today" : `${days} day(s) ago`;
      const again = s.kind === "org" ? `npx sf-agent-po@next index --org ${alias ?? "<alias of this org>"}` : "npx sf-agent-po@next index --project <its folder> (or --repo <repository> for a remote one)";
      return days > STALE_INDEX_DAYS
        ? { level: "warn" as const, detail: `${name} was indexed ${age}.`, fix: `Index it again: ${again}` }
        : { level: "pass" as const, detail: `${name} was indexed ${age}.` };
    });
  } finally {
    if (!opts.database) database.close();
  }
}

/** The checks as text: one line per check, the fix under it. */
export function formatChecks(results: CheckResult[]): string {
  const label = { pass: "PASS", warn: "WARN", fail: "FAIL" } as const;
  const indent = (t: string) => t.replace(/\r?\n/g, "\n      ");
  const lines = results.map((r) => `${label[r.level]}  ${r.check}: ${indent(r.detail)}${r.fix ? `\n      Fix: ${indent(r.fix)}` : ""}`);
  const count = (l: Level) => results.filter((r) => r.level === l).length;
  lines.push("", `${count("pass")} passed, ${count("warn")} warning(s), ${count("fail")} failed.`);
  return lines.join("\n");
}

export interface DoctorArgs {
  workspace: string;
  project: string;
  atlassianCalls: boolean;
}

export function parseDoctorArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): DoctorArgs | { help: string } {
  let workspace = path.resolve(cwd, env.SF_AGENT_WORKSPACE ?? ".sf-agent");
  let project = cwd;
  let atlassianCalls = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { help: DOCTOR_USAGE };
    if (arg === "--no-calls") atlassianCalls = false;
    else if (arg === "--workspace" || arg === "--dir") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value.\n\n${DOCTOR_USAGE}`);
      if (arg === "--workspace") workspace = path.resolve(cwd, v);
      else project = path.resolve(cwd, v);
    } else throw new Error(`Unknown option "${arg}".\n\n${DOCTOR_USAGE}`);
  }
  return { workspace, project, atlassianCalls };
}
