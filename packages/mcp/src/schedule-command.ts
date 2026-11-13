// `sf-agent-po schedule`: refreshes an org's metadata index every day with the computer's own
// scheduler (Task Scheduler, launchd or cron), so that nobody waits for a large org. Each run
// is the index command, with the user's sf CLI login; nothing runs in the cloud.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const SCHEDULE_USAGE = `Usage: npx sf-agent-po@next schedule --org <alias or username> [--at HH:MM] [--workspace <folder>]
       npx sf-agent-po@next schedule (--project <folder> | --repo <repository>) --packages <a,b,...> --name <set> [--for-org <alias>] [--at HH:MM] [--workspace <folder>]
       npx sf-agent-po@next schedule --remove (--org <alias or username> | (--project <folder> | --repo <repository>) --name <set>) [--workspace <folder>]
       npx sf-agent-po@next schedule --list [--workspace <folder>]

Refreshes the metadata index of an org every day, at 02:00 by default (your local
time), with your computer's scheduler: Task Scheduler on Windows, launchd on
macOS, cron on Linux. Each run is the index command for the workspace
(SF_AGENT_WORKSPACE, else .sf-agent here): only what changed is retrieved, and all
of it once a week. It runs as you, with your sf CLI login. On Windows it runs while
you are logged in (a console window shows it; closing the window stops the run),
and a run missed while the computer was off starts once you log on again; on macOS a
run missed while the Mac slept starts when it wakes. Each run writes its output to a
log in <workspace>/schedule. Scheduling an org again replaces its schedule; --remove
takes it away; --list shows the workspace's schedules and how each last ran.

A folder set (see index --help) is refreshed the same way, with the options the index
command takes for it; a repository is fetched again before each run, a project folder
is read as it is on disk.`;

/** A folder set to refresh, as the index command takes it. */
export interface ScheduledSet {
  /** A project folder (absolute), or a repository (github:owner/repo...). */
  project?: string;
  repo?: string;
  name: string;
  /** Empty for --remove. */
  packages: string[];
  forOrg?: string;
}

export interface ScheduleArgs {
  action: "add" | "remove" | "list";
  org?: string;
  set?: ScheduledSet;
  at: { hour: number; minute: number };
  workspace: string;
}

/** Org aliases and usernames, as the index command takes them: nothing a shell could read as more. */
const ORG_ARG = /^[\w.@+-]+$/;
/** A folder set's name, as the index command takes it. */
const SET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
/** What goes in a script inside quotes: no quote and no line break, which no quoting survives. */
const QUOTABLE = /^[^"\r\n]+$/;

export function parseScheduleArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ScheduleArgs | { help: string } {
  let workspace = path.resolve(env.SF_AGENT_WORKSPACE ?? path.join(cwd, ".sf-agent"));
  let org: string | undefined;
  let project: string | undefined;
  let repo: string | undefined;
  let packages: string[] | undefined;
  let name: string | undefined;
  let forOrg: string | undefined;
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
    else if (arg === "--project") project = path.resolve(cwd, value(++i, arg));
    else if (arg === "--repo") repo = value(++i, arg);
    else if (arg === "--packages") packages = value(++i, arg).split(",").map((p) => p.trim()).filter(Boolean);
    else if (arg === "--name") name = value(++i, arg);
    else if (arg === "--for-org") forOrg = value(++i, arg);
    else if (arg === "--workspace") workspace = path.resolve(cwd, value(++i, arg));
    else if (arg === "--at") {
      const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value(++i, arg));
      if (!m) throw new Error(`--at takes a time of day such as 02:00 or 23:30.\n\n${SCHEDULE_USAGE}`);
      at = { hour: Number(m[1]), minute: Number(m[2]) };
    } else if (arg === "--remove") action = "remove";
    else if (arg === "--list") action = "list";
    else throw new Error(`Unknown option "${arg}".\n\n${SCHEDULE_USAGE}`);
  }
  const setFlags = [project, repo, packages, name, forOrg].some((v) => v !== undefined);
  if (action === "list") {
    if (org || setFlags) throw new Error(`--list shows every schedule of the workspace: leave out the other options.\n\n${SCHEDULE_USAGE}`);
    return { action, at, workspace };
  }
  if (org && setFlags) throw new Error(`Give --org, or a folder set (--project or --repo with --name), not both.\n\n${SCHEDULE_USAGE}`);
  if (org) {
    if (!ORG_ARG.test(org) || org.startsWith("-")) throw new Error(`"${org}" is not an org alias or username.`);
    return { action, org, at, workspace };
  }
  if (!setFlags) throw new Error(`Give --org, or a folder set (--project or --repo with --name).\n\n${SCHEDULE_USAGE}`);
  if ((project === undefined) === (repo === undefined)) throw new Error(`A folder set takes one of --project or --repo.\n\n${SCHEDULE_USAGE}`);
  if (name === undefined || !SET_NAME.test(name)) throw new Error(`A folder set needs --name: letters, digits, ".", "_" or "-", up to 40.\n\n${SCHEDULE_USAGE}`);
  if (action === "add" && !packages?.length) throw new Error(`A folder set needs --packages, as the index command takes them.\n\n${SCHEDULE_USAGE}`);
  if (action === "remove" && (packages || forOrg)) throw new Error(`--remove needs only the folder set's --project or --repo and --name.\n\n${SCHEDULE_USAGE}`);
  if (forOrg !== undefined && !/^org:00D[0-9A-Za-z]{15}$/.test(forOrg) && (!ORG_ARG.test(forOrg) || forOrg.startsWith("-"))) throw new Error(`"${forOrg}" is not an org alias or username, nor an org's source (org:00D...).`);
  for (const v of [project, repo, ...(packages ?? [])]) if (v !== undefined && (!QUOTABLE.test(v) || v.startsWith("-"))) throw new Error(`"${v}" cannot be scheduled: it holds a quote or a line break, or starts with "-".`);
  const set: ScheduledSet = { ...(project ? { project } : {}), ...(repo ? { repo } : {}), name, packages: packages ?? [], ...(forOrg ? { forOrg } : {}) };
  return { action, set, at, workspace };
}

/** What the command needs from the computer, so that tests can stand in for it. */
export interface ScheduleDeps {
  platform: NodeJS.Platform;
  home: string;
  /** The folder the runs start in: the one the command was run from. */
  cwd: string;
  /** PATH as it is now, given to the runs: schedulers start programs with a short one. */
  pathEnv: string;
  /** The rest of the environment, for the few variables a run needs too (a CA file, a proxy). */
  env?: NodeJS.ProcessEnv;
  /** Runs a program without a shell. */
  run(cmd: string, args: string[]): Promise<{ stdout: string }>;
  out(text: string): void;
}

/** What a schedule is recorded as, beside its script. */
interface Record_ {
  /** An org's schedule, or a folder set's (with no org). */
  org?: string;
  set?: ScheduledSet;
  at: string;
  scheduler: "Task Scheduler" | "launchd" | "cron";
  /** The task name, the launchd label, or the crontab line's marker. */
  id: string;
  /** The launchd agent's file. */
  plist?: string;
}

/**
 * Variables a run needs that a scheduler does not pass on from the shell: how Node trusts a
 * company's certificates, and a proxy (one with a password in it is left out: the script is a
 * plain file).
 */
const CARRIED = ["NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"];
const carried = (env: NodeJS.ProcessEnv = {}) => CARRIED.flatMap((k) => (env[k] && !env[k]!.includes("@") && !/[\r\n"]/.test(env[k]!) ? [[k, env[k]!] as const] : []));

const pad = (n: number) => String(n).padStart(2, "0");
const hash = (s: string, n: number) => createHash("sha256").update(s).digest("hex").slice(0, n);
/** Quoted for sh: inside single quotes, nothing is special but the quote itself. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Inside double quotes in a .cmd file, only % still expands (the script never uses CALL, which would expand it twice). */
const cmdq = (s: string) => s.replace(/%/g, "%%");
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The names of one org's schedule in one workspace: two workspaces can schedule one org. The
 * workspace's path is compared without case where its file system ignores it, and the files
 * carry a hash of the org, so that two orgs never share them (a@b.com, a+b.com; Prod, prod).
 */
function names(workspace: string, what: { org?: string; set?: ScheduledSet; where?: string }, platform: NodeJS.Platform) {
  const fold = (p: string) => (platform === "win32" || platform === "darwin" ? p.toLowerCase() : p);
  const ws = hash(fold(path.resolve(workspace)), 8);
  if (what.set) {
    // A set is one name in one project or repository (by its source, however it was spelt): both name its files.
    const where = what.set.project ? fold(path.resolve(what.set.project)) : what.where!;
    const h = hash(`${where}\0${what.set.name}`, 6);
    const file = `set-${what.set.name}-${h}`;
    return { file, task: `sf-agent-po index set ${what.set.name} ${h} ${ws}`, label: `com.sf-agent-po.index.${ws}.${file}`, marker: `# sf-agent-po index set ${what.set.name} ${h} ${ws}` };
  }
  const org = what.org!;
  const file = `${org.replace(/[^\w.-]/g, "_")}-${hash(org, 6)}`;
  return {
    file,
    task: `sf-agent-po index ${org} ${ws}`,
    label: `com.sf-agent-po.index.${ws}.${file}`,
    marker: `# sf-agent-po index ${org} ${ws}`,
  };
}

/** The index command's options for what is scheduled. */
function indexArgs(what: { org?: string; set?: ScheduledSet }): string[] {
  if (!what.set) return ["--org", what.org!];
  const s = what.set;
  return [s.project ? "--project" : "--repo", (s.project ?? s.repo)!, "--packages", s.packages.join(","), "--name", s.name, ...(s.forOrg ? ["--for-org", s.forOrg] : [])];
}

/** What a schedule is about, in a sentence: the org, or the folder set (with where it is, for a list). */
const describe = (what: { org?: string; set?: ScheduledSet }, where = false) =>
  what.set ? `folder set ${what.set.name}${where ? ` of ${what.set.project ?? what.set.repo}` : ""}` : what.org!;

/**
 * Checks a folder set as the index command will, before anything is written: a repository
 * that would fail every night, or that carries a password or token in its URL (the script
 * and the record are plain files), is refused. Returns the repository's source.
 */
async function checkSet(set: ScheduledSet, adding: boolean): Promise<string | undefined> {
  const { checkFolderSet, parseRepoSpec, redactLocation, repoSource } = await import("@sf-agent-po/connectors");
  if (adding) checkFolderSet({ name: set.name, packages: set.packages, ...(set.forOrg ? { forOrg: set.forOrg } : {}) });
  if (!set.repo) return undefined;
  const spec = parseRepoSpec(set.repo);
  if (redactLocation(spec.location) !== spec.location) throw new Error("This repository's URL holds a password or token, which the schedule would write in plain files: sign in with gh auth login, glab auth login or your git credential manager, and give the URL without it.");
  // The hash of where the repository is, which its spelling does not change (github:Acme/Mono, github:acme/mono).
  return /#([0-9a-f]{8})$/.exec(repoSource(spec))?.[1] ?? repoSource(spec);
}

/** A scheduler's answer that the task was not there: nothing to remove. */
const notThere = (err: unknown) => /cannot find|does not exist|not found|No such|Could not find/i.test((err as Error)?.message ?? "");

/** Runs `schedule`; returns the exit code. */
export async function runSchedule(opts: ScheduleArgs, deps: ScheduleDeps): Promise<number> {
  const dir = path.join(opts.workspace, "schedule");
  if (opts.action === "list") return list(dir, deps);
  const where = opts.set ? await checkSet(opts.set, opts.action === "add") : undefined;
  const what = { ...(opts.org ? { org: opts.org } : {}), ...(opts.set ? { set: opts.set } : {}) };
  const org = describe(what);
  const n = names(opts.workspace, { ...what, ...(where ? { where } : {}) }, deps.platform);
  const scheduler = deps.platform === "win32" ? "Task Scheduler" : deps.platform === "darwin" ? "launchd" : "cron";
  const recordFile = path.join(dir, `${n.file}.json`);
  const script = path.join(dir, `${n.file}${deps.platform === "win32" ? ".cmd" : ".sh"}`);
  const log = path.join(dir, `${n.file}.log`);
  const plist = path.join(deps.home, "Library", "LaunchAgents", `${n.label}.plist`);
  // What this org's last schedule registered, under the names it had then.
  const previous = await readFile(recordFile, "utf8").then((t) => JSON.parse(t) as Record_, () => undefined);

  /** Takes the last registration away; a scheduler that refuses is an error, one that has no such task is not. */
  const unregister = async () => {
    const ids = new Set([n.task, ...(previous?.scheduler === "Task Scheduler" ? [previous.id] : [])]);
    if (scheduler === "Task Scheduler") {
      for (const id of ids) await deps.run("schtasks", ["/Delete", "/TN", id, "/F"]).catch((err: unknown) => {
        if (!notThere(err)) throw err;
      });
    } else if (scheduler === "launchd") {
      for (const p of new Set([plist, ...(previous?.plist ? [previous.plist] : [])])) {
        await deps.run("launchctl", ["unload", "-w", p]).catch(() => undefined);
        await rm(p, { force: true });
      }
    } else await writeCrontab(deps, dir, [n.marker, ...(previous?.scheduler === "cron" ? [previous.id] : [])]);
  };

  if (opts.action === "remove") {
    if (!previous && opts.set) {
      // Not this spelling: name the workspace's sets of that name, rather than say it is done.
      const others = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(`set-${opts.set!.name}-`) && f.endsWith(".json"));
      if (others.length) {
        const found = await Promise.all(others.map(async (f) => describe(JSON.parse(await readFile(path.join(dir, f), "utf8")) as Record_, true)));
        throw new Error(`No schedule of ${org} of ${opts.set.project ?? opts.set.repo} is recorded in this workspace. Recorded: ${found.join("; ")}.`);
      }
    }
    await unregister();
    for (const f of [recordFile, script]) await rm(f, { force: true });
    deps.out(previous ? `The daily refresh of ${org} is removed.` : `${org} had no daily refresh recorded in this workspace; any ${scheduler} entry of it is removed.`);
    return 0;
  }

  await mkdir(dir, { recursive: true });
  const command = ["npx", "-y", "sf-agent-po@next", "index", ...indexArgs(what), "--workspace"];
  // In the .cmd file, an argument with a space or a sign cmd reads is put in double quotes.
  // Backslashes before the closing quote are doubled, so that D:\ does not end in \".
  const cmdArg = (a: string) => (/^[\w.@+:,\/-]+$/.test(a) ? a : `"${cmdq(a).replace(/(\\+)$/, "$1$1")}"`);
  const env = carried(deps.env);
  if (deps.platform === "win32") {
    // A path with a letter outside ASCII must survive: cmd reads the lines after chcp as UTF-8.
    // npx is a batch file too, called last without CALL, which would expand % a second time.
    await writeFile(
      script,
      [
        "@echo off",
        "chcp 65001 >nul",
        `rem Written by sf-agent-po schedule: refreshes the metadata index of ${org} each day.`,
        `set "PATH=${cmdq(deps.pathEnv)}"`,
        ...env.map(([k, v]) => `set "${k}=${cmdq(v)}"`),
        `cd /d "${cmdq(deps.cwd)}"`,
        `${[...command, opts.workspace].map((a, i, all) => (i === all.length - 1 ? `"${cmdq(a).replace(/(\\+)$/, "$1$1")}"` : cmdArg(a))).join(" ")} > "${cmdq(log)}" 2>&1`,
        "",
      ].join("\r\n"),
    );
    if (previous) await unregister();
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
        ...env.map(([k, v]) => `${k}=${sq(v)}; export ${k}`),
        `cd ${sq(deps.cwd)} || exit 1`,
        `${command.map(sq).join(" ")} ${sq(opts.workspace)} > ${sq(log)} 2>&1`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    if (scheduler === "launchd") {
      if (previous) await unregister();
      await mkdir(path.dirname(plist), { recursive: true });
      // launchd's own errors (macOS refusing a folder under Documents or Desktop) go where the
      // user can find them: the run's log may be in the refused folder.
      const errors = path.join(deps.home, "Library", "Logs", "sf-agent-po", `${n.label}.log`);
      await mkdir(path.dirname(errors), { recursive: true });
      await writeFile(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(n.label)}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(script)}</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${opts.at.hour}</integer><key>Minute</key><integer>${opts.at.minute}</integer></dict>
  <key>StandardOutPath</key><string>${xml(errors)}</string>
  <key>StandardErrorPath</key><string>${xml(errors)}</string>
</dict>
</plist>
`,
      );
      // Loaded again, so that a new time is taken.
      await deps.run("launchctl", ["unload", plist]).catch(() => undefined);
      await deps.run("launchctl", ["load", "-w", plist]);
    } else {
      // In a crontab line, % ends the command: it is escaped.
      const line = `${opts.at.minute} ${opts.at.hour} * * * /bin/sh ${sq(script).replace(/%/g, "\\%")} ${n.marker}`;
      await writeCrontab(deps, dir, [n.marker, ...(previous?.scheduler === "cron" ? [previous.id] : [])], line);
    }
  }
  const at = `${pad(opts.at.hour)}:${pad(opts.at.minute)}`;
  const record: Record_ = { ...what, at, scheduler, id: scheduler === "Task Scheduler" ? n.task : scheduler === "launchd" ? n.label : n.marker, ...(scheduler === "launchd" ? { plist } : {}) };
  await writeFile(recordFile, JSON.stringify(record, null, 2));
  deps.out(`${org} is indexed every day at ${at} by ${scheduler}. Each run writes ${path.relative(deps.cwd, log) || log}.`);
  if (scheduler === "cron") deps.out("cron does not run what it missed while the computer was off.");
  if (scheduler === "launchd") deps.out(`If macOS refuses the run access to this folder (under Documents or Desktop), it says so in ~/Library/Logs/sf-agent-po.`);
  return 0;
}

/** The user's crontab without the lines of these markers, and with `line` when given. */
async function writeCrontab(deps: ScheduleDeps, dir: string, markers: readonly string[], line?: string): Promise<void> {
  // No crontab yet is the one failure that means there is nothing to keep: any other could
  // mean losing the user's lines.
  const now = await deps.run("crontab", ["-l"]).then(
    (r) => r.stdout,
    (err: unknown) => {
      if (/no crontab/i.test((err as Error)?.message ?? "")) return "";
      throw err;
    },
  );
  const lines = now.replace(/\n+$/, "").split("\n");
  const kept = lines.filter((l) => !markers.some((m) => l.endsWith(m)));
  if (!line && kept.length === lines.length) return;
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "crontab.next");
  await writeFile(file, `${[...kept.filter((l, i) => l || i < kept.length - 1), ...(line ? [line] : [])].join("\n")}\n`);
  try {
    await deps.run("crontab", [file]);
  } finally {
    await rm(file, { force: true });
  }
}

/** A time as the user reads it: their local date and time. */
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The workspace's schedules, with when each last ran and how it went. */
async function list(dir: string, deps: ScheduleDeps): Promise<number> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) {
    deps.out("Nothing is indexed on a schedule in this workspace.");
    return 0;
  }
  for (const f of files) {
    const r = JSON.parse(await readFile(path.join(dir, f), "utf8")) as Record_;
    const log = path.join(dir, f.replace(/\.json$/, ".log"));
    const ran = await stat(log).then((s) => s.mtime, () => undefined);
    const lines = ran ? (await readFile(log, "utf8")).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
    let how = "";
    if (ran) {
      const indexed = lines.find((l) => l.startsWith("Indexed "));
      const timed = lines.indexOf("Time per step:");
      // A failed run prints its error, then the time of each step.
      const error = (timed > 0 ? lines[timed - 1] : lines.at(-1)) ?? "no output";
      how = indexed ? `; last run ${local(ran)}: ${indexed}` : timed >= 0 || lines.length ? `; last run ${local(ran)} failed or is still running: ${error}` : `; last run ${local(ran)}: no output`;
    }
    deps.out(`${describe(r, true)}: every day at ${r.at} (${r.scheduler})${how || "; not run yet"}`);
  }
  return 0;
}
