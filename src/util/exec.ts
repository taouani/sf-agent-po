import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Runs a CLI without a shell so arguments are never interpreted. */
export async function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === "ENOENT") {
      throw new Error(`Command "${cmd}" was not found. Install it and make sure it is on PATH.`);
    }
    const detail = (e.stderr || e.stdout || e.message).trim();
    throw new Error(`${cmd} ${args[0] ?? ""} failed: ${detail}`);
  }
}
