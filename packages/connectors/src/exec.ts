import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs a CLI without a shell so arguments are never interpreted. `shell` exists
 * only for Windows .cmd shims (such as sf.cmd), which cannot start without one;
 * callers that set it must validate their arguments first. `parseFailureOutput`
 * returns the stdout of a failed command, for CLIs that print a JSON error.
 */
export async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; shell?: boolean; parseFailureOutput?: boolean; /** Added to this process's environment. */ env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  try {
    // With a shell, Node joins the arguments without quoting them and warns (DEP0190), so
    // the command line is joined here instead, from arguments the caller has validated.
    const { stdout, stderr } = await execFileAsync(opts.shell ? [cmd, ...args].join(" ") : cmd, opts.shell ? [] : args, {
      cwd: opts.cwd,
      shell: opts.shell,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.stdout && opts.parseFailureOutput) return { stdout: e.stdout, stderr: e.stderr ?? "" };
    if (e.code === "ENOENT") {
      throw new Error(`Command "${cmd}" was not found. Install it and make sure it is on PATH.`);
    }
    // The notice alone is no detail: fall back to stdout, then to Node's message.
    const detail = withoutNotices(e.stderr ?? "") || withoutNotices(e.stdout ?? "") || e.message;
    throw new Error(`${cmd} ${args[0] ?? ""} failed: ${detail}`);
  }
}

/** A CLI's error output without its update notices and the "»" (Windows) or "›" its lines start with. */
export function withoutNotices(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[»›]\s*/, "").trim())
    .filter((line) => line && !/^Warning:.*update available/i.test(line))
    .join(" ");
}
