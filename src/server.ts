import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ContextStore } from "./context/store.js";
import { SalesforceOrg } from "./connectors/salesforce.js";
import { AtlassianClient, atlassianConfigFromEnv } from "./connectors/atlassian.js";
import type { Deps } from "./tools/shared.js";
import { registerContextTools } from "./tools/context.js";
import { registerDesignTools } from "./tools/design.js";
import { registerConfluenceTools } from "./tools/confluence.js";
import { registerBacklogTools } from "./tools/backlog.js";

export interface ServerOptions {
  workspaceDir: string;
  /** Overridable for tests. */
  atlassian?: AtlassianClient;
  salesforce?: (targetOrg: string) => SalesforceOrg;
}

export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer({ name: "sf-agent-po", version: "0.3.0" });
  const deps: Deps = {
    workspaceDir: opts.workspaceDir,
    store: new ContextStore(opts.workspaceDir),
    sfOrg: opts.salesforce ?? ((alias: string) => new SalesforceOrg(alias)),
    atlassian: () => {
      if (opts.atlassian) return opts.atlassian;
      const config = atlassianConfigFromEnv();
      if (!config) {
        throw new Error("Jira/Confluence access needs ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in the server environment.");
      }
      return new AtlassianClient(config);
    },
    approvalSecret: randomBytes(32),
  };

  registerContextTools(server, deps);
  registerDesignTools(server, deps);
  registerConfluenceTools(server, deps);
  registerBacklogTools(server, deps);
  return server;
}
