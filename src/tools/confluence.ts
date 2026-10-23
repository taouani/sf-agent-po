import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getArtifact, hash, updateArtifactMeta } from "../artifacts/artifacts.js";
import { AtlassianError } from "../connectors/atlassian.js";
import { approvalToken, checkApproval } from "../publish/approval.js";
import { markdownToStorage } from "../publish/storage.js";
import { type Deps, confirmWithUser, contextName, guard, text } from "./shared.js";

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

type Target =
  | { mode: "update"; pageId: string; currentTitle: string; url: string; version: number; ownPage: boolean }
  | { mode: "create"; spaceId: string; spaceKey: string; parentId?: string; parentTitle?: string };

/** Publishing designs and backlogs to Confluence, always behind a preview the user approves. */
export function registerConfluenceTools(server: McpServer, deps: Deps): void {
  /** Works out exactly what a publish would do. Shared by preview and publish so they cannot disagree. */
  const plan = async (args: TargetArgs) => {
    const doc = await getArtifact(deps.store, args.context, args.artifactId);
    const client = deps.atlassian();
    const title = args.title?.trim() || doc.title;
    const storage = markdownToStorage(doc.content);
    const ownPageId = doc.metadata.confluence?.pageId;
    const existingPage = args.pageId ?? (args.newPage ? undefined : ownPageId);

    let target: Target;
    if (existingPage) {
      const ownPage = !args.pageId;
      let page;
      try {
        page = await client.getPageSummary(existingPage);
      } catch (err) {
        if (ownPage && err instanceof AtlassianError && err.status === 404) {
          throw new Error(
            `The page this artifact was published to (${doc.metadata.confluence?.url}) no longer exists or is not visible. ` +
              "To publish it again, pass newPage: true with a spaceKey (and optionally parentPageId).",
          );
        }
        throw err;
      }
      target = { mode: "update", pageId: page.pageId, currentTitle: page.title, url: page.url, version: page.version, ownPage };
    } else {
      if (!args.spaceKey) throw new Error("This artifact has not been published yet. Ask the user which Confluence space (key) to publish to.");
      const spaceId = await client.getSpaceId(args.spaceKey);
      let parent;
      if (args.parentPageId) {
        parent = await client.getPageSummary(args.parentPageId);
        if (parent.spaceId !== spaceId) {
          throw new Error(`Parent page "${parent.title}" is not in space ${args.spaceKey}. Choose a parent page in that space, or leave parentPageId out.`);
        }
      }
      target = { mode: "create", spaceId, spaceKey: args.spaceKey, parentId: parent?.pageId, parentTitle: parent?.title };
    }

    // The payload pins everything a publish depends on: the content, the title, the target and its
    // current version, and where the artifact was last published. Any change needs a new preview,
    // which also stops a token from being replayed after it was used.
    const payload = {
      action: "confluence_publish",
      context: args.context,
      artifactId: doc.id,
      artifactVersion: doc.metadata.version,
      contentHash: hash(storage),
      title,
      ownPageId: ownPageId ?? null,
      target: target.mode === "update" ? { mode: "update", pageId: target.pageId, version: target.version } : { mode: "create", spaceId: target.spaceId, parentId: target.parentId },
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
      const lines = [`Confluence publish preview`, ``, `- Artifact: ${doc.id} "${doc.title}", version ${doc.metadata.version} (${doc.metadata.status})`, `- Page title: ${title}`];
      if (target.mode === "update") {
        lines.push(`- Action: replace the content of page "${target.currentTitle}" (${target.url}), now at version ${target.version}. Confluence keeps the previous versions in the page history.`);
        const published = doc.metadata.confluence;
        if (target.ownPage && published && published.pageVersion !== target.version) {
          lines.push(
            `- WARNING: the page was edited in Confluence since it was last published (version ${published.pageVersion} then, ${target.version} now). Publishing replaces those edits; tell the user.`,
          );
        }
        if (!target.ownPage) lines.push(`- WARNING: this page is not the artifact's own page. Its whole content will be replaced.`);
      } else {
        const under = target.parentId ? ` under "${target.parentTitle}" (${target.parentId})` : " at the space root";
        lines.push(`- Action: create a new page in space ${target.spaceKey}${under}.`);
      }
      lines.push(`- Approval token: ${approvalToken(deps.approvalSecret, payload)}`, ``);
      if (doc.content.length > PREVIEW_LIMIT) {
        lines.push(
          `The content below is cut at ${PREVIEW_LIMIT} of ${doc.content.length} characters for this preview. The FULL document will be published; tell the user.`,
          ``,
          doc.content.slice(0, PREVIEW_LIMIT),
          ``,
          `[... ${doc.content.length - PREVIEW_LIMIT} more characters]`,
        );
      } else {
        lines.push(`Content to be published (Markdown, converted to Confluence format):`, ``, doc.content);
      }
      lines.push(``, `Ask the user to approve before publishing.`);
      return text(lines.join("\n"));
    }),
  );

  server.registerTool(
    "confluence_publish",
    {
      title: "Publish to Confluence",
      description:
        "Creates or updates a Confluence page from a design or backlog artifact. Requires the approval token from confluence_publish_preview " +
        "with the same arguments, and must only be called after the user explicitly approved that preview. Updating replaces the page content.",
      inputSchema: { ...targetSchema, approvalToken: z.string().describe("Token returned by confluence_publish_preview.") },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard(async ({ approvalToken: token, ...args }) => {
      const { doc, client, title, storage, target, payload } = await plan(args);
      checkApproval(deps.approvalSecret, payload, token);
      await confirmWithUser(
        server,
        target.mode === "update" ? `Replace the content of Confluence page "${target.currentTitle}" with "${title}"?` : `Create Confluence page "${title}" in space ${target.spaceKey}?`,
      );
      const page =
        target.mode === "update"
          ? await client.updatePage({ pageId: target.pageId, expectedVersion: target.version, title, storage, message: `${doc.title} v${doc.metadata.version}` })
          : await client.createPage({ spaceId: target.spaceId, parentId: target.parentId, title, storage });
      // Only an artifact's own page is remembered; publishing into some other page does not re-point it.
      const ownPage = target.mode === "create" || target.ownPage;
      const publishedVersion = doc.metadata.version;
      await updateArtifactMeta(deps.store, args.context, doc, (meta) => ({
        // If the artifact was saved again while this ran, the new version is still unpublished.
        status: meta.version === publishedVersion ? "published" : "changed",
        ...(ownPage
          ? { confluence: { pageId: page.pageId, url: page.url, pageVersion: page.version, artifactVersion: publishedVersion, publishedAt: new Date().toISOString() } }
          : {}),
      }));
      return text(`${target.mode === "update" ? "Updated" : "Created"} Confluence page "${title}" (version ${page.version}): ${page.url}`);
    }),
  );
}
