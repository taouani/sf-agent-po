// The v1 MCP server's context tools: inputs go in masked and, while review is on, only once
// the user has checked them; what the tools return holds pseudonyms only.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type ContextRepository,
  decodeImage,
  DOCUMENT_KINDS,
  type Masker,
  type MetadataIndex,
  type NewDocument,
  type RequirementRepository,
  type SourceDocument,
  type TextRecognizer,
  type WorkflowRepository,
  type FeedbackRepository,
} from "@sf-agent-po/core";
import type { AtlassianClient, BackgroundIndexer, LoadError } from "@sf-agent-po/connectors";
import { loadLocalDocuments, MAX_FILE_BYTES, textDocument } from "@sf-agent-po/connectors";
import { z } from "zod";
import { requestDigest, type ApprovalServer, type PublishRequest } from "./approval/server.js";
import { describeCounts } from "./approval/page.js";
import { reviewsInputs } from "./approval/settings.js";
import { Intake, IntakeError, type IntakeResult, type Reviewer } from "./inputs.js";
import { KeyedLock } from "./artifacts.js";
import { PartialPublishError, registerBacklogTools } from "./jira.js";
import { registerFeedbackTools } from "./feedback.js";
import { registerTraceTools } from "./trace.js";
import { registerImpactTools } from "./impact-tools.js";
import { registerScopeTools } from "./scope-tools.js";
import { registerMetadataTools } from "./metadata-tools.js";
import { registerAgentPrompts } from "./prompts.js";
import { registerPublishTools } from "./publish.js";
import { registerWorkflowTools } from "./workflow/tools.js";
import { loadCheckRules } from "./checks.js";
import { callReviewer, PROGRESS_EVERY_MS, startProgress, type CallContext, type Progress } from "./review.js";

export interface ServerOptions {
  contexts: ContextRepository;
  masker: Masker;
  approval: ApprovalServer;
  /** The OCR, created on first use. */
  recognizer: () => Promise<TextRecognizer>;
  /** The running version: masked-input review is on by default in pre-releases. */
  version: string;
  /** Jira and Confluence, created on first use. */
  atlassian?: () => AtlassianClient;
  /**
   * Masks error messages while the detection model is not loaded (it may still have to be
   * downloaded, or fail to load): the rules and known values only. Defaults to `masker`.
   */
  errorMasker?: Masker;
  /** Whether the detection model is loaded, so error messages can be masked with it at once. */
  modelReady?: () => boolean;
  /** How a call opens the browser, and how often it reports progress. */
  review?: { open?: (url: string) => Promise<boolean> | boolean; progressEveryMs?: number };
  /** Overrides how each call reaches the user, for tests. */
  reviewer?: (call: CallContext) => Reviewer;
  /** The `doctor` checks as text, without the Atlassian calls: the server_status tool is offered with them. */
  status?: () => Promise<string>;
  /** The metadata index and its background runs: the metadata tools are offered with them. */
  metadata?: { index: MetadataIndex; indexer: BackgroundIndexer };
  /** The requirements and workflow runs: the workflow tools are offered with them. */
  workflows?: { requirements: RequirementRepository; runs: WorkflowRepository };
  /** Feedback on published work: the feedback tools are offered with it. */
  feedback?: FeedbackRepository;
}

/** Images taken from one folder in one call: each one is a page for the user to check. */
export const MAX_IMAGES = 20;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const isImage = (file: string) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());

const contextName = z
  .string()
  .regex(/^[\w.-]+$/, "use letters, digits, '.', '-' or '_'")
  .default("default")
  .describe("Name of the requirement context, e.g. a feature or epic name.");
const kind = z.enum(DOCUMENT_KINDS);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function describeDoc(d: SourceDocument, image = false): string {
  return `- [${d.id}] ${d.kind}: ${d.title} (${d.source}, ${d.content.length} chars${image ? ", image" : ""})`;
}

const HIDDEN_METADATA = new Set(["masking", "backlog", "fingerprint"]);

function renderDoc(d: SourceDocument): string {
  const visible = Object.fromEntries(Object.entries(d.metadata).filter(([k]) => !HIDDEN_METADATA.has(k)));
  const meta = Object.keys(visible).length ? `\nMetadata: ${JSON.stringify(visible)}` : "";
  return `## [${d.id}] ${d.kind}: ${d.title}\nSource: ${d.source}${meta}\n\n${d.content}`;
}

const REASONS: Record<string, string> = {
  rejected: "the user did not want it used",
  expired: "the user did not check it in time, or closed the page",
  "too-many-rounds": "it still showed values to hide after several checks",
};

/** What an add did, for the model: masked titles and pseudonyms only. */
function summary(context: string, result: IntakeResult, unread = 0): string {
  const lines: string[] = [];
  const counts: Record<string, number> = {};
  for (const d of result.added) {
    const masking = d.metadata.masking as { counts?: Record<string, number> } | undefined;
    for (const [t, n] of Object.entries(masking?.counts ?? {})) counts[t] = (counts[t] ?? 0) + n;
  }
  const images = new Set(result.images);
  lines.push(
    result.added.length
      ? `Added ${result.added.length} input(s) to context "${context}", with personal data masked (hidden: ${describeCounts(counts)}):\n${result.added.map((d) => describeDoc(d, images.has(d.id))).join("\n")}`
      : `Nothing was added to context "${context}".`,
  );
  for (const s of result.setAside) lines.push(`Not added: ${s.title}, because ${REASONS[s.reason] ?? s.reason}.`);
  if (result.ignored) lines.push(`${result.ignored} value(s) the user named were too short to hide.`);
  if (unread) lines.push(`${unread} file(s) could not be read.`);
  return lines.join("\n");
}

/** The images in a folder, recursively and outside hidden folders (.git), or the file itself. */
async function imagesAt(target: string): Promise<string[]> {
  const info = await stat(target);
  if (!info.isDirectory()) return isImage(target) ? [target] : [];
  const entries = await readdir(target, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && isImage(e.name) && !path.relative(target, e.parentPath).split(path.sep).some((p) => p.startsWith(".")))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

export function createServer(opts: ServerOptions): McpServer {
  // A broken word list stops the server here, not in the middle of a save.
  loadCheckRules();
  const server = new McpServer({ name: "sf-agent-po", version: opts.version });
  const { contexts, masker, approval } = opts;
  const progressOf = new WeakMap<CallContext, Progress>();
  const reviewerFor =
    opts.reviewer ?? ((call: CallContext) => callReviewer(approval, call, { open: opts.review?.open, progress: progressOf.get(call) }));
  const intakeFor = (call: CallContext) => new Intake({ contexts, masker, recognizer: opts.recognizer, version: opts.version, reviewer: reviewerFor(call) });

  /**
   * Runs a tool, reporting progress while it works (the first input may wait for the model
   * to download), and turns errors into results the model can act on. An error message may
   * quote an input (a file name, a value), so it is masked like one; what was added before
   * the error is told too, from masked fields.
   */
  const guard =
    <A extends { context?: string }>(fn: (args: A, call: CallContext) => Promise<ReturnType<typeof text>>) =>
    async (args: A, call: CallContext) => {
      const context = args.context ?? "default";
      const progress = startProgress(call, opts.review?.progressEveryMs ?? PROGRESS_EVERY_MS);
      progressOf.set(call, progress);
      try {
        return await fn(args, call);
      } catch (err) {
        const message = (err as Error).message;
        const full = opts.modelReady?.() ?? true;
        const masked = await (full ? masker : (opts.errorMasker ?? masker))
          .mask(context, message)
          .catch(() => (opts.errorMasker ?? masker).mask(context, message))
          .catch(() => ({ text: "Something failed, and its message could not be shown safely." }));
        const partial =
          err instanceof IntakeError && (err.partial.added.length || err.partial.setAside.length)
            ? `\n${summary(context, err.partial)}`
            : err instanceof PartialPublishError
              ? `\n${err.done}`
              : "";
        return { ...text(`Error: ${masked.text}${partial}`), isError: true };
      } finally {
        progress.stop();
      }
    };

  const publishKit = { contexts, masker, atlassian: opts.atlassian, reviewerFor, guard, contextName, lock: new KeyedLock(), ...(opts.workflows ? { requirements: opts.workflows.requirements } : {}), ...(opts.feedback && { feedback: opts.feedback }) };
  registerPublishTools(server, publishKit);
  registerBacklogTools(server, publishKit);
  registerAgentPrompts(server, publishKit, { guided: Boolean(opts.workflows) });
  if (opts.feedback) {
    registerFeedbackTools(server, { contexts, masker, feedback: opts.feedback, atlassian: opts.atlassian, reviewerFor, guard, contextName, ...(opts.workflows && { workflows: opts.workflows.runs }) });
  }
  if (opts.metadata) {
    registerMetadataTools(server, { ...opts.metadata, masker, guard, contextName });
    registerScopeTools(server, { index: opts.metadata.index, contexts, masker, reviewerFor, guard, contextName });
    registerImpactTools(server, { index: opts.metadata.index, contexts, masker, guard, contextName });
  }
  if (opts.workflows) {
    registerTraceTools(server, { contexts, requirements: opts.workflows.requirements, guard, contextName });
    registerWorkflowTools(server, { ...opts.workflows, contexts, masker, reviewerFor, guard, contextName, ...(opts.metadata ? { index: opts.metadata.index } : {}) });
  }

  const add = async (context: string, docs: NewDocument[], call: CallContext) => summary(context, await intakeFor(call).addDocuments(context, docs));

  if (opts.status) {
    const status = opts.status;
    server.registerTool(
      "server_status",
      {
        title: "Check the server",
        description:
          "Checks what this server needs (Node, workspace, masking key, name model, sf CLI and orgs, Jira and Confluence settings, git, gh, glab, AI tool files, index age) and says how to fix each problem. Use it when a tool fails for a reason outside the inputs, or when the user asks what is set up.",
        inputSchema: {},
      },
      // Error messages from the CLIs and the keychain reach the checks: masked like any input.
      guard(async () => {
        const out = await status();
        const fallback = opts.errorMasker ?? masker;
        const masked = await ((opts.modelReady?.() ?? true) ? masker : fallback).mask("default", out).catch(() => fallback.mask("default", out));
        return text(masked.text);
      }),
    );
  }

  server.registerTool(
    "context_list",
    { title: "List requirement contexts", description: "Lists the requirement contexts in this workspace.", inputSchema: {} },
    guard(async () => {
      const list = contexts.list();
      return text(list.length ? list.map((c) => `${c.name} (${c.documentCount} documents)`).join("\n") : "No contexts yet. Add an input to create one.");
    }),
  );

  server.registerTool(
    "context_show",
    {
      title: "Show requirement context",
      description: "Lists the inputs of a requirement context (id, kind, title, source, size) without their text. Personal data is masked as pseudonyms such as [PERSON_1].",
      inputSchema: { context: contextName },
    },
    guard(async ({ context }) => {
      const all = contexts.documents(context);
      if (!all.length) return text(`Context "${context}" is empty.`);
      // Inputs not masked yet (imported from 0.x) are counted, never shown: their titles and sources are in clear.
      const docs = all.filter((d) => d.masked);
      const unmasked = all.length - docs.length;
      const images = contexts.imageIds(context);
      const review = reviewsInputs(contexts.get(context)?.settings, opts.version);
      const pending = unmasked ? `\n${unmasked} input(s) are not masked yet, so they are not shown or read.` : "";
      return text(`Context "${context}" (${docs.length} inputs; input review ${review ? "on" : "off"}):\n${docs.map((d) => describeDoc(d, images.has(d.id))).join("\n")}${pending}`);
    }),
  );

  server.registerTool(
    "context_read",
    {
      title: "Read requirement context",
      description:
        "Returns the text of the inputs in a requirement context, optionally filtered by id or kind, and the images the user confirmed. " +
        "Personal data is masked as pseudonyms such as [PERSON_1]: keep them as they are in what you write, and the real values are put back when the user approves a publish.",
      inputSchema: {
        context: contextName,
        ids: z.array(z.string()).optional(),
        kinds: z.array(kind).optional(),
        images: z.boolean().default(true).describe("Include confirmed images (redacted) for models that can see them. Their text is always included."),
      },
    },
    guard(async ({ context, ids, kinds, images }) => {
      const docs = contexts.documents(context).filter((d) => d.masked && (!ids || ids.includes(d.id)) && (!kinds || kinds.includes(d.kind)));
      if (!docs.length) return text("No matching inputs.");
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
      for (const d of docs) {
        content.push({ type: "text", text: renderDoc(d) });
        const image = images ? contexts.getImage(context, d.id) : undefined;
        if (image) content.push({ type: "image", data: image.png.toString("base64"), mimeType: "image/png" });
      }
      return { content } as unknown as ReturnType<typeof text>;
    }),
  );

  server.registerTool(
    "context_add_file",
    {
      title: "Add local files",
      description:
        "Adds files to a context: notes, emails (.eml), PDF, Word, PowerPoint, Excel, CSV, draw.io, text, and images (PNG, JPEG). A folder is read recursively. " +
        "Personal data is masked before anything is stored. The user checks each image, and each input while input review is on, in their browser before it is added; the call waits for them.",
      inputSchema: {
        context: contextName,
        path: z.string().describe("File or folder path, including shared drives."),
        kind: kind.optional().describe("Document kind. Inferred when omitted (.eml files are emails)."),
      },
    },
    guard(async ({ context, path: target, kind }, call) => {
      const images = await imagesAt(target);
      if (images.length > MAX_IMAGES) throw new Error(`That folder holds ${images.length} images, and each one is checked by the user: add at most ${MAX_IMAGES} at a time, from a smaller folder.`);
      const errors: LoadError[] = [];
      const docs = await loadLocalDocuments(target, kind, { errors });
      if (!docs.length && !images.length) return text(errors.length ? `${errors.length} file(s) could not be read, and nothing was added.` : "No supported files found there.");
      const intake = intakeFor(call);
      const result: IntakeResult = docs.length ? await intake.addDocuments(context, docs) : { added: [], setAside: [], ignored: 0, images: [] };
      let unread = errors.length;
      for (const file of images) {
        let raw: Buffer;
        try {
          if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error("too large");
          raw = await readFile(file);
          decodeImage(raw); // a cut-off or oversized image is counted as unread, not an error for the whole folder
        } catch {
          unread++;
          continue;
        }
        let one: IntakeResult;
        try {
          one = await intake.addImage(context, { title: path.basename(file), source: path.resolve(file), raw, kind });
        } catch (err) {
          const partial = err instanceof IntakeError ? err.partial : undefined;
          throw new IntakeError((err as Error).message, {
            ...result,
            added: [...result.added, ...(partial?.added ?? [])],
            setAside: [...result.setAside, ...(partial?.setAside ?? [])],
          });
        }
        result.added.push(...one.added);
        result.setAside.push(...one.setAside);
        result.images.push(...one.images);
        result.ignored += one.ignored;
      }
      return text(summary(context, result, unread));
    }),
  );

  server.registerTool(
    "context_add_text",
    {
      title: "Add pasted text",
      description: "Adds text pasted into the conversation, such as an email body, meeting notes or a high-level design, to a context. Personal data is masked before it is stored.",
      inputSchema: { context: contextName, title: z.string(), content: z.string(), kind },
    },
    guard(async ({ context, title, content, kind }, call) => text(await add(context, [textDocument(title, content, kind)], call))),
  );

  server.registerTool(
    "context_add_jira",
    {
      title: "Add Jira issues",
      description: "Adds Jira Cloud issues to a context, by issue keys or by a JQL query. Personal data is masked before it is stored.",
      inputSchema: {
        context: contextName,
        keys: z.array(z.string()).optional(),
        jql: z.string().optional(),
        maxResults: z.number().int().min(1).max(200).default(50),
      },
      annotations: { openWorldHint: true },
    },
    guard(async ({ context, keys, jql, maxResults }, call) => {
      if (!keys?.length && !jql) throw new Error("Provide issue keys or a JQL query.");
      if (!opts.atlassian) throw new Error("Jira is not set up for this server.");
      const client = opts.atlassian();
      const docs: NewDocument[] = [];
      for (const key of keys ?? []) docs.push(await client.getIssue(key));
      if (jql) docs.push(...(await client.searchIssues(jql, maxResults)));
      return text(await add(context, docs, call));
    }),
  );

  server.registerTool(
    "context_add_confluence",
    {
      title: "Add Confluence pages",
      description: "Adds Confluence Cloud pages to a context, by page id or page URL. Personal data is masked before it is stored.",
      inputSchema: { context: contextName, pages: z.array(z.string()).min(1) },
      annotations: { openWorldHint: true },
    },
    guard(async ({ context, pages }, call) => {
      if (!opts.atlassian) throw new Error("Confluence is not set up for this server.");
      const client = opts.atlassian();
      const docs: NewDocument[] = [];
      for (const page of pages) docs.push(await client.getPage(page));
      return text(await add(context, docs, call));
    }),
  );

  server.registerTool(
    "context_remove_document",
    {
      title: "Remove input",
      description: "Removes one input from a context by its id.",
      inputSchema: { context: contextName, id: z.string() },
      annotations: { destructiveHint: true },
    },
    guard(async ({ context, id }) => text(contexts.removeDocument(context, id) ? `Removed ${id}.` : `No input ${id} in context "${context}".`)),
  );

  server.registerTool(
    "context_review_inputs",
    {
      title: "Turn input review on or off",
      description:
        "Sets whether the user checks each masked input in their browser before it is added to a context. Turning it on takes effect at once; turning it off needs the user's approval in their browser.",
      inputSchema: { context: contextName, on: z.boolean() },
    },
    guard(async ({ context, on }, call) => {
      if (!on) {
        // Only the user can stop checking inputs: a model misled by an input must not.
        const req: PublishRequest = {
          kind: "publish",
          target: `Settings of context "${context}"`,
          title: "Stop checking inputs",
          body: "Inputs added to this context from now on will be masked and stored without being shown to you first. Images are always shown.",
        };
        const decision = await reviewerFor(call).review(req);
        if (decision.digest !== requestDigest(req) || decision.status !== "approved") return text("The user did not approve it, so input review stays on.");
      }
      contexts.updateSettings(context, { reviewInputs: on });
      return text(`Input review is ${on ? "on" : "off"} for context "${context}".`);
    }),
  );

  return server;
}
