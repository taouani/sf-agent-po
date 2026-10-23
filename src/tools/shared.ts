import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { INDUSTRY_IDS } from "../agents/industries.js";
import type { ContextStore } from "../context/store.js";
import type { SourceDocument } from "../context/types.js";
import type { AtlassianClient } from "../connectors/atlassian.js";
import type { SalesforceOrg } from "../connectors/salesforce.js";
import type { KeyedLock } from "../util/lock.js";

/** Everything a group of tools needs, so tests can swap in fakes. */
export interface Deps {
  workspaceDir: string;
  store: ContextStore;
  atlassian: () => AtlassianClient;
  sfOrg: (targetOrg: string) => SalesforceOrg;
  /** Signs publish previews so a publish can only run on content the user was shown. */
  approvalSecret: Buffer;
  /** One publish at a time per artifact, so a retried or parallel call cannot reuse a token mid-publish. */
  publishLock: KeyedLock;
}

export const contextName = z.string().default("default").describe("Name of the requirement context, e.g. a feature or epic name.");

export function describeDoc(d: SourceDocument): string {
  return `- [${d.id}] ${d.kind}: ${d.title} (${d.source}, ${d.content.length} chars)`;
}

/** Metadata keys that duplicate the document content or are internal, and would only bloat what the model reads. */
const HIDDEN_METADATA = new Set(["backlog", "fingerprint"]);

export function renderDoc(d: SourceDocument): string {
  const visible = Object.fromEntries(Object.entries(d.metadata ?? {}).filter(([k]) => !HIDDEN_METADATA.has(k)));
  const meta = Object.keys(visible).length ? `\nMetadata: ${JSON.stringify(visible)}` : "";
  return `## [${d.id}] ${d.kind}: ${d.title}\nSource: ${d.source}${meta}\n\n${d.content}`;
}

export function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/** Turns thrown errors into tool errors the host model can read and act on. */
export function guard<A extends unknown[]>(fn: (...args: A) => Promise<ReturnType<typeof text>>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  };
}

/**
 * Asks the user to confirm a publish through MCP elicitation when the host
 * supports it, so approval comes from the user rather than from the model.
 * Hosts without elicitation fall back to their own tool-approval prompt.
 */
export async function confirmWithUser(server: McpServer, message: string): Promise<void> {
  const elicitation = server.server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
  if (!elicitation) return;
  // An empty object means form mode; a client that lists modes must include "form".
  if (Object.keys(elicitation).length && !("form" in elicitation)) return;
  const result = await server.server.elicitInput({
    message,
    requestedSchema: {
      type: "object",
      properties: { confirm: { type: "boolean", title: "Publish now", description: "Write this to the target system.", default: false } },
      required: ["confirm"],
    },
  });
  if (result.action !== "accept" || result.content?.confirm !== true) {
    throw new Error("The user did not confirm the publish, so nothing was written.");
  }
}

const completeIndustry = (value: string | undefined) => INDUSTRY_IDS.filter((id) => id.startsWith((value ?? "").trim().toLowerCase()));

/**
 * Prompt argument for an industry template, with completion of the known ids.
 * The SDK looks for the completer inside the optional wrapper when it enables
 * completions, but on the wrapper itself when it answers a completion request,
 * so both carry it.
 */
export const industryArg = completable(
  completable(z.string(), completeIndustry)
    .optional()
    .describe(`Optional industry template: ${INDUSTRY_IDS.join(", ")}.`),
  completeIndustry,
);
