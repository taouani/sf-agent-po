import { z } from "zod";
import type { ContextStore } from "../context/store.js";
import type { SourceDocument } from "../context/types.js";
import type { AtlassianClient } from "../connectors/atlassian.js";
import type { SalesforceOrg } from "../connectors/salesforce.js";

/** Everything a group of tools needs, so tests can swap in fakes. */
export interface Deps {
  workspaceDir: string;
  store: ContextStore;
  atlassian: () => AtlassianClient;
  sfOrg: (targetOrg: string) => SalesforceOrg;
  /** Signs publish previews so a publish can only run on content the user was shown. */
  approvalSecret: Buffer;
}

export const contextName = z.string().default("default").describe("Name of the requirement context, e.g. a feature or epic name.");

export function describeDoc(d: SourceDocument): string {
  return `- [${d.id}] ${d.kind}: ${d.title} (${d.source}, ${d.content.length} chars)`;
}

export function renderDoc(d: SourceDocument): string {
  const meta = d.metadata && Object.keys(d.metadata).length ? `\nMetadata: ${JSON.stringify(d.metadata)}` : "";
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
