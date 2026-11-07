#!/usr/bin/env node
// Starts the v1 MCP server on stdio. The workspace (SF_AGENT_WORKSPACE, else .sf-agent in the
// working folder) holds one SQLite database; its vault key is in the OS keychain.

import { readFileSync } from "node:fs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { atlassianConfigFromEnv, AtlassianClient } from "@sf-agent-po/connectors";
import { ContextRepository, Database, Masker, openVault } from "@sf-agent-po/core";
import { ApprovalServer } from "./approval/server.js";
import { parseInitArgs, runInit, USAGE } from "./hosts/init.js";
import { createServer } from "./server.js";
import { databaseFile, lazyDetector, lazyRecognizer } from "./startup.js";

async function main(): Promise<void> {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const workspace = path.resolve(process.env.SF_AGENT_WORKSPACE ?? path.join(process.cwd(), ".sf-agent"));
  const database = new Database(databaseFile(workspace));
  let opened: ReturnType<typeof openVault>;
  try {
    opened = openVault(database);
  } catch (err) {
    console.error(`sf-agent-po cannot start: ${(err as Error).message}`);
    process.exit(1);
  }
  const { vault, created } = opened;
  if (created?.warning) console.error(created.warning);
  const contexts = new ContextRepository(database);
  const detector = lazyDetector();
  const masker = new Masker({ vault, model: detector });
  const recognizer = lazyRecognizer();
  const approval = new ApprovalServer();
  const atlassian = () => {
    const config = atlassianConfigFromEnv();
    if (!config) throw new Error("Jira and Confluence need ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in the server environment.");
    return new AtlassianClient(config);
  };
  const server = createServer({ contexts, masker, errorMasker: new Masker({ vault }), modelReady: detector.ready, approval, recognizer, version, atlassian });
  const shutdown = async () => {
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

const command = process.argv[2];
if (command === "init") await init(process.argv.slice(3));
else if (command !== undefined) {
  // Hosts start the MCP server with no arguments; anything else is most likely a mistyped command.
  console.error(`Unknown command "${command}". Run sf-agent-po-next with no arguments to start the MCP server.\n\n${USAGE}`);
  process.exitCode = 1;
} else await main();
