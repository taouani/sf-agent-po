import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ContextStore, type NewDocument } from "./context/store.js";
import { DOCUMENT_KINDS, type SourceDocument } from "./context/types.js";
import { loadLocalDocuments, textDocument } from "./loaders/documents.js";
import { METADATA_PROVIDERS, resolveMetadataSource } from "./metadata/sources.js";
import { buildInventory, inventoryToMarkdown } from "./metadata/inventory.js";
import { SalesforceOrg, orgToMarkdown } from "./connectors/salesforce.js";
import { AtlassianClient, atlassianConfigFromEnv } from "./connectors/atlassian.js";

export interface ServerOptions {
  workspaceDir: string;
  /** Overridable for tests. */
  atlassian?: AtlassianClient;
  salesforce?: (targetOrg: string) => SalesforceOrg;
}

const contextName = z.string().default("default").describe("Name of the requirement context, e.g. a feature or epic name.");
const kind = z.enum(DOCUMENT_KINDS);

export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer({ name: "sf-agent-po", version: "0.1.0" });
  const store = new ContextStore(opts.workspaceDir);
  const sfOrg = opts.salesforce ?? ((alias: string) => new SalesforceOrg(alias));
  const atlassian = (): AtlassianClient => {
    if (opts.atlassian) return opts.atlassian;
    const config = atlassianConfigFromEnv();
    if (!config) {
      throw new Error("Jira/Confluence access needs ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in the server environment.");
    }
    return new AtlassianClient(config);
  };

  const added = async (context: string, docs: NewDocument[]) => {
    const saved = await store.addDocuments(context, docs);
    return text(`Added ${saved.length} document(s) to context "${context}":\n${saved.map(describeDoc).join("\n")}`);
  };

  server.registerTool(
    "context_list",
    { title: "List requirement contexts", description: "Lists the requirement contexts saved in this workspace." },
    guard(async () => {
      const names = await store.list();
      return text(names.length ? names.join("\n") : "No contexts yet. Add a document to create one.");
    }),
  );

  server.registerTool(
    "context_show",
    {
      title: "Show requirement context",
      description: "Summarises the documents in a requirement context (id, kind, title, source, size) without their full text.",
      inputSchema: { context: contextName },
    },
    guard(async ({ context }) => {
      const ctx = await store.load(context);
      if (!ctx.documents.length) return text(`Context "${context}" is empty.`);
      return text(`Context "${context}" (${ctx.documents.length} documents, updated ${ctx.updatedAt}):\n${ctx.documents.map(describeDoc).join("\n")}`);
    }),
  );

  server.registerTool(
    "context_read",
    {
      title: "Read requirement context",
      description: "Returns the full text of documents in a requirement context, optionally filtered by id or kind. This is what the SA and PO agents reason over.",
      inputSchema: {
        context: contextName,
        ids: z.array(z.string()).optional(),
        kinds: z.array(kind).optional(),
      },
    },
    guard(async ({ context, ids, kinds }) => {
      const ctx = await store.load(context);
      const docs = ctx.documents.filter((d) => (!ids || ids.includes(d.id)) && (!kinds || kinds.includes(d.kind)));
      if (!docs.length) return text("No matching documents.");
      return text(docs.map(renderDoc).join("\n\n---\n\n"));
    }),
  );

  server.registerTool(
    "context_add_file",
    {
      title: "Add local files",
      description: "Adds meeting notes, emails (.eml), PI planning exports or other text files to a context. A folder is loaded recursively.",
      inputSchema: {
        context: contextName,
        path: z.string().describe("File or folder path, including shared drives."),
        kind: kind.optional().describe("Document kind. Inferred when omitted (.eml files are emails)."),
      },
    },
    guard(async ({ context, path, kind }) => {
      const docs = await loadLocalDocuments(path, kind);
      if (!docs.length) return text(`No supported text files found at ${path}.`);
      return added(context, docs);
    }),
  );

  server.registerTool(
    "context_add_text",
    {
      title: "Add pasted text",
      description: "Adds text pasted into the conversation, such as an email body, meeting notes or a high-level design, to a context.",
      inputSchema: { context: contextName, title: z.string(), content: z.string(), kind },
    },
    guard(async ({ context, title, content, kind }) => added(context, [textDocument(title, content, kind)])),
  );

  server.registerTool(
    "context_add_jira",
    {
      title: "Add Jira issues",
      description: "Adds Jira Cloud issues to a context, by issue keys or by a JQL query.",
      inputSchema: {
        context: contextName,
        keys: z.array(z.string()).optional(),
        jql: z.string().optional(),
        maxResults: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ context, keys, jql, maxResults }) => {
      if (!keys?.length && !jql) throw new Error("Provide issue keys or a JQL query.");
      const client = atlassian();
      const docs: NewDocument[] = [];
      for (const key of keys ?? []) docs.push(await client.getIssue(key));
      if (jql) docs.push(...(await client.searchIssues(jql, maxResults)));
      return added(context, docs);
    }),
  );

  server.registerTool(
    "context_add_confluence",
    {
      title: "Add Confluence pages",
      description: "Adds Confluence Cloud pages to a context, by page id or page URL.",
      inputSchema: { context: contextName, pages: z.array(z.string()).min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ context, pages }) => {
      const client = atlassian();
      const docs: NewDocument[] = [];
      for (const page of pages) docs.push(await client.getPage(page));
      return added(context, docs);
    }),
  );

  server.registerTool(
    "context_add_metadata",
    {
      title: "Add metadata repository",
      description:
        "Scans a Salesforce DX metadata repository and adds an inventory (objects, fields, flows, Apex, triggers, LWC, permission sets) to a context. " +
        "The repository can be a local or shared folder, or a GitHub, GitLab, Azure DevOps or plain git repository, cloned with the user's own CLI credentials.",
      inputSchema: {
        context: contextName,
        provider: z.enum(METADATA_PROVIDERS),
        location: z.string().describe('Folder path, "owner/repo" for GitHub or GitLab, or a clone URL.'),
        ref: z.string().optional().describe("Branch or tag."),
      },
    },
    guard(async ({ context, provider, location, ref }) => {
      const root = await resolveMetadataSource({ provider, location, ref }, opts.workspaceDir);
      const inv = await buildInventory(root);
      return added(context, [
        {
          kind: "metadata",
          title: `Metadata inventory: ${location}${ref ? `@${ref}` : ""}`,
          source: `${provider}:${location}${ref ? `@${ref}` : ""}`,
          content: inventoryToMarkdown(inv),
          metadata: {
            localPath: root,
            objects: inv.objects.length,
            flows: inv.flows.length,
            apexClasses: inv.apexClasses.length,
            triggers: inv.triggers.length,
          },
        },
      ]);
    }),
  );

  server.registerTool(
    "context_add_org",
    {
      title: "Add Salesforce org",
      description:
        "Reads a Salesforce org through the sf CLI (using an org already authorised with `sf org login`) and adds its custom objects, " +
        "plus field-level detail for the listed objects, to a context. Read-only.",
      inputSchema: {
        context: contextName,
        targetOrg: z.string().describe("Org alias or username."),
        objects: z.array(z.string()).default([]).describe("Objects to describe in detail, e.g. Account, Opportunity, Policy__c."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ context, targetOrg, objects }) => {
      const org = sfOrg(targetOrg);
      const info = await org.info();
      const custom = await org.listCustomObjects();
      const describes = [];
      for (const o of objects) describes.push(await org.describe(o));
      return added(context, [
        {
          kind: "org",
          title: `Salesforce org: ${info.alias ?? targetOrg}`,
          source: `org:${info.username ?? targetOrg}`,
          content: orgToMarkdown(info, custom, describes),
          metadata: { ...info },
        },
      ]);
    }),
  );

  server.registerTool(
    "context_remove_document",
    {
      title: "Remove document",
      description: "Removes one document from a context by its id.",
      inputSchema: { context: contextName, id: z.string() },
      annotations: { destructiveHint: true },
    },
    guard(async ({ context, id }) =>
      text((await store.removeDocument(context, id)) ? `Removed ${id}.` : `No document ${id} in context "${context}".`),
    ),
  );

  return server;
}

function describeDoc(d: SourceDocument): string {
  return `- [${d.id}] ${d.kind}: ${d.title} (${d.source}, ${d.content.length} chars)`;
}

function renderDoc(d: SourceDocument): string {
  const meta = d.metadata && Object.keys(d.metadata).length ? `\nMetadata: ${JSON.stringify(d.metadata)}` : "";
  return `## [${d.id}] ${d.kind}: ${d.title}\nSource: ${d.source}${meta}\n\n${d.content}`;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/** Turns thrown errors into tool errors the host model can read and act on. */
function guard<A extends unknown[]>(fn: (...args: A) => Promise<ReturnType<typeof text>>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  };
}
