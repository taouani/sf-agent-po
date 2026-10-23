import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getArtifact, hash, updateArtifactMeta } from "../artifacts/artifacts.js";
import { approvalToken, checkApproval } from "../publish/approval.js";
import { markdownToStorage } from "../publish/storage.js";
import { type Deps, contextName, guard, text } from "./shared.js";

const PREVIEW_LIMIT = 20_000;

const targetSchema = {
  context: contextName,
  artifactId: z.string().describe("Id of the design or backlog artifact to publish."),
  spaceKey: z.string().optional().describe("Confluence space key, needed the first time an artifact is published."),
  parentPageId: z.string().optional().describe("Optional parent page id or URL for a new page."),
  pageId: z.string().optional().describe("Update this existing page instead of the artifact's own page."),
  title: z.string().optional().describe("Page title. Defaults to the artifact title."),
  newPage: z.boolean().default(false).describe("Create a new page even if the artifact was published before."),
};

type TargetArgs = {
  context: string;
  artifactId: string;
  spaceKey?: string;
  parentPageId?: string;
  pageId?: string;
  title?: string;
  newPage: boolean;
};

/** Publishing designs and backlogs to Confluence, always behind a preview the user approves. */
export function registerConfluenceTools(server: McpServer, deps: Deps): void {
  /** Works out exactly what a publish would do. Shared by preview and publish so they cannot disagree. */
  const plan = async (args: TargetArgs) => {
    const doc = await getArtifact(deps.store, args.context, args.artifactId);
    const client = deps.atlassian();
    const title = args.title?.trim() || doc.title;
    const storage = markdownToStorage(doc.content);
    const existingPage = args.pageId ?? (args.newPage ? undefined : doc.metadata.confluence?.pageId);

    let target: { mode: "update"; pageId: string; currentTitle: string; url: string } | { mode: "create"; spaceId: string; spaceKey: string; parentId?: string };
    if (existingPage) {
      const page = await client.getPageSummary(existingPage);
      target = { mode: "update", pageId: page.pageId, currentTitle: page.title, url: page.url };
    } else {
      if (!args.spaceKey) throw new Error("This artifact has not been published yet. Ask the user which Confluence space (key) to publish to.");
      const parentId = args.parentPageId ? (await client.getPageSummary(args.parentPageId)).pageId : undefined;
      target = { mode: "create", spaceId: await client.getSpaceId(args.spaceKey), spaceKey: args.spaceKey, parentId };
    }
    const payload = {
      action: "confluence_publish",
      context: args.context,
      artifactId: doc.id,
      artifactVersion: doc.metadata.version,
      contentHash: hash(storage),
      title,
      target: target.mode === "update" ? { mode: "update", pageId: target.pageId } : { mode: "create", spaceId: target.spaceId, parentId: target.parentId },
    };
    return { doc, client, title, storage, target, payload };
  };

  server.registerTool(
    "confluence_publish_preview",
    {
      title: "Preview Confluence publish",
      description:
        "Shows exactly what would be written to Confluence for a design or backlog artifact, and returns an approval token. " +
        "Show the preview to the user; call confluence_publish only after they explicitly approve.",
      inputSchema: targetSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const { doc, title, target, payload } = await plan(args);
      const where =
        target.mode === "update"
          ? `Update existing page "${target.currentTitle}" (${target.url}); a new page version is created, history is kept.`
          : `Create a new page in space ${target.spaceKey}${target.parentId ? ` under parent page ${target.parentId}` : " at the space root"}.`;
      const body = doc.content.length > PREVIEW_LIMIT ? `${doc.content.slice(0, PREVIEW_LIMIT)}\n\n[... ${doc.content.length - PREVIEW_LIMIT} more characters]` : doc.content;
      return text(
        [
          `Confluence publish preview`,
          ``,
          `- Artifact: ${doc.id} "${doc.title}", version ${doc.metadata.version} (${doc.metadata.status})`,
          `- Page title: ${title}`,
          `- Action: ${where}`,
          `- Approval token: ${approvalToken(deps.approvalSecret, payload)}`,
          ``,
          `Ask the user to approve before publishing. Content to be published (Markdown, converted to Confluence format):`,
          ``,
          body,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "confluence_publish",
    {
      title: "Publish to Confluence",
      description:
        "Creates or updates a Confluence page from a design or backlog artifact. Requires the approval token from confluence_publish_preview " +
        "with the same arguments, and must only be called after the user explicitly approved that preview.",
      inputSchema: { ...targetSchema, approvalToken: z.string().describe("Token returned by confluence_publish_preview.") },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guard(async ({ approvalToken: token, ...args }) => {
      const { doc, client, title, storage, target, payload } = await plan(args);
      checkApproval(deps.approvalSecret, payload, token);
      const page =
        target.mode === "update"
          ? await client.updatePage({ pageId: target.pageId, title, storage, message: `${doc.title} v${doc.metadata.version}` })
          : await client.createPage({ spaceId: target.spaceId, parentId: target.parentId, title, storage });
      // Only an artifact's own page is remembered; publishing into some other page does not re-point it.
      const ownPage = !args.pageId;
      await updateArtifactMeta(deps.store, args.context, doc, (meta) => ({
        status: "published",
        ...(ownPage
          ? { confluence: { pageId: page.pageId, url: page.url, pageVersion: page.version, artifactVersion: meta.version, publishedAt: new Date().toISOString() } }
          : {}),
      }));
      return text(`${target.mode === "update" ? "Updated" : "Created"} Confluence page "${title}" (version ${page.version}): ${page.url}`);
    }),
  );
}
