#!/usr/bin/env node
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { USAGE, parseInitArgs, runInit } from "./hosts/init.js";

const command = process.argv[2];

if (command === "init") {
  try {
    const opts = parseInitArgs(process.argv.slice(3));
    if ("help" in opts) {
      console.log(opts.help);
    } else {
      const report = await runInit(opts);
      for (const line of report) console.log(line);
      if (report.some((line) => line.startsWith("failed"))) process.exitCode = 1;
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
} else if (command !== undefined) {
  // Hosts start the MCP server with no arguments; anything else is most likely a mistyped command.
  console.error(`Unknown command "${command}". Run sf-agent-po with no arguments to start the MCP server.\n\n${USAGE}`);
  process.exitCode = 1;
} else {
  const workspaceDir = path.resolve(process.env.SF_AGENT_WORKSPACE ?? path.join(process.cwd(), ".sf-agent"));
  const server = createServer({ workspaceDir });
  await server.connect(new StdioServerTransport());
}
