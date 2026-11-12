#!/usr/bin/env node
// Starts the v1 MCP server on stdio. The workspace (SF_AGENT_WORKSPACE, else .sf-agent in the
// working folder) holds one SQLite database; its vault key is in the OS keychain.

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseInitArgs, runInit, USAGE } from "./hosts/init.js";
import { DOCTOR_USAGE } from "./doctor.js";
import { INDEX_USAGE } from "./index-command.js";
import { keyExportHint, keyImportHint, KEY_USAGE } from "./key-command.js";
import { REPORT_USAGE } from "./report-command.js";
import { SCHEDULE_USAGE } from "./schedule-command.js";

async function main(): Promise<void> {
  // Loaded here, so that init, which only writes files, does not load the store.
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { atlassianConfigFromEnv, AtlassianClient, BackgroundIndexer } = await import("@sf-agent-po/connectors");
  const { ContextRepository, Database, FeedbackRepository, Masker, MetadataIndex, openVault, RequirementRepository, VaultKeyMissingError, WorkflowRepository } = await import("@sf-agent-po/core");
  const { ApprovalServer } = await import("./approval/server.js");
  const { createServer } = await import("./server.js");
  const { databaseFile, ensureWorkspace, lazyDetector, lazyRecognizer } = await import("./startup.js");
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const workspace = path.resolve(process.env.SF_AGENT_WORKSPACE ?? path.join(process.cwd(), ".sf-agent"));
  ensureWorkspace(workspace);
  const database = new Database(databaseFile(workspace));
  let opened: ReturnType<typeof openVault>;
  try {
    opened = openVault(database);
  } catch (err) {
    console.error(`sf-agent-po cannot start: ${(err as Error).message}`);
    if (err instanceof VaultKeyMissingError) console.error(keyImportHint(workspace));
    process.exit(1);
  }
  const { vault, created } = opened;
  if (created?.warning) console.error(created.warning);
  if (created) console.error(keyExportHint(workspace));
  const contexts = new ContextRepository(database);
  const detector = lazyDetector();
  const masker = new Masker({ vault, model: detector });
  const recognizer = lazyRecognizer();
  const approval = new ApprovalServer();
  // Whoever chose this program answers the approval pages: say which one it is, never a page's address.
  const { BROWSER_ENV, browserCommand } = await import("./approval/browser.js");
  if (process.env[BROWSER_ENV]) {
    const own = browserCommand();
    console.error(own ? `Approval pages open with ${path.basename(own.file)} (${BROWSER_ENV}).` : `${BROWSER_ENV} is not a JSON array starting with an absolute path, so approval pages cannot open.`);
  }
  const atlassian = () => {
    const config = atlassianConfigFromEnv();
    if (!config) throw new Error("Jira and Confluence need ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in the server environment.");
    return new AtlassianClient(config);
  };
  const metadata = new MetadataIndex(database);
  const indexer = new BackgroundIndexer(metadata, { workspace });
  const status = async () => {
    const { defaultDoctorDeps, formatChecks, runDoctor } = await import("./doctor.js");
    const opts = { workspace, project: process.cwd(), atlassianCalls: false, model: "files" as const, database, modelLoaded: detector.ready(), keyLoaded: true };
    return formatChecks(await runDoctor(opts, await defaultDoctorDeps()));
  };
  const server = createServer({ contexts, masker, errorMasker: new Masker({ vault }), modelReady: detector.ready, approval, recognizer, version, atlassian, status, metadata: { index: metadata, indexer },
    workflows: { requirements: new RequirementRepository(database), runs: new WorkflowRepository(database) },
    feedback: new FeedbackRepository(database),
  });
  const shutdown = async () => {
    // An indexing run in progress is marked failed, so that the next start need not wait for its lease.
    metadata.abandon("the server stopped");
    // A model download or OCR start in progress is not waited for long.
    await Promise.race([Promise.allSettled([approval.close(), recognizer.close(), detector.release(), server.close()]), new Promise((r) => setTimeout(r, 3000))]);
    database.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  await server.connect(new StdioServerTransport());
}

/** `init` writes the agent files for the user's AI tools into a project; with no command, the server starts. */
async function init(argv: string[]): Promise<void> {
  try {
    const opts = parseInitArgs(argv);
    if ("help" in opts) return console.log(opts.help);
    const report = await runInit(opts);
    for (const line of report) console.log(line);
    if (report.some((line) => line.startsWith("failed"))) process.exitCode = 1;
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

/** `index` fills the workspace's metadata index from a project folder or an org. */
async function index(argv: string[]): Promise<void> {
  const { describeSnapshot, parseIndexArgs } = await import("./index-command.js");
  let database: InstanceType<(typeof import("@sf-agent-po/core"))["Database"]> | undefined;
  // How long each step took, printed at the end, and when the run fails.
  let timer: InstanceType<(typeof import("@sf-agent-po/connectors"))["StepTimer"]> | undefined;
  try {
    const opts = parseIndexArgs(argv);
    if ("help" in opts) return console.log(opts.help);
    const { Database, MetadataIndex } = await import("@sf-agent-po/core");
    const { indexTarget, parseRepoSpec, StepTimer } = await import("@sf-agent-po/connectors");
    timer = new StepTimer();
    // A repository is checked before the workspace is made for it.
    if (opts.target.kind === "remote" && typeof opts.target.repo === "string") opts.target = { kind: "remote", repo: parseRepoSpec(opts.target.repo) };
    const { databaseFile, ensureWorkspace } = await import("./startup.js");
    ensureWorkspace(opts.workspace);
    database = new Database(databaseFile(opts.workspace));
    const metadata = new MetadataIndex(database);
    // Stopped with Ctrl-C: the run is marked failed, so that the next one need not wait for
    // its lease to run out.
    const stop = () => {
      metadata.abandon("stopped by the user");
      database?.close();
      process.exit(130);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const snapshot = await indexTarget(metadata, opts.target, {
      workspace: opts.workspace,
      force: opts.force,
      full: opts.full,
      interactive: Boolean(process.stdin.isTTY),
      progress: (m) => {
        timer?.mark(m);
        console.error(m);
      },
    });
    for (const line of [...describeSnapshot(snapshot), ...(timer?.lines() ?? [])]) console.log(line);
  } catch (err) {
    console.error((err as Error).message);
    for (const line of timer?.lines() ?? []) console.error(line);
    process.exitCode = 1;
  } finally {
    database?.close();
  }
}

/** `doctor` checks what the server needs and says how to fix what is missing. */
async function doctor(argv: string[]): Promise<void> {
  let failed = true;
  try {
    const { defaultDoctorDeps, formatChecks, parseDoctorArgs, runDoctor } = await import("./doctor.js");
    const opts = parseDoctorArgs(argv);
    if ("help" in opts) {
      console.log(opts.help);
      failed = false;
    } else {
      const results = await runDoctor({ ...opts, model: "load" }, await defaultDoctorDeps());
      console.log(formatChecks(results));
      failed = results.some((r) => r.level === "fail");
    }
  } catch (err) {
    console.error((err as Error).message);
  }
  // The model's WebAssembly threads would keep the process alive.
  process.exit(failed ? 1 : 0);
}

/** `key` backs up the workspace's vault key, or puts a backup back. */
async function key(argv: string[]): Promise<void> {
  try {
    const { parseKeyArgs, readStdinLine, runKey } = await import("./key-command.js");
    const opts = parseKeyArgs(argv);
    if ("help" in opts) return console.log(opts.help);
    process.exitCode = await runKey(opts, { out: (t) => console.log(t), outIsTerminal: Boolean(process.stdout.isTTY), err: (t) => console.error(t), readLine: readStdinLine });
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

/** `report` prints the success measure and the design ratings, and writes them to CSV when asked. */
async function report(argv: string[]): Promise<void> {
  try {
    const { parseReportArgs, runReport } = await import("./report-command.js");
    const opts = parseReportArgs(argv);
    if ("help" in opts) return console.log(opts.help);
    process.exitCode = await runReport(opts, { out: (t) => console.log(t) });
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

/** `schedule` refreshes an org's index every day with the computer's scheduler. */
async function schedule(argv: string[]): Promise<void> {
  try {
    const { parseScheduleArgs, runSchedule } = await import("./schedule-command.js");
    const opts = parseScheduleArgs(argv);
    if ("help" in opts) return console.log(opts.help);
    const os = await import("node:os");
    const { run } = await import("@sf-agent-po/connectors");
    process.exitCode = await runSchedule(opts, {
      platform: process.platform,
      home: os.homedir(),
      cwd: process.cwd(),
      pathEnv: process.env.PATH ?? "",
      env: process.env,
      run: (cmd, args) => run(cmd, args, { timeoutMs: 30_000 }),
      out: (t) => console.log(t),
    });
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

const command = process.argv[2];
if (command === "init") await init(process.argv.slice(3));
else if (command === "index") await index(process.argv.slice(3));
else if (command === "key") await key(process.argv.slice(3));
else if (command === "doctor") await doctor(process.argv.slice(3));
else if (command === "report") await report(process.argv.slice(3));
else if (command === "schedule") await schedule(process.argv.slice(3));
else if (command !== undefined) {
  // Hosts start the MCP server with no arguments; anything else is most likely a mistyped command.
  console.error(`Unknown command "${command}". Run npx sf-agent-po@next with no arguments to start the MCP server.\n\n${USAGE}\n\n${INDEX_USAGE}\n\n${KEY_USAGE}\n\n${DOCTOR_USAGE}\n\n${REPORT_USAGE}\n\n${SCHEDULE_USAGE}`);
  process.exitCode = 1;
} else await main();
