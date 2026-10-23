#!/usr/bin/env node
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { parseInitArgs, runInit } from "./hosts/init.js";

if (process.argv[2] === "init") {
  try {
    const opts = parseInitArgs(process.argv.slice(3));
    if ("help" in opts) {
      console.log(opts.help);
    } else {
      for (const line of await runInit(opts)) console.log(line);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
} else {
  const workspaceDir = path.resolve(process.env.SF_AGENT_WORKSPACE ?? path.join(process.cwd(), ".sf-agent"));
  const server = createServer({ workspaceDir });
  await server.connect(new StdioServerTransport());
}
