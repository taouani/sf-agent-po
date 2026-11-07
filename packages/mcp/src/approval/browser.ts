// Opens the approval page in the user's browser, so its address never has to pass through
// the model: whoever has the address can decide.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface BrowserCommand {
  file: string;
  args: (url: string) => string[];
}

/** The program that opens a URL on this OS, by absolute path so a PATH entry cannot stand in for it; null when there is none. */
export function browserCommand(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): BrowserCommand | null {
  if (platform === "darwin") return { file: "/usr/bin/open", args: (u) => [u] };
  if (platform === "win32") {
    // rundll32 takes the URL as one argument; going through cmd's "start" would parse it.
    return { file: join(env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"), args: (u) => ["url.dll,FileProtocolHandler", u] };
  }
  const file = ["/usr/bin/xdg-open", "/usr/local/bin/xdg-open", "/bin/xdg-open"].find((f) => existsSync(f));
  return file ? { file, args: (u) => [u] } : null;
}

/** Opens `url` in the default browser; false when there is no browser to open (a remote shell, CI). */
export function openInBrowser(url: string, command: BrowserCommand | null = browserCommand()): Promise<boolean> {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url) || !command) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = execFile(command.file, command.args(url), { timeout: 10_000, windowsHide: true }, (err) => resolve(!err));
    child.unref();
  });
}
