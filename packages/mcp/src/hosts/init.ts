import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { HOSTS, type Host, hostFiles } from "./files.js";

export const USAGE = `Usage: npx sf-agent-po@next init [--host claude-code|cursor|copilot|all] [--dir <project folder>] [--force] [--dry-run]

Writes Salesforce Solution Architect and Product Owner agent files for your
AI coding tool into a project. The files use the sf-agent-po MCP server, which
you configure separately (see the README). Repeat --host, or separate hosts
with commas, to write files for several tools; the default is all of them.`;

export interface InitOptions {
  hosts: Host[];
  dir: string;
  force: boolean;
  dryRun: boolean;
}

export function parseInitArgs(argv: string[]): InitOptions | { help: string } {
  const opts: InitOptions = { hosts: [], dir: process.cwd(), force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: USAGE };
    if (arg === "--force") opts.force = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--dir") opts.dir = path.resolve(requireValue(argv, ++i, arg));
    else if (arg === "--host") {
      for (const value of requireValue(argv, ++i, arg).split(",")) {
        if (value === "all") opts.hosts.push(...HOSTS);
        else if ((HOSTS as readonly string[]).includes(value)) opts.hosts.push(value as Host);
        else throw new Error(`Unknown host "${value}". Use one of: ${HOSTS.join(", ")}, all.`);
      }
    } else throw new Error(`Unknown option "${arg}".\n\n${USAGE}`);
  }
  // Keep the canonical order: Claude Code files first, so Copilot can tell when VS Code would load them too.
  opts.hosts = opts.hosts.length ? HOSTS.filter((h) => opts.hosts.includes(h)) : [...HOSTS];
  return opts;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return value;
}

/** The real path of `p`: symbolic links in the part that exists are followed, and the part that does not is appended as is. */
async function resolveReal(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (err) {
    const parent = path.dirname(p);
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || parent === p) throw err;
    return path.join(await resolveReal(parent), path.basename(p));
  }
}

/** Whether `dir` resolves inside `root` once symbolic links are followed. */
async function staysInside(root: string, dir: string): Promise<boolean> {
  const real = await resolveReal(dir);
  return real === root || real.startsWith(root + path.sep);
}

/**
 * Writes the host files, never overwriting an existing file unless forced, and
 * never following a symbolic link out of the project. Returns one line per
 * file; a file that cannot be written gets a "failed" line and the rest are
 * still written.
 */
export async function runInit(opts: InitOptions): Promise<string[]> {
  const report: string[] = [];
  if (!opts.dryRun) await mkdir(opts.dir, { recursive: true });
  // On a dry run the folder may not exist yet; resolve it the same way as the targets so they compare.
  const root = await resolveReal(opts.dir).catch(() => path.resolve(opts.dir));
  const planned = new Set<string>();
  const present = async (rel: string) => planned.has(rel) || !!(await lstat(path.join(opts.dir, rel)).catch(() => undefined));

  for (const host of opts.hosts) {
    for (const file of hostFiles(host)) {
      const target = path.join(opts.dir, file.path);
      try {
        if (file.unlessPresent && (await present(file.unlessPresent.path))) {
          report.push(`skipped  ${file.path} (${file.unlessPresent.reason})`);
          continue;
        }
        const existing = await lstat(target).catch(() => undefined);
        if (existing?.isSymbolicLink()) {
          report.push(`skipped  ${file.path} (a symbolic link; remove it to write the file)`);
          continue;
        }
        if (existing && !opts.force) {
          report.push(`skipped  ${file.path} (exists; use --force to overwrite)`);
          continue;
        }
        if (!(await staysInside(root, path.dirname(target)))) {
          report.push(`skipped  ${file.path} (its folder is a link to outside ${opts.dir})`);
          continue;
        }
        if (!opts.dryRun) {
          await mkdir(path.dirname(target), { recursive: true });
          // "wx" fails rather than follow a link that appeared since the check.
          await writeFile(target, file.content, { encoding: "utf8", flag: existing ? "w" : "wx" });
        }
        planned.add(file.path);
        report.push(`${opts.dryRun ? "would write" : existing ? "replaced" : "created"}  ${file.path}`);
      } catch (err) {
        report.push(`failed   ${file.path} (${(err as Error).message})`);
      }
    }
  }
  return report;
}
