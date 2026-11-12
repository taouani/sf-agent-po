import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseScheduleArgs, runSchedule, SCHEDULE_USAGE, type ScheduleDeps } from "../src/schedule-command.js";

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
  const out: string[] = [];
  const root = tmp();
  const deps: ScheduleDeps = {
    platform,
    home: path.join(root, "home user"),
    cwd: path.join(root, "my project"),
    pathEnv: "/usr/local/bin:/opt/it's here:%APPDATA%",
    out: (t) => out.push(t),
    run: async (cmd, args) => {
      // The files a command is given are read now: they are removed once it returns.
      const given = args.find((a) => a.endsWith(".xml") || a.endsWith("crontab.next"));
      calls.push({ cmd, args, ...(given && existsSync(given) ? { file: readFileSync(given, given.endsWith(".xml") ? "utf16le" : "utf8") } : {}) });
      if (cmd === "crontab" && args[0] === "-l") {
        if (crontab === undefined) throw new Error("crontab failed: no crontab for user");
        return { stdout: crontab };
      }
      if (cmd === "crontab") crontab = readFileSync(args[0]!, "utf8");
      return { stdout: "" };
    },
  };
  return { deps, calls, out, root, crontab: () => crontab, setCrontab: (c: string) => (crontab = c) };
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
    const script = path.join(workspace, "schedule", "prod.cmd");
    expect(create.file).toContain(`<Command>${script}</Command>`);
    expect(create.file).toContain("<StartBoundary>2000-01-01T02:00:00</StartBoundary>");
    expect(create.file).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    // The task file goes once the task is made.
    expect(existsSync(path.join(workspace, "schedule", "prod.task.xml"))).toBe(false);
    const cmd = readFileSync(script, "utf8");
    // % would expand in a .cmd file: it is doubled.
    expect(cmd).toContain(`set "PATH=/usr/local/bin:/opt/it's here:%%APPDATA%%"`);
    expect(cmd).toContain(`call npx -y sf-agent-po@next index --org prod --workspace "${workspace}" > "${path.join(workspace, "schedule", "prod.log")}" 2>&1`);
    expect(pc.out[0]).toMatch(/^prod is indexed every day at 02:00 by Task Scheduler/);

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
    expect(agent).toContain(`<string>${path.join(workspace, "schedule", "prod.sh")}</string>`);
    const sh = readFileSync(path.join(workspace, "schedule", "prod.sh"), "utf8");
    // Quoted for sh, a quote in PATH included.
    expect(sh).toContain(`PATH='/usr/local/bin:/opt/it'\\''s here:%APPDATA%'; export PATH`);
    expect(sh).toContain(`'npx' '-y' 'sf-agent-po@next' 'index' '--org' 'prod' '--workspace' '${workspace}' > '${path.join(workspace, "schedule", "prod.log")}' 2>&1`);
    await runSchedule({ action: "remove", org: "prod", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    expect(pc.calls.at(-1)).toEqual({ cmd: "launchctl", args: ["unload", "-w", plist] });
    expect(existsSync(plist)).toBe(false);
  });

  it("keeps the rest of the crontab on Linux, and replaces its own line", async () => {
    const pc = computer("linux");
    const workspace = path.join(pc.root, "ws");
    pc.setCrontab("0 9 * * 1 backup.sh\n");
    await runSchedule({ action: "add", org: "prod", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    await runSchedule({ action: "add", org: "prod", at: { hour: 3, minute: 15 }, workspace }, pc.deps);
    const lines = pc.crontab()!.trim().split("\n");
    expect(lines).toEqual(["0 9 * * 1 backup.sh", expect.stringMatching(/^15 3 \* \* \* \/bin\/sh '.+prod\.sh' # sf-agent-po index prod [0-9a-f]{8}$/)]);
    expect(pc.out).toContain("cron does not run what it missed while the computer was off.");
    // Another workspace's schedule of the same org is another line.
    await runSchedule({ action: "add", org: "prod", at: { hour: 4, minute: 0 }, workspace: path.join(pc.root, "other") }, pc.deps);
    expect(pc.crontab()!.trim().split("\n")).toHaveLength(3);
    await runSchedule({ action: "remove", org: "prod", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    expect(pc.crontab()!.trim().split("\n")).toEqual(["0 9 * * 1 backup.sh", expect.stringMatching(/^0 4 /)]);
    expect(existsSync(path.join(workspace, "schedule", "crontab.next"))).toBe(false);
  });

  it("lists the workspace's schedules with their last run", async () => {
    const pc = computer("linux");
    const workspace = path.join(pc.root, "ws");
    await runSchedule({ action: "list", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    expect(pc.out.at(-1)).toBe("No org is indexed on a schedule in this workspace.");
    await runSchedule({ action: "add", org: "prod", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    await runSchedule({ action: "add", org: "uat", at: { hour: 2, minute: 30 }, workspace }, pc.deps);
    writeFileSync(path.join(workspace, "schedule", "prod.log"), "Listing the metadata in prod\nIndexed 71413 components, 9 links, 2 referenced from outside the project.\nTime per step:\n");
    pc.out.length = 0;
    await runSchedule({ action: "list", at: { hour: 2, minute: 0 }, workspace }, pc.deps);
    expect(pc.out).toEqual([
      expect.stringMatching(/^prod: every day at 02:00 \(cron\); last run \d{4}-.+: Indexed 71413 components/),
      "uat: every day at 02:30 (cron); not run yet",
    ]);
  });
});
