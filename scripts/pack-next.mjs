#!/usr/bin/env node
// Builds the installable v1 pre-release: one npm package, "sf-agent-po", with the MCP server
// and the core and connectors packages bundled inside it (they are not published on their
// own), the WebAssembly model runtime (decision RT1) and the domain content.
//
//   node scripts/pack-next.mjs [--out <folder>] [--no-build] [--smoke] [--smoke-server]
//
// It writes <out>/sf-agent-po-<version>.tgz (default out: .pack-next). --smoke installs that
// tarball in an empty folder and checks the command and the library load from it.
// --smoke-server also installs it globally (under a temporary prefix) and starts the server
// there, as `npm i -g` and npx do; the server makes a masking key, which goes to a temporary
// key folder, except on macOS, where it goes to your login keychain, so CI runs it. Nothing
// is published.

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const out = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(root, ".pack-next"));
const windows = process.platform === "win32";
/**
 * Runs npm. On Windows npm is a .cmd file, which only a shell runs, and a shell splits
 * unquoted arguments at spaces ("C:\\Users\\Jane Doe"), so each one is quoted there.
 */
const npm = (argv, opts = {}) =>
  windows
    ? execFileSync(`npm ${argv.map((a) => `"${a.replaceAll('"', '\\"')}"`).join(" ")}`, { stdio: "inherit", shell: true, ...opts })
    : execFileSync("npm", argv, { stdio: "inherit", ...opts });
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** The workspace packages bundled inside, and what each ships. */
const BUNDLED = [
  { name: "@sf-agent-po/core", dir: "packages/core", ship: ["dist", "content", "vendor"] },
  { name: "@sf-agent-po/connectors", dir: "packages/connectors", ship: ["dist"] },
];
const mcp = readJson(path.join(root, "packages/mcp/package.json"));

if (!flag("--no-build")) {
  // tsc never deletes what a removed source compiled to, and that must not ship.
  for (const dir of ["packages/core", "packages/connectors", "packages/mcp"]) rmSync(path.join(root, dir, "dist"), { recursive: true, force: true });
  for (const w of ["@sf-agent-po/core", "@sf-agent-po/connectors", "@sf-agent-po/mcp"]) npm(["run", "build", "-w", w], { cwd: root });
}

const stage = path.join(out, "package");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// Compiled files only: no tests, and no source maps pointing at sources that are not shipped.
const compiled = (src) => !/\.(js|d\.ts)\.map$/.test(src);
cpSync(path.join(root, "packages/mcp/dist"), path.join(stage, "dist"), { recursive: true, filter: compiled });

/** Third-party dependencies of every part, which must agree on each version. */
const dependencies = {};
const addDeps = (from, deps = {}) => {
  for (const [name, range] of Object.entries(deps)) {
    if (name.startsWith("@sf-agent-po/")) continue;
    if (dependencies[name] && dependencies[name] !== range) throw new Error(`${name}: ${from} needs ${range}, another part ${dependencies[name]}`);
    dependencies[name] = range;
  }
};
addDeps(mcp.name, mcp.dependencies);

for (const b of BUNDLED) {
  const pkg = readJson(path.join(root, b.dir, "package.json"));
  const target = path.join(stage, "node_modules", b.name);
  for (const part of b.ship) {
    const src = path.join(root, b.dir, part);
    if (!existsSync(src)) throw new Error(`${b.dir}/${part} is missing: build first`);
    cpSync(src, path.join(target, part), { recursive: true, filter: compiled });
  }
  // Their dependencies are the package's own (below): listed here, npm would count them as
  // bundled too, and a global install would leave their folders empty.
  const { scripts, devDependencies, dependencies: own, ...kept } = pkg;
  void scripts;
  void devDependencies;
  void own;
  // The source condition points at TypeScript files that are not shipped.
  const exports = Object.fromEntries(Object.entries(pkg.exports).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([c]) => c !== "@sf-agent-po/source"))]));
  writeFileSync(path.join(target, "package.json"), JSON.stringify({ ...kept, exports }, null, 2) + "\n");
  addDeps(b.name, pkg.dependencies);
}

const rootPkg = readJson(path.join(root, "package.json"));
const pkg = {
  name: "sf-agent-po",
  version: mcp.version,
  description: "Salesforce Solution Architect and Product Owner agents for Claude Code, Cursor and GitHub Copilot, over MCP, with personal data masked",
  license: mcp.license,
  repository: rootPkg.repository,
  homepage: rootPkg.homepage,
  bugs: rootPkg.bugs,
  type: "module",
  exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  bin: mcp.bin,
  files: ["dist"],
  engines: mcp.engines,
  dependencies: {
    ...Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
    ...Object.fromEntries(BUNDLED.map((b) => [b.name, readJson(path.join(root, b.dir, "package.json")).version])),
  },
  bundleDependencies: BUNDLED.map((b) => b.name),
};
writeFileSync(path.join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
cpSync(path.join(root, "packages/mcp/README.md"), path.join(stage, "README.md"));
cpSync(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));

const name = npm(["pack", "--silent", "--pack-destination", out], { cwd: stage, encoding: "utf8", stdio: "pipe" }).trim().split("\n").at(-1).trim();
const tarball = path.join(out, name);
console.log(`Packed ${tarball}`);

if (flag("--smoke")) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sf-agent-po-smoke-"));
  try {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }) + "\n");
    npm(["install", "--no-audit", "--no-fund", "--loglevel=error", tarball], { cwd: dir });
    const bin = Object.keys(pkg.bin)[0];
    const report = npm(["exec", "--no", "--", bin, "init", "--dry-run", "--dir", path.join(dir, "project")], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    if (!report.includes("would write  .claude/agents/salesforce-solution-architect.md")) throw new Error(`init did not list the agent files:\n${report}`);
    const check = `
      const lib = await import("sf-agent-po");
      for (const name of ["createServer", "ApprovalServer", "registerBacklogTools"]) if (typeof lib[name] !== "function") throw new Error(name + " is not exported");
      const { pathToFileURL } = await import("node:url");
      const { join } = await import("node:path");
      const core = await import(pathToFileURL(join(process.cwd(), "node_modules", "sf-agent-po", "node_modules", "@sf-agent-po", "core", "dist", "index.js")).href);
      if (!core.BUILTIN_CONTENT_DIR) throw new Error("the core package does not load");
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", check], { cwd: dir, stdio: "inherit" });
    console.log("Smoke test passed: the tarball installs, init lists the files, and the library loads.");
    if (flag("--smoke-server")) await smokeServer(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Installs the tarball globally under a temporary prefix, where npm installs nothing but the
 * package's own dependencies, starts the server there, and checks it answers an MCP
 * initialize with its version.
 */
async function smokeServer(dir) {
  const prefix = path.join(dir, "global");
  npm(["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", tarball], { cwd: dir });
  const main = path.join(prefix, ...(windows ? [] : ["lib"]), "node_modules", "sf-agent-po", "dist", "main.js");
  const env = {
    ...process.env,
    SF_AGENT_WORKSPACE: path.join(dir, "workspace"),
    XDG_CONFIG_HOME: path.join(dir, "config"),
    LOCALAPPDATA: path.join(dir, "local"),
  };
  const child = spawn(process.execPath, [main], { cwd: dir, env, stdio: ["pipe", "pipe", "inherit"] });
  const answer = new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("the server did not answer within 60 s")), 60_000);
    child.on("exit", (code) => reject(new Error(`the server exited with code ${code}`)));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((l) => l.trim());
      if (line && buffer.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } }) + "\n",
  );
  try {
    const reply = await answer;
    if (reply.result?.serverInfo?.version !== pkg.version) throw new Error(`unexpected answer: ${JSON.stringify(reply)}`);
  } finally {
    child.removeAllListeners("exit");
    child.stdin.end();
    await new Promise((r) => (child.exitCode === null ? child.once("exit", r) : r()));
  }
  console.log("Smoke test passed: a global install starts the server and it answers initialize.");
}
