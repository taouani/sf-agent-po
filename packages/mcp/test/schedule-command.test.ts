import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseScheduleArgs, runSchedule, SCHEDULE_USAGE, type ScheduleDeps } from "../src/schedule-command.js";

const hash6 = (org: string) => createHash("sha256").update(org).digest("hex").slice(0, 6);
const temp: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "sf-agent-schedule-"));
  temp.push(d);
  return d;
};
afterEach(() => {
  for (const d of temp.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A computer whose scheduler commands are recorded, with a crontab kept in memory. */
function computer(platform: NodeJS.Platform) {
  const calls: { cmd: string; args: string[]; file?: string }[] = [];
  let crontab: string | undefined;
  let crontabFails: string | undefined;
  let deleteFails: string | undefined;
  const out: string[] = [];
  const root = tmp();
  const deps: ScheduleDeps = {
    platform,
    home: path.join(root, "home user"),
    cwd: path.join(root, "my project"),
    pathEnv: "/usr/local/bin:/opt/it's here:%APPDATA%",
    env: { NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem", HTTPS_PROXY: "http://user:secret@proxy:8080", SF_ACCESS_TOKEN: "x" },
    out: (t) => out.push(t),
    run: async (cmd, args) => {
      // The files a command is given are read now: they are removed once it returns.
      const given = args.find((a) => a.endsWith(".xml") || a.endsWith("crontab.next"));
      calls.push({ cmd, args, ...(given && existsSync(given) ? { file: readFileSync(given, given.endsWith(".xml") ? "utf16le" : "utf8") } : {}) });
      if (cmd === "schtasks" && args[0] === "/Delete" && deleteFails) throw new Error(`schtasks /Delete failed: ${deleteFails}`);
      if (cmd === "crontab" && args[0] === "-l") {
        if (crontabFails) throw new Error(`crontab -l failed: ${crontabFails}`);
        if (crontab === undefined) throw new Error("crontab -l failed: no crontab for user");
        return { stdout: crontab };
      }
      if (cmd === "crontab") crontab = readFileSync(args[0]!, "utf8");
      return { stdout: "" };
    },
  };
  return {
    deps, calls, out, root,
    crontab: () => crontab,
    setCrontab: (c: string) => (crontab = c),
    failCrontab: (why?: string) => (crontabFails = why),
    failDelete: (why?: string) => (deleteFails = why),
  };
}

describe("schedule command", () => {
  const cwd = path.resolve("/work");
  it("reads an org, a time and the workspace, and refuses the rest", () => {
    expect(parseScheduleArgs(["--org", "prod"], {}, cwd)).toEqual({ action: "add", org: "prod", at: { hour: 2, minute: 0 }, workspace: path.join(cwd, ".sf-agent") });
    expect(parseScheduleArgs(["--org", "a@b.com", "--at", "23:30", "--workspace", "w"], {}, cwd)).toMatchObject({ org: "a@b.com", at: { hour: 23, minute: 30 }, workspace: path.join(cwd, "w") });
    expect(parseScheduleArgs(["--remove", "--org", "prod"], {}, cwd)).toMatchObject({ action: "remove" });
    expect(parseScheduleArgs(["--list"], { SF_AGENT_WORKSPACE: "/ws" }, cwd)).toEqual({ action: "list", at: { hour: 2, minute: 0 }, workspace: path.resolve("/ws") });
    expect(parseScheduleArgs(["-h"], {}, cwd)).toEqual({ help: SCHEDULE_USAGE });
    expect(() => parseScheduleArgs([], {}, cwd)).toThrow(/Give --org/);
    expect(() => parseScheduleArgs(["--org", "prod", "--at", "24:00"], {}, cwd)).toThrow(/time of day/);
    expect(() => parseScheduleArgs(["--org", "prod; rm -rf ~"], {}, cwd)).toThrow(/not an org alias/);
    expect(() => parseScheduleArgs(["--list", "--org", "prod"], {}, cwd)).toThrow(/leave out --org/);
    expect(() => parseScheduleArgs(["--org", "prod", "--daily"], {}, cwd)).toThrow(/Unknown option "--daily"/);
  });

  it("registers a Windows task from a task file, so that spaces in paths need no quoting", async () => {
    const pc = computer("win32");
    const workspace = path.join(pc.root, "my project", ".sf-agent");
    expect(await runSchedule({ action: "add", org: "prod", at: { hour: 2, minute: 0 }, workspace }, pc.deps)).toBe(0);
    const create = pc.calls.find((c) => c.cmd === "schtasks")!;
    expect(create.args.slice(0, 3)).toEqual(["/Create", "/TN", expect.stringMatching(/^sf-agent-po index prod [0-9a-f]{8}$/)]);
    expect(create.args.slice(-1)).toEqual(["/F"]);
    const script = path.join(workspace, "schedule", `prod-${hash6("prod")}.cmd`);
    expect(create.file).toContain(`<Command>${script}</Command>`);
    expect(create.file).toContain("<StartBoundary>2000-01-01T02:00:00</StartBoundary>");
    expect(create.file).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    // The task file goes once the task is made.
    expect(readdirSync(path.join(workspace, "schedule")).filter((f) => f.endsWith(".xml"))).toEqual([]);
    const cmd = readFileSync(script, "utf8");
    // Lines after chcp are read as UTF-8; % would expand in a .cmd file: it is doubled.
    expect(cmd.split("\r\n")[1]).toBe("chcp 65001 >nul");
    expect(cmd).toContain(`set "PATH=/usr/local/bin:/opt/it's here:%%APPDATA%%"`);
    // A CA file is carried to the run; a proxy with a password and anything else are not.
    expect(cmd).toContain(`set "NODE_EXTRA_CA_CERTS=/etc/corp-ca.pem"`);
    expect(cmd).not.toMatch(/secret|SF_ACCESS_TOKEN/);
    // npx comes last, without CALL, which would expand % twice.
    expect(cmd).toContain(`\r\nnpx -y sf-agent-po@next index --org prod --workspace "${workspace}" > "${path.join(workspace, "schedule", `prod-${hash6("prod")}.log`)}" 2>&1`);
    expect(cmd).not.toContain("call ");
    expect(pc.out[0]).toMatch(/^prod is indexed every day at 02:00 by Task Scheduler/);

    // Scheduled again from a terminal that names the folder in other letter case: the same task.
    pc.calls.length = 0;
    await runSchedule({ action: "add", org: "prod", at: { hour: 2, minute: 0 }, workspace: workspace.replace("my project", "MY PROJECT") }, pc.deps).catch(() => undefined);
    expect(pc.calls.filter((c) => c.cmd === "schtasks").map((c) => c.args[2])).toEqual([create.args[2]]);
    // Scheduled again where it is recorded: the last task is deleted, then made anew.
    pc.calls.length = 0;
    await runSchedule({ action: "add", org: "prod", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    expect(pc.calls.map((c) => c.args[0])).toEqual(["/Delete", "/Create"]);
    // A scheduler that refuses the delete is an error, and the record stays.
    pc.failDelete("ERROR: Access is denied.");
    await expect(runSchedule({ action: "remove", org: "prod", at: { hour: 2, minute: 0 }, workspace }, pc.deps)).rejects.toThrow(/Access is denied/);
    expect(existsSync(script)).toBe(true);
    // One that has no such task is not.
    pc.failDelete("ERROR: The system cannot find the file specified.");
    pc.calls.length = 0;
    await runSchedule({ action: "remove", org: "prod", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    expect(pc.calls).toEqual([{ cmd: "schtasks", args: ["/Delete", "/TN", create.args[2], "/F"] }]);
    expect(existsSync(script)).toBe(false);
    expect(pc.out.at(-1)).toBe("The daily refresh of prod is removed.");
  });

  it("loads a launchd agent on macOS, and unloads it", async () => {
    const pc = computer("darwin");
    const workspace = path.join(pc.root, "ws");
    await runSchedule({ action: "add", org: "prod", at: { hour: 6, minute: 5 }, workspace }, pc.deps);
    const load = pc.calls.find((c) => c.cmd === "launchctl" && c.args[0] === "load")!;
    const plist = load.args[2]!;
    expect(path.dirname(plist)).toBe(path.join(pc.deps.home, "Library", "LaunchAgents"));
    const agent = readFileSync(plist, "utf8");
    expect(agent).toContain("<key>Hour</key><integer>6</integer><key>Minute</key><integer>5</integer>");
    const shFile = path.join(workspace, "schedule", `prod-${hash6("prod")}.sh`);
    expect(agent).toContain(`<string>${shFile}</string>`);
    // launchd's own errors go where a folder macOS protects cannot hide them.
    expect(agent).toContain(`<key>StandardErrorPath</key><string>${path.join(pc.deps.home, "Library", "Logs", "sf-agent-po")}`);
    const sh = readFileSync(shFile, "utf8");
    // Quoted for sh, a quote in PATH included.
    expect(sh).toContain(`PATH='/usr/local/bin:/opt/it'\\''s here:%APPDATA%'; export PATH`);
    expect(sh).toContain("NODE_EXTRA_CA_CERTS='/etc/corp-ca.pem'; export NODE_EXTRA_CA_CERTS");
    expect(sh).not.toMatch(/secret|SF_ACCESS_TOKEN/);
    expect(sh).toContain(`'npx' '-y' 'sf-agent-po@next' 'index' '--org' 'prod' '--workspace' '${workspace}' > '${path.join(workspace, "schedule", `prod-${hash6("prod")}.log`)}' 2>&1`);
    await runSchedule({ action: "remove", org: "prod", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    expect(pc.calls.at(-1)).toEqual({ cmd: "launchctl", args: ["unload", "-w", plist] });
    expect(existsSync(plist)).toBe(false);
  });

  it("keeps the rest of the crontab on Linux, and replaces its own line", async () => {
    const pc = computer("linux");
    const workspace = path.join(pc.root, "ws");
    pc.setCrontab("0 9 * * 1 backup.sh\n\n# nightly\n0 1 * * * other.sh");
    await runSchedule({ action: "add", org: "prod", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    await runSchedule({ action: "add", org: "prod", at: { hour: 3, minute: 15 }, workspace }, pc.deps);
    const lines = pc.crontab()!.trim().split("\n");
    // The user's lines stay as they were, blank ones too.
    expect(lines).toEqual(["0 9 * * 1 backup.sh", "", "# nightly", "0 1 * * * other.sh", expect.stringMatching(/^15 3 \* \* \* \/bin\/sh '.+prod-[0-9a-f]{6}\.sh' # sf-agent-po index prod [0-9a-f]{8}$/)]);
    expect(pc.out).toContain("cron does not run what it missed while the computer was off.");
    // Another workspace's schedule of the same org is another line.
    await runSchedule({ action: "add", org: "prod", at: { hour: 4, minute: 0 }, workspace: path.join(pc.root, "other") }, pc.deps);
    expect(pc.crontab()!.trim().split("\n")).toHaveLength(6);
    await runSchedule({ action: "remove", org: "prod", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    expect(pc.crontab()!.trim().split("\n")).toEqual(["0 9 * * 1 backup.sh", "", "# nightly", "0 1 * * * other.sh", expect.stringMatching(/^0 4 /)]);
    // A crontab that cannot be read is never replaced: the user's lines would be lost.
    pc.failCrontab("Permission denied");
    const before = pc.crontab();
    await expect(runSchedule({ action: "add", org: "uat", at: { hour: 2, minute: 0 }, workspace }, pc.deps)).rejects.toThrow(/Permission denied/);
    expect(pc.crontab()).toBe(before);
    expect(existsSync(path.join(workspace, "schedule", "crontab.next"))).toBe(false);
  });

  it("keeps two orgs whose names differ only in signs or case apart", async () => {
    const pc = computer("linux");
    const workspace = path.join(pc.root, "ws");
    for (const org of ["a@b.com", "a+b.com", "Prod", "prod"]) await runSchedule({ action: "add", org, at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    expect(new Set(readdirSync(path.join(workspace, "schedule")).filter((f) => f.endsWith(".sh")).map((f) => f.toLowerCase())).size).toBe(4);
    expect(pc.crontab()!.trim().split("\n")).toHaveLength(4);
  });

  it("lists the workspace's schedules with their last run", async () => {
    const pc = computer("linux");
    const workspace = path.join(pc.root, "ws");
    await runSchedule({ action: "list", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    expect(pc.out.at(-1)).toBe("No org is indexed on a schedule in this workspace.");
    await runSchedule({ action: "add", org: "prod", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    await runSchedule({ action: "add", org: "uat", at: { hour: 2, minute: 30 }, workspace }, pc.deps);
    await runSchedule({ action: "add", org: "dev", at: { hour: 3, minute: 0 }, workspace }, pc.deps);
    writeFileSync(path.join(workspace, "schedule", `prod-${hash6("prod")}.log`), "Listing the metadata in prod\nIndexed 71413 components, 9 links, 2 referenced from outside the project.\nTime per step:\n");
    writeFileSync(path.join(workspace, "schedule", `dev-${hash6("dev")}.log`), "Listing the metadata in dev\nsf org display failed: expired session\nTime per step:\n  Listing the metadata in dev: 3s\n  In all: 3s\n");
    pc.out.length = 0;
    await runSchedule({ action: "list", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    expect(pc.out.sort()).toEqual([
      expect.stringMatching(/^dev: every day at 03:00 \(cron\); last run \d{4}-\d\d-\d\d \d\d:\d\d failed or is still running: sf org display failed: expired session$/),
      expect.stringMatching(/^prod: every day at 02:00 \(cron\); last run \d{4}-\d\d-\d\d \d\d:\d\d: Indexed 71413 components/),
      "uat: every day at 02:30 (cron); not run yet",
    ]);
  });
});
