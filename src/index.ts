#!/usr/bin/env node
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const workspaceDir = path.resolve(process.env.SF_AGENT_WORKSPACE ?? path.join(process.cwd(), ".sf-agent"));
const server = createServer({ workspaceDir });
await server.connect(new StdioServerTransport());
