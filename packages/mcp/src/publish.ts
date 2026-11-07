// Saving designs and publishing them to Confluence (AR5). The agents write with pseudonyms;
// the real values are put back only for the write, and the user approves that write, with
// the real values, on the approval page. The model never sees them: what the tools return is
// masked, and so is the page link they return.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AtlassianError, markdownToStorage, type AtlassianClient } from "@sf-agent-po/connectors";
import type { ContextRepository, Masker } from "@sf-agent-po/core";
import { z } from "zod";
import { requestDigest, type PublishRequest } from "./approval/server.js";
import { getArtifact, KeyedLock, saveArtifact, updateArtifactMeta } from "./artifacts.js";
import type { Reviewer } from "./inputs.js";
import type { CallContext } from "./review.js";

type Result = { content: { type: "text"; text: string }[] };

/** What the publish tools need from the server. */
export interface PublishKit {
  contexts: ContextRepository;
  masker: Masker;
  atlassian?: () => AtlassianClient;
  reviewerFor: (call: CallContext) => Reviewer;
  guard: <A extends { context?: string }>(fn: (args: A, call: CallContext) => Promise<Result>) => (args: A, call: CallContext) => Promise<Result>;
  contextName: z.ZodType<string>;
}

const text = (t: string): Result => ({ content: [{ type: "text", text: t }] });

/** A page link without its title part ("/pages/123/Call+with+Karim"), which may hold a real name. */
export const pageLink = (url: string) => url.replace(/(\/pages\/\d+)\/[^?#]*/, "$1");

export function registerPublishTools(server: McpServer, kit: PublishKit): void {
  const { contexts, masker, guard, contextName } = kit;
  const lock = new KeyedLock();

  server.registerTool(
    "design_save",
    {
      title: "Save design",
      description:
        "Saves a solution design (Markdown) as a versioned draft in the requirement context, where the Product Owner agent can read it. " +
        "Saving again with the same title creates a new version of the same design. Keep the pseudonyms from the inputs (such as [PERSON_1]) as they are: " +
        "their real values are put back when the user approves a publish. Personal data written in clear is masked when the design is saved.",
      inputSchema: {
        context: contextName,
        title: z.string().min(3).describe('Design title, e.g. "Policy renewal portal: high-level design".'),
        designType: z.enum(["high-level", "detailed"]),
        content: z.string().min(1).describe("The full design in Markdown."),
        sourceIds: z.array(z.string()).optional().describe("Ids of the context documents the design is based on."),
      },
    },
    guard(async ({ context, title, designType, content, sourceIds }: { context: string; title: string; designType: "high-level" | "detailed"; content: string; sourceIds?: string[] }) => {
      const maskedTitle = await masker.maskOutput(context, title);
      const masked = await masker.maskOutput(context, content);
      const doc = saveArtifact(contexts, context, { kind: "design", title: maskedTitle.text, content: masked.text, artifactType: designType, sourceIds });
      const meta = doc.metadata;
      const hidden = Object.values(masked.report.counts).reduce((a, b) => a + b, 0) + Object.values(maskedTitle.report.counts).reduce((a, b) => a + b, 0);
      const note = hidden ? ` ${hidden} value(s) written in clear were masked; use the pseudonyms in later versions.` : "";
      const published = meta.confluence ? ` It was published to ${meta.confluence.url} (status: ${meta.status}).` : "";
      return text(`Saved ${designType} design "${doc.title}" as ${doc.id}, version ${meta.version}.${published}${note}`);
    }),
  );

  server.registerTool(
    "confluence_publish",
    {
      title: "Publish to Confluence",
      description:
        "Creates or updates a Confluence page from a design artifact. The user sees exactly what will be written, with the real values, in their browser, " +
        "and the page is written only if they approve it there; the call waits for them. Updating replaces the page content.",
      inputSchema: {
        context: contextName,
        artifactId: z.string().describe("Id of the design artifact to publish."),
        spaceKey: z.string().optional().describe("Confluence space key, needed the first time an artifact is published."),
        parentPageId: z.string().optional().describe("Optional parent page id or URL for a new page."),
        pageId: z.string().optional().describe("Update this existing page instead of the artifact's own page."),
        title: z.string().optional().describe("Page title. Defaults to the artifact title."),
        newPage: z.boolean().default(false).describe("Create a new page even if the artifact was published before."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard(
      async (
        args: { context: string; artifactId: string; spaceKey?: string; parentPageId?: string; pageId?: string; title?: string; newPage: boolean },
        call,
      ) =>
        lock.run(`${args.context}:${args.artifactId}`, async () => {
          const { context } = args;
          const doc = getArtifact(contexts, context, args.artifactId);
          if (!kit.atlassian) throw new Error("Confluence is not set up for this server.");
          const client = kit.atlassian();
          const maskedTitle = args.title?.trim() || doc.title;
          const title = masker.unmask(context, maskedTitle);
          const body = masker.unmask(context, doc.content);
          const ownPageId = doc.metadata.confluence?.pageId;
          const existing = args.pageId ?? (args.newPage ? undefined : ownPageId);

          // Where it goes, for the user: page titles from Confluence may hold real names, so they are shown on the page only.
          let target: string;
          let write: () => Promise<{ pageId: string; url: string; version: number }>;
          let ownPage: boolean;
          const storage = markdownToStorage(body.text);
          if (existing) {
            ownPage = !args.pageId;
            let page;
            try {
              page = await client.getPageSummary(existing);
            } catch (err) {
              if (ownPage && err instanceof AtlassianError && err.status === 404) {
                throw new Error("The page this artifact was published to no longer exists or is not visible. To publish it again, pass newPage: true with a spaceKey.");
              }
              throw err;
            }
            const edited = ownPage && doc.metadata.confluence && doc.metadata.confluence.pageVersion !== page.version;
            target =
              `Confluence: replace the content of page "${page.title}" (version ${page.version})` +
              (edited ? ". It was edited in Confluence since it was last published, and those edits will be replaced" : "") +
              (ownPage ? "" : ". This is not the design's own page: its whole content will be replaced");
            write = () => client.updatePage({ pageId: page.pageId, expectedVersion: page.version, title: title.text, storage, message: `Version ${doc.metadata.version}` });
          } else {
            if (!args.spaceKey) throw new Error("This design has not been published yet. Ask the user which Confluence space (key) to publish to.");
            const spaceId = await client.getSpaceId(args.spaceKey);
            let parent: Awaited<ReturnType<AtlassianClient["getPageSummary"]>> | undefined;
            if (args.parentPageId) {
              parent = await client.getPageSummary(args.parentPageId);
              if (parent.spaceId !== spaceId) throw new Error(`The parent page is not in space ${args.spaceKey}. Choose a parent page in that space, or leave parentPageId out.`);
            }
            ownPage = true;
            target = `Confluence: a new page in space ${args.spaceKey}${parent ? ` under "${parent.title}"` : " at the space root"}`;
            write = () => client.createPage({ spaceId, parentId: parent?.pageId, title: title.text, storage });
          }

          const req: PublishRequest = { kind: "publish", target, title: title.text, body: body.text, kept: [...new Set([...title.kept, ...body.kept])] };
          const decision = await kit.reviewerFor(call).review(req);
          if (decision.digest !== requestDigest(req)) throw new Error("The decision does not match what was shown for approval, so nothing was written.");
          const comment = decision.comment?.trim() ? ` Their comment: ${(await masker.mask(context, decision.comment.trim())).text}` : "";
          if (decision.status !== "approved") {
            const why = decision.status === "expired" ? "did not approve it in time, or closed the page" : "rejected it";
            return text(`Nothing was written: the user ${why}.${comment}`);
          }

          const page = await write();
          const url = pageLink(page.url);
          const version = doc.metadata.version;
          updateArtifactMeta(contexts, context, doc, (meta) => ({
            // Saved again while this ran: the new version is still unpublished.
            status: meta.version === version ? "published" : "changed",
            ...(ownPage ? { confluence: { pageId: page.pageId, url, pageVersion: page.version, artifactVersion: version, publishedAt: new Date().toISOString() } } : {}),
          }));
          return text(`${existing ? "Updated" : "Created"} the Confluence page for "${maskedTitle}" (version ${page.version}): ${url}${comment}`);
        }),
    ),
  );
}
