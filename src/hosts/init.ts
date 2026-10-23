import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HOSTS, type Host, hostFiles } from "./files.js";

const USAGE = `Usage: sf-agent-po init [--host claude-code|cursor|copilot|all] [--dir <project folder>] [--force] [--dry-run]

Writes Salesforce Solution Architect and Product Owner agent files for your
AI coding tool into a project. The files use the sf-agent-po MCP server, which
you configure separately (see the README).`;

export interface InitOptions {
  hosts: Host[];
  dir: string;
  force: boolean;
  dryRun: boolean;
}

export function parseInitArgs(argv: string[]): InitOptions | { help: string } {
  const opts: InitOptions = { hosts: [...HOSTS], dir: process.cwd(), force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: USAGE };
    if (arg === "--force") opts.force = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--dir") opts.dir = path.resolve(requireValue(argv, ++i, arg));
    else if (arg === "--host") {
      const value = requireValue(argv, ++i, arg);
      if (value === "all") opts.hosts = [...HOSTS];
      else if ((HOSTS as readonly string[]).includes(value)) opts.hosts = [value as Host];
      else throw new Error(`Unknown host "${value}". Use one of: ${HOSTS.join(", ")}, all.`);
    } else throw new Error(`Unknown option "${arg}".\n\n${USAGE}`);
  }
  return opts;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return value;
}

/** Writes the host files, never overwriting an existing file unless forced. Returns one line per file. */
export async function runInit(opts: InitOptions): Promise<string[]> {
  const report: string[] = [];
  for (const host of opts.hosts) {
    for (const file of hostFiles(host)) {
      const target = path.join(opts.dir, file.path);
      const exists = await access(target).then(
        () => true,
        () => false,
      );
      if (exists && !opts.force) {
        report.push(`skipped  ${file.path} (exists; use --force to overwrite)`);
        continue;
      }
      if (!opts.dryRun) {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, "utf8");
      }
      report.push(`${opts.dryRun ? "would write" : exists ? "replaced" : "created"}  ${file.path}`);
    }
  }
  return report;
}
