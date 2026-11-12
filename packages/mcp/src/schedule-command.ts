// `sf-agent-po schedule`: refreshes an org's metadata index every day with the computer's own
// scheduler (Task Scheduler, launchd or cron), so that nobody waits for a large org. Each run
// is the index command, with the user's sf CLI login; nothing runs in the cloud.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const SCHEDULE_USAGE = `Usage: npx sf-agent-po@next schedule --org <alias or username> [--at HH:MM] [--workspace <folder>]
       npx sf-agent-po@next schedule --remove --org <alias or username> [--workspace <folder>]
       npx sf-agent-po@next schedule --list [--workspace <folder>]

Refreshes the metadata index of an org every day, at 02:00 by default (your local
time), with your computer's scheduler: Task Scheduler on Windows, launchd on
macOS, cron on Linux. Each run is the index command for the workspace
(SF_AGENT_WORKSPACE, else .sf-agent here): only what changed is retrieved, and all
of it once a week. It runs as you, with your sf CLI login, while you are logged
in; on Windows and macOS a run missed while the computer was off or asleep starts
when it is back. Its output goes to <workspace>/schedule/<org>.log. Scheduling an
org again replaces its schedule; --remove takes it away; --list shows the
workspace's schedules.`;

export interface ScheduleArgs {
  action: "add" | "remove" | "list";
  org?: string;
  at: { hour: number; minute: number };
  workspace: string;
}

/** Org aliases and usernames, as the index command takes them: nothing a shell could read as more. */
const ORG_ARG = /^[\w.@+-]+$/;

export function parseScheduleArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ScheduleArgs | { help: string } {
  let workspace = path.resolve(env.SF_AGENT_WORKSPACE ?? path.join(cwd, ".sf-agent"));
  let org: string | undefined;
  let at = { hour: 2, minute: 0 };
  let action: ScheduleArgs["action"] = "add";
  const value = (i: number, flag: string) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value.\n\n${SCHEDULE_USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { help: SCHEDULE_USAGE };
    if (arg === "--org") org = value(++i, arg);
    else if (arg === "--workspace") workspace = path.resolve(cwd, value(++i, arg));
    else if (arg === "--at") {
      const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value(++i, arg));
      if (!m) throw new Error(`--at takes a time of day such as 02:00 or 23:30.\n\n${SCHEDULE_USAGE}`);
      at = { hour: Number(m[1]), minute: Number(m[2]) };
    } else if (arg === "--remove") action = "remove";
    else if (arg === "--list") action = "list";
    else throw new Error(`Unknown option "${arg}".\n\n${SCHEDULE_USAGE}`);
  }
  if (action !== "list") {
    if (!org) throw new Error(`Give --org.\n\n${SCHEDULE_USAGE}`);
    if (!ORG_ARG.test(org) || org.startsWith("-")) throw new Error(`"${org}" is not an org alias or username.`);
  } else if (org) throw new Error(`--list shows every schedule of the workspace: leave out --org.\n\n${SCHEDULE_USAGE}`);
  return { action, ...(org ? { org } : {}), at, workspace };
}

/** What the command needs from the computer, so that tests can stand in for it. */
export interface ScheduleDeps {
  platform: NodeJS.Platform;
  home: string;
  /** The folder the runs start in: the one the command was run from. */
  cwd: string;
  /** PATH as it is now, given to the runs: schedulers start programs with a short one. */
  pathEnv: string;
  /** Runs a program without a shell. */
  run(cmd: string, args: string[]): Promise<{ stdout: string }>;
  out(text: string): void;
}

/** What a schedule is recorded as, beside its script. */
interface Record_ {
  org: string;
  at: string;
  scheduler: "Task Scheduler" | "launchd" | "cron";
  /** The task name, the launchd label, or the crontab line's marker. */
  id: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Quoted for sh: inside single quotes, nothing is special but the quote itself. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Inside double quotes in a .cmd file, only % still expands. */
const cmdq = (s: string) => s.replace(/%/g, "%%");
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The names of one org's schedule in one workspace: two workspaces can schedule one org. */
function names(workspace: string, org: string) {
  const hash = createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 8);
  const file = org.replace(/[^\w.-]/g, "_");
  return {
    file,
    task: `sf-agent-po index ${org} ${hash}`,
    label: `com.sf-agent-po.index.${hash}.${file}`,
    marker: `# sf-agent-po index ${org} ${hash}`,
  };
}

/** Runs `schedule`; returns the exit code. */
export async function runSchedule(opts: ScheduleArgs, deps: ScheduleDeps): Promise<number> {
  const dir = path.join(opts.workspace, "schedule");
  if (opts.action === "list") return list(dir, deps);
  const org = opts.org!;
  const n = names(opts.workspace, org);
  const scheduler = deps.platform === "win32" ? "Task Scheduler" : deps.platform === "darwin" ? "launchd" : "cron";
  const record = path.join(dir, `${n.file}.json`);
  const script = path.join(dir, `${n.file}${deps.platform === "win32" ? ".cmd" : ".sh"}`);
  const log = path.join(dir, `${n.file}.log`);
  const plist = path.join(deps.home, "Library", "LaunchAgents", `${n.label}.plist`);

  if (opts.action === "remove") {
    if (scheduler === "Task Scheduler") await deps.run("schtasks", ["/Delete", "/TN", n.task, "/F"]).catch(() => undefined);
    else if (scheduler === "launchd") {
      await deps.run("launchctl", ["unload", "-w", plist]).catch(() => undefined);
      await rm(plist, { force: true });
    } else await writeCrontab(deps, dir, n.marker);
    const had = await stat(record).then(() => true, () => false);
    for (const f of [record, script]) await rm(f, { force: true });
    deps.out(had ? `The daily refresh of ${org} is removed.` : `${org} had no daily refresh in this workspace; nothing else was changed.`);
    return 0;
  }

  await mkdir(dir, { recursive: true });
  const command = ["npx", "-y", "sf-agent-po@next", "index", "--org", org, "--workspace"];
  if (deps.platform === "win32") {
    await writeFile(
      script,
      [
        "@echo off",
        `rem Written by sf-agent-po schedule: refreshes the metadata index of ${org} each day.`,
        `set "PATH=${cmdq(deps.pathEnv)}"`,
        `cd /d "${cmdq(deps.cwd)}"`,
        `call ${command.join(" ")} "${cmdq(opts.workspace)}" > "${cmdq(log)}" 2>&1`,
        "",
      ].join("\r\n"),
    );
    // A task file, not /TR: its command and folder need no quoting, whatever spaces they hold.
    const task = path.join(dir, `${n.file}.task.xml`);
    const start = `2000-01-01T${pad(opts.at.hour)}:${pad(opts.at.minute)}:00`;
    const body = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Refreshes the sf-agent-po metadata index of ${xml(org)} each day.</Description></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>${start}</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT6H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(script)}</Command><WorkingDirectory>${xml(deps.cwd)}</WorkingDirectory></Exec></Actions>
</Task>
`;
    await writeFile(task, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body.replace(/\n/g, "\r\n"), "utf16le")]));
    try {
      await deps.run("schtasks", ["/Create", "/TN", n.task, "/XML", task, "/F"]);
    } finally {
      await rm(task, { force: true });
    }
  } else {
    await writeFile(
      script,
      [
        "#!/bin/sh",
        `# Written by sf-agent-po schedule: refreshes the metadata index of ${org} each day.`,
        `PATH=${sq(deps.pathEnv)}; export PATH`,
        `cd ${sq(deps.cwd)} || exit 1`,
        `${command.map(sq).join(" ")} ${sq(opts.workspace)} > ${sq(log)} 2>&1`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    if (scheduler === "launchd") {
      await mkdir(path.dirname(plist), { recursive: true });
      await writeFile(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(n.label)}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(script)}</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${opts.at.hour}</integer><key>Minute</key><integer>${opts.at.minute}</integer></dict>
</dict>
</plist>
`,
      );
      // Loaded again, so that a new time is taken.
      await deps.run("launchctl", ["unload", plist]).catch(() => undefined);
      await deps.run("launchctl", ["load", "-w", plist]);
    } else await writeCrontab(deps, dir, n.marker, `${opts.at.minute} ${opts.at.hour} * * * /bin/sh ${sq(script)} ${n.marker}`);
  }
  const at = `${pad(opts.at.hour)}:${pad(opts.at.minute)}`;
  await writeFile(record, JSON.stringify({ org, at, scheduler, id: scheduler === "Task Scheduler" ? n.task : scheduler === "launchd" ? n.label : n.marker } satisfies Record_, null, 2));
  deps.out(`${org} is indexed every day at ${at} by ${scheduler}. Each run writes ${path.relative(deps.cwd, log) || log}.`);
  if (scheduler === "cron") deps.out("cron does not run what it missed while the computer was off.");
  return 0;
}

/** The user's crontab without the line of this schedule, and with `line` when given. */
async function writeCrontab(deps: ScheduleDeps, dir: string, marker: string, line?: string): Promise<void> {
  // No crontab yet: crontab -l fails, and there is nothing to keep.
  const now = await deps.run("crontab", ["-l"]).then((r) => r.stdout, () => "");
  const kept = now.split("\n").filter((l) => l.trim() && !l.endsWith(marker));
  if (!line && kept.length === now.split("\n").filter((l) => l.trim()).length) return;
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "crontab.next");
  await writeFile(file, `${[...kept, ...(line ? [line] : [])].join("\n")}\n`);
  try {
    await deps.run("crontab", [file]);
  } finally {
    await rm(file, { force: true });
  }
}

/** The workspace's schedules, with when each last ran and what it said. */
async function list(dir: string, deps: ScheduleDeps): Promise<number> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) {
    deps.out("No org is indexed on a schedule in this workspace.");
    return 0;
  }
  for (const f of files) {
    const r = JSON.parse(await readFile(path.join(dir, f), "utf8")) as Record_;
    const log = path.join(dir, f.replace(/\.json$/, ".log"));
    const ran = await stat(log).then((s) => s.mtime.toISOString(), () => undefined);
    const lines = ran ? (await readFile(log, "utf8")).split(/\r?\n/).filter((l) => l.trim()) : [];
    const said = lines.find((l) => l.startsWith("Indexed ")) ?? lines.at(-1);
    deps.out(`${r.org}: every day at ${r.at} (${r.scheduler})${ran ? `; last run ${ran}${said ? `: ${said.trim()}` : ""}` : "; not run yet"}`);
  }
  return 0;
}
