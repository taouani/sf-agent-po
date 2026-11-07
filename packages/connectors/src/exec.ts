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
  opts: { cwd?: string; timeoutMs?: number; shell?: boolean; parseFailureOutput?: boolean } = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      shell: opts.shell,
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
    const detail = (e.stderr || e.stdout || e.message).trim();
    throw new Error(`${cmd} ${args[0] ?? ""} failed: ${detail}`);
  }
}
