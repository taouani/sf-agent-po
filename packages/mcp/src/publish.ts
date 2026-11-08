// Saving designs and publishing them to Confluence (AR5). The agents write with pseudonyms;
// the real values are put back only for the write, and the user approves that write, with
// the real values, on the approval page. The model never sees them: what the tools return is
// masked, and so is the page link they return.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AtlassianError, DRAWIO_MEDIA_TYPE, drawioMacro, drawioText, drawioXml, layoutDiagram, markdownToStorage, type AtlassianClient } from "@sf-agent-po/connectors";
import type { ContextRepository, Masker, RequirementRepository } from "@sf-agent-po/core";
import { z } from "zod";
import { requestDigest, type PublishRequest } from "./approval/server.js";
import { type Artifact, getArtifact, type KeyedLock, pageLink, saveArtifact, updateArtifactMeta } from "./artifacts.js";
import { highLevelDiagrams } from "./design/render.js";
import type { HighLevelDesign } from "./design/schema.js";
import type { Reviewer } from "./inputs.js";
import type { CallContext } from "./review.js";
import { buildTrace, renderTrace, type TraceMatrix } from "./trace.js";

type Result = { content: { type: "text"; text: string }[] };

/** What the publish tools need from the server. */
export interface PublishKit {
  contexts: ContextRepository;
  masker: Masker;
  atlassian?: () => AtlassianClient;
  reviewerFor: (call: CallContext) => Reviewer;
  guard: <A extends { context?: string }>(fn: (args: A, call: CallContext) => Promise<Result>) => (args: A, call: CallContext) => Promise<Result>;
  contextName: z.ZodType<string>;
  /** One publish at a time per artifact, whatever the target. */
  lock: KeyedLock;
  /** The confirmed requirements, when the server keeps them: the backlog check reads them. */
  requirements?: RequirementRepository;
}

const text = (t: string): Result => ({ content: [{ type: "text", text: t }] });

const xml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Puts the real values into Confluence storage made from the masked Markdown, so a value can
 * never change the page's structure (a "|" in a table, a newline, a Markdown link): outside
 * code blocks each value is XML-escaped; inside their CDATA sections it is kept verbatim, with
 * any "]]>" split so it cannot end the section.
 */
export function unmaskStorage(masker: Masker, context: string, storage: string) {
  const kept = new Set<string>();
  const revealed = new Map<string, { type: string; value: string }>();
  const parts = storage.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/).map((part, i) => {
    const cdata = i % 2 === 1;
    const out = masker.unmask(context, part, { escape: cdata ? (v) => v.split("]]>").join("]]]]><![CDATA[>") : xml });
    out.kept.forEach((k) => kept.add(k));
    out.revealed.forEach((r) => revealed.set(`${r.type}\0${r.value}`, r));
    return out.text;
  });
  return { text: parts.join(""), kept: [...kept], revealed: [...revealed.values()] };
}

/** Atlassian errors may quote what was sent (a real title): only their status reaches the model. */
export async function atlassianCall<T>(service: "Confluence" | "Jira", what: string, run: () => Promise<T>, after = "Nothing was written."): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AtlassianError) throw new Error(`${service} refused to ${what} (HTTP ${err.status}).${after ? ` ${after}` : ""}`);
    throw err;
  }
}

const confluence = <T>(what: string, run: () => Promise<T>) => atlassianCall("Confluence", what, run);

/** How a design's diagrams appear in Confluence: with the draw.io app, or as their Mermaid source. */
export const DIAGRAM_MODES = ["drawio", "mermaid"] as const;
export type DiagramMode = (typeof DIAGRAM_MODES)[number];

/** The names of the diagrams a design's Markdown shows, in order ("```mermaid diagram=solution"). */
export const diagramNames = (markdown: string) => [...new Set([...markdown.matchAll(/^```mermaid[ \t]+(?:[^\n]*[ \t])?diagram=([\w-]+)/gm)].map((m) => m[1]!))];

/** The widest a diagram is shown on the page, in pixels. */
const MAX_DIAGRAM_WIDTH = 1000;

/**
 * The user's comment on an approval page, for the model. It is in clear and may name someone
 * just seen on the page, however short the name: the values the page revealed are masked first.
 */
export async function decisionComment(masker: Masker, context: string, comment: string | undefined, revealed: readonly { type: string; value: string }[]): Promise<string> {
  const said = comment?.trim();
  if (!said) return "";
  try {
    return ` Their comment: ${(await masker.mask(context, said, revealed.map((r) => ({ ...r, caseSensitive: false })))).text}`;
  } catch {
    return " They left a comment, which could not be shown safely.";
  }
}

export function registerPublishTools(server: McpServer, kit: PublishKit): void {
  const { contexts, masker, guard, contextName, lock } = kit;

  /** The matrix of a design written by a workflow, when the server keeps requirements and some are confirmed. */
  const traceOf = (context: string, doc: Artifact): TraceMatrix | undefined => {
    if (!kit.requirements || doc.kind !== "design" || !doc.metadata.design) return undefined;
    const type = doc.metadata.artifactType === "detailed" ? "detailed" : "highLevel";
    const matrix = buildTrace(contexts, kit.requirements, context, { [type]: doc.id });
    return matrix.rows.length ? matrix : undefined;
  };

  server.registerTool(
    "design_save",
    {
      title: "Save design",
      description:
        "Deprecated: the guided workflows (workflow_start) write and save designs section by section; use this only when a workflow step asks for it, " +
        "or to save a design the user wrote or revised outside a workflow. " +
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
      // A design written here has no section JSON: one saved by the workflow before would be stale.
      const doc = saveArtifact(contexts, context, { kind: "design", title: maskedTitle.text, content: masked.text, artifactType: designType, sourceIds, extra: { design: undefined } });
      const meta = doc.metadata;
      const hidden = Object.values(masked.report.counts).reduce((a, b) => a + b, 0) + Object.values(maskedTitle.report.counts).reduce((a, b) => a + b, 0);
      const note = hidden ? ` ${hidden} value(s) written in clear were masked; use the pseudonyms in later versions.` : "";
      const published = meta.confluence ? ` It was published to ${pageLink(meta.confluence.url)} (status: ${meta.status}).` : "";
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
        traceability: z
          .boolean()
          .default(true)
          .describe("For a design written by a workflow: also write its traceability matrix as a page under the design's own page, rebuilt at each publish."),
        diagrams: z
          .enum(DIAGRAM_MODES)
          .optional()
          .describe(
            "How the diagrams of a design written by a workflow appear: drawio (the default) attaches each one to the page as a draw.io file shown by the draw.io app; " +
              "mermaid keeps their Mermaid source in a code block, for a site without the draw.io app. Kept for the context.",
          ),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard(
      async (
        args: {
          context: string;
          artifactId: string;
          spaceKey?: string;
          parentPageId?: string;
          pageId?: string;
          title?: string;
          newPage: boolean;
          traceability: boolean;
          diagrams?: DiagramMode;
        },
        call,
      ) =>
        lock.run(`${args.context}:${args.artifactId}`, async () => {
          const { context } = args;
          const doc = getArtifact(contexts, context, args.artifactId);
          if (!kit.atlassian) throw new Error("Confluence is not set up for this server.");
          const client = kit.atlassian();
          const title = masker.unmask(context, args.title?.trim() || doc.title);
          // What the user reads on the page (the Markdown with the real values), and what is
          // written: storage made from the masked Markdown, with the same values put in escaped.
          const body = masker.unmask(context, doc.content);
          if (args.diagrams) contexts.updateSettings(context, { confluenceDiagrams: args.diagrams });
          const mode = args.diagrams ?? (contexts.get(context)?.settings.confluenceDiagrams === "mermaid" ? "mermaid" : "drawio");
          // The diagrams go as draw.io files: their labels come from the design, with the real values put in.
          const graphs = mode === "drawio" && doc.metadata.design && doc.metadata.artifactType !== "detailed" ? highLevelDiagrams(doc.metadata.design as HighLevelDesign) : {};
          const files = diagramNames(doc.content)
            .filter((name) => Object.hasOwn(graphs, name))
            .map((name) => {
              const graph = graphs[name]!;
              return { name, file: `${name}.drawio`, xml: masker.unmask(context, drawioXml(graph), { escape: drawioText }), width: Math.min(layoutDiagram(graph).width, MAX_DIAGRAM_WIDTH) };
            });
          /** The page's storage, with each diagram shown at the version of its file. */
          const storageAt = (revision: (file: string) => number) =>
            unmaskStorage(
              masker,
              context,
              markdownToStorage(doc.content, { diagrams: Object.fromEntries(files.map((f) => [f.name, drawioMacro(f.file, revision(f.file), f.width)])) }),
            );
          const storage = storageAt(() => 1);
          /** Attaches the diagram files to the page; returns each file's version. */
          const attach = async (pageId: string) => {
            const versions = new Map<string, number>();
            for (const f of files) {
              const { version } = await confluence(`attach the diagram ${f.file}`, () => client.attachFile({ pageId, name: f.file, mediaType: DRAWIO_MEDIA_TYPE, content: f.xml.text }));
              versions.set(f.file, version);
            }
            return versions;
          };
          let diagramNote = "";
          const ownPageId = doc.metadata.confluence?.pageId;
          const existing = args.pageId ?? (args.newPage ? undefined : ownPageId);

          // Where it goes, for the user: page titles from Confluence may hold real names, so they are shown on the page only.
          let target: string;
          let write: () => Promise<{ pageId: string; url: string; version: number }>;
          let ownPage: boolean;
          const shownTitles: string[] = [];
          if (existing) {
            let page: Awaited<ReturnType<AtlassianClient["getPageSummary"]>>;
            try {
              page = await client.getPageSummary(existing);
            } catch (err) {
              if (!args.pageId && err instanceof AtlassianError && err.status === 404) {
                throw new Error("The page this design was published to no longer exists or is not visible. To publish it again, pass newPage: true with a spaceKey.");
              }
              if (err instanceof AtlassianError) throw new Error(`Confluence did not return the page (HTTP ${err.status}). Nothing was written.`);
              throw err;
            }
            ownPage = !args.pageId || page.pageId === ownPageId;
            shownTitles.push(page.title);
            const edited = ownPage && doc.metadata.confluence && doc.metadata.confluence.pageVersion !== page.version;
            target =
              `Confluence: replace the content of page "${page.title}" (version ${page.version})` +
              (edited ? ". It was edited in Confluence since it was last published, and those edits will be replaced" : "") +
              (ownPage ? "" : ". This is not the design's own page: its whole content will be replaced");
            write = async () => {
              // The files first, so the macros can name their new versions; adding a file leaves the page's version as it is.
              let versions: Map<string, number>;
              try {
                versions = await attach(page.pageId);
              } catch (err) {
                throw new Error(`${(err as Error).message.replace(/ Nothing was written\.$/, "")} The page was not updated.`);
              }
              const at = storageAt((file) => versions.get(file) ?? 1);
              return client.updatePage({ pageId: page.pageId, expectedVersion: page.version, title: title.text, storage: at.text, message: `Version ${doc.metadata.version}` });
            };
          } else {
            if (!args.spaceKey) throw new Error("This design has not been published yet. Ask the user which Confluence space (key) to publish to.");
            const spaceKey = args.spaceKey;
            const spaceId = await confluence("find the space", () => client.getSpaceId(spaceKey));
            let parent: Awaited<ReturnType<AtlassianClient["getPageSummary"]>> | undefined;
            if (args.parentPageId) {
              const parentId = args.parentPageId;
              parent = await confluence("return the parent page", () => client.getPageSummary(parentId));
              shownTitles.push(parent.title);
              if (parent.spaceId !== spaceId) throw new Error(`The parent page is not in space ${spaceKey}. Choose a parent page in that space, or leave parentPageId out.`);
            }
            ownPage = true;
            target = `Confluence: a new page in space ${spaceKey}${parent ? ` under "${parent.title}"` : " at the space root"}`;
            write = async () => {
              const created = await client.createPage({ spaceId, parentId: parent?.pageId, title: title.text, storage: storage.text });
              // A new page's files start at version 1, which its macros already name.
              try {
                await attach(created.pageId);
              } catch (err) {
                const why = (await masker.maskOutputs(context, [(err as Error).message.replace(/ Nothing was written\.$/, "")])).texts[0];
                diagramNote = ` Its diagrams were not attached: ${why} Publish again to attach them.`;
              }
              return created;
            };
          }

          // The matrix goes under the design's own page, from the requirement ids this design carries.
          const matrix = ownPage && args.traceability ? traceOf(context, doc) : undefined;
          let traceTitle: ReturnType<Masker["unmask"]> | undefined;
          let traceBody: ReturnType<Masker["unmask"]> | undefined;
          let traceStorage: ReturnType<typeof unmaskStorage> | undefined;
          let tracePage: Awaited<ReturnType<AtlassianClient["getPageSummary"]>> | undefined;
          const traceMeta = doc.metadata.traceability as { pageId?: string; url?: string; pageVersion?: number } | undefined;
          if (matrix) {
            // Named after the design page as written, within Confluence's 255 characters.
            const masked = `${args.title?.trim() || doc.title}: traceability matrix`;
            const content = renderTrace(matrix, masked);
            const named = masker.unmask(context, masked);
            traceTitle = { ...named, text: named.text.length > 255 ? `${named.text.slice(0, 230).trimEnd()}… traceability matrix` : named.text };
            traceBody = masker.unmask(context, content);
            traceStorage = unmaskStorage(masker, context, markdownToStorage(content));
            const known = traceMeta?.pageId;
            // Deleted, or out of reach (moved to a space the token cannot read): it is created again.
            tracePage =
              known && existing
                ? await client.getPageSummary(known).catch((err: unknown) => {
                    if (err instanceof AtlassianError && (err.status === 404 || err.status === 403)) return undefined;
                    throw err instanceof AtlassianError ? new Error(`Confluence did not return the traceability matrix page (HTTP ${err.status}). Nothing was written.`) : err;
                  })
                : undefined;
            if (tracePage) shownTitles.push(tracePage.title);
            const edited = tracePage && traceMeta?.pageVersion !== undefined && traceMeta.pageVersion !== tracePage.version;
            target += tracePage
              ? `, and replace the content of its traceability matrix page "${tracePage.title}"${edited ? " (edited in Confluence since it was last published: those edits will be replaced)" : ""}`
              : ", and a new page under it for its traceability matrix";
          }
          if (files.length) target += `, with ${files.length} draw.io diagram(s) attached to the page (shown below as Mermaid)`;
          const trace = traceTitle && traceBody ? `\n\n---\n\n${traceBody.text}` : "";
          const req: PublishRequest = {
            kind: "publish",
            target,
            title: title.text,
            body: `${body.text}${trace}`,
            kept: [...new Set([...title.kept, ...body.kept, ...files.flatMap((f) => f.xml.kept), ...(traceTitle?.kept ?? []), ...(traceBody?.kept ?? [])])],
          };
          const decision = await kit.reviewerFor(call).review(req);
          if (decision.digest !== requestDigest(req)) throw new Error("The decision does not match what was shown for approval, so nothing was written.");
          // Page titles from Confluence were shown in clear too, and the comment may quote them.
          const shown = shownTitles.map((value) => ({ type: "PRIVATE", value }));
          const comment = () =>
            decisionComment(masker, context, decision.comment, [...title.revealed, ...body.revealed, ...(traceTitle?.revealed ?? []), ...(traceBody?.revealed ?? []), ...shown]);
          if (decision.status !== "approved") {
            const why = decision.status === "expired" ? "did not approve it in time, or closed the page" : "rejected it";
            return text(`Nothing was written: the user ${why}.${await comment()}`);
          }

          const page = await confluence("write the page", write);
          const url = pageLink(page.url);
          const version = doc.metadata.version;
          updateArtifactMeta(contexts, context, doc, (meta) => ({
            // Saved again while this ran: the new version is still unpublished.
            status: meta.version === version ? "published" : "changed",
            ...(ownPage ? { confluence: { pageId: page.pageId, url, pageVersion: page.version, artifactVersion: version, publishedAt: new Date().toISOString() } } : {}),
          }));
          let traced = traceMeta?.url ? ` Its traceability matrix page (${traceMeta.url}) was not updated.` : "";
          if (matrix && traceTitle && traceStorage) {
            let written: Awaited<ReturnType<AtlassianClient["updatePage"]>> | undefined;
            try {
              written = tracePage
                ? await confluence("write the traceability matrix page", () =>
                    client.updatePage({ pageId: tracePage.pageId, expectedVersion: tracePage.version, title: traceTitle.text, storage: traceStorage.text, message: `Version ${version}` }),
                  )
                : await confluence("write the traceability matrix page", async () => {
                    const parent = await client.getPageSummary(page.pageId);
                    return client.createPage({ spaceId: parent.spaceId, parentId: page.pageId, title: traceTitle.text, storage: traceStorage.text });
                  });
            } catch (err) {
              const why = (await masker.maskOutputs(context, [(err as Error).message.replace(/ Nothing was written\.$/, "")])).texts[0];
              const hint = err instanceof Error && /HTTP 400/.test(err.message) && !tracePage ? " A page with the same title may already be in the space: rename or delete it, or publish with traceability set to false." : " Publish again to retry.";
              traced = ` The traceability matrix page was not written: ${why}${hint}`;
            }
            if (written) {
              const traceUrl = pageLink(written.url);
              const page = written;
              updateArtifactMeta(contexts, context, doc, () => ({ traceability: { pageId: page.pageId, url: traceUrl, pageVersion: page.version } }));
              traced = ` Its traceability matrix (${matrix.rows.length} requirement(s)) is at ${traceUrl}.`;
            }
          }
          const drawn = files.length && !diagramNote ? ` Its ${files.length} diagram(s) are attached as draw.io files.` : "";
          return text(`${existing ? "Updated" : "Created"} the Confluence page for "${doc.title}" (version ${page.version}): ${url}${drawn}${diagramNote}${traced}${await comment()}`);
        }),
    ),
  );
}
