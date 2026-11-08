// Opens the approval page in the user's browser, so its address never has to pass through
// the model: whoever has the address can decide.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, posix, win32 } from "node:path";

export interface BrowserCommand {
  file: string;
  args: (url: string) => string[];
}

/**
 * SF_AGENT_PO_BROWSER: the program that opens approval pages instead of the OS default, as a JSON
 * array of the program's absolute path and its first arguments; the page's address comes last.
 * It is set in the server's environment, which the model cannot change, for example to use
 * another browser or, in the evaluation, a program that hands the page to the runner.
 */
export const BROWSER_ENV = "SF_AGENT_PO_BROWSER";

/** The program that opens a URL on this OS, by absolute path so a PATH entry cannot stand in for it; null when there is none. */
export function browserCommand(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): BrowserCommand | null {
  const own = env[BROWSER_ENV];
  // A setting that cannot be read opens nothing, rather than a browser the user did not choose.
  if (own !== undefined && own !== "") return ownBrowser(own, platform);
  if (platform === "darwin") return { file: "/usr/bin/open", args: (u) => [u] };
  if (platform === "win32") {
    // rundll32 takes the URL as one argument; going through cmd's "start" would parse it.
    return { file: join(env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"), args: (u) => ["url.dll,FileProtocolHandler", u] };
  }
  const file = ["/usr/bin/xdg-open", "/usr/local/bin/xdg-open", "/bin/xdg-open"].find((f) => existsSync(f));
  return file ? { file, args: (u) => [u] } : null;
}

function ownBrowser(value: string, platform: NodeJS.Platform): BrowserCommand | null {
  let parts: unknown;
  try {
    parts = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parts) || !parts.length || !parts.every((p): p is string => typeof p === "string" && p.length > 0)) return null;
  const [file, ...first] = parts;
  return (platform === "win32" ? win32 : posix).isAbsolute(file!) ? { file: file!, args: (u) => [...first, u] } : null;
}

/** Opens an approval page link in the default browser; false when there is no browser to open (a remote shell, CI). */
export function openInBrowser(url: string, command: BrowserCommand | null = browserCommand()): Promise<boolean> {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/a\/[\w-]{32}(\?k=[\w-]+)?$/.test(url) || !command) return Promise.resolve(false);
  return new Promise((resolve) => {
    // Detached and with no pipes: xdg-open may run the browser in the foreground, and its output is not needed.
    const child = spawn(command.file, command.args(url), { stdio: "ignore", detached: true, windowsHide: true });
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
    child.once("error", () => resolve(false));
  });
}
