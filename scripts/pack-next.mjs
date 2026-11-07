#!/usr/bin/env node
// Builds the installable v1 pre-release: one npm package, "sf-agent-po", with the MCP server
// and the core and connectors packages bundled inside it (they are not published on their
// own), the WebAssembly model runtime (decision RT1) and the domain content.
//
//   node scripts/pack-next.mjs [--out <folder>] [--no-build] [--smoke]
//
// It writes <out>/sf-agent-po-<version>.tgz (default out: .pack-next). --smoke installs that
// tarball in an empty folder and checks the command and the library load from it. Nothing
// is published: `npm publish <tarball> --tag next` does that, from the release workflow.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const out = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(root, ".pack-next"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: "inherit", shell: process.platform === "win32", ...opts });
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** The workspace packages bundled inside, and what each ships. */
const BUNDLED = [
  { name: "@sf-agent-po/core", dir: "packages/core", ship: ["dist", "content", "vendor"] },
  { name: "@sf-agent-po/connectors", dir: "packages/connectors", ship: ["dist"] },
];
const mcp = readJson(path.join(root, "packages/mcp/package.json"));

if (!flag("--no-build")) {
  for (const w of ["@sf-agent-po/core", "@sf-agent-po/connectors", "@sf-agent-po/mcp"]) run(npm, ["run", "build", "-w", w], { cwd: root });
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
  const { scripts, devDependencies, ...kept } = pkg;
  void scripts;
  void devDependencies;
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
for (const f of ["README.md", "LICENSE"]) cpSync(path.join(root, f), path.join(stage, f));

const name = execFileSync(npm, ["pack", "--silent", "--pack-destination", out], { cwd: stage, encoding: "utf8", shell: process.platform === "win32" }).trim().split("\n").at(-1);
const tarball = path.join(out, name);
console.log(`Packed ${tarball}`);

if (flag("--smoke")) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sf-agent-po-smoke-"));
  try {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }) + "\n");
    run(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball], { cwd: dir });
    const bin = Object.keys(pkg.bin)[0];
    const report = execFileSync(npm, ["exec", "--no", "--", bin, "init", "--dry-run", "--dir", path.join(dir, "project")], { cwd: dir, encoding: "utf8", shell: process.platform === "win32" });
    if (!report.includes("would write  .claude/agents/salesforce-solution-architect.md")) throw new Error(`init did not list the agent files:\n${report}`);
    const check = `
      const lib = await import("sf-agent-po");
      for (const name of ["createServer", "ApprovalServer", "registerBacklogTools"]) if (typeof lib[name] !== "function") throw new Error(name + " is not exported");
      const { pathToFileURL } = await import("node:url");
      const { join } = await import("node:path");
      const core = await import(pathToFileURL(join(process.cwd(), "node_modules", "sf-agent-po", "node_modules", "@sf-agent-po", "core", "dist", "index.js")).href);
      if (!core.BUILTIN_CONTENT_DIR) throw new Error("the core package does not load");
    `;
    run(process.execPath, ["--input-type=module", "-e", check], { cwd: dir, shell: false });
    console.log("Smoke test passed: the tarball installs, init lists the files, and the library loads.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
