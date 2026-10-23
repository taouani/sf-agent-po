import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ArtifactMeta, getArtifact, hash, saveArtifact, updateArtifactMeta } from "../artifacts/artifacts.js";
import { type Backlog, type Epic, type Story, backlogSchema, backlogToMarkdown, checkBacklog, findingsToText } from "../artifacts/backlog.js";
import { poBacklogPrompt, poReviewStoriesPrompt } from "../agents/product-owner.js";
import { AtlassianError } from "../connectors/atlassian.js";
import { approvalToken, checkApproval } from "../publish/approval.js";
import { epicDescription, storyDescription } from "../publish/adf.js";
import { type Deps, confirmWithUser, contextName, guard, text } from "./shared.js";
import { userPrompt } from "./design.js";

/** Where each backlog item was published in Jira, so republishing updates instead of duplicating. */
interface JiraMapping {
  projectKey: string;
  /** `updated` is Jira's timestamp right after our last write, to spot edits made in Jira since. */
  items: Record<string, { key: string; url: string; hash: string; updated?: string }>;
  /** Dependency links already created, as "BLOCKER>BLOCKED" issue keys. */
  links: string[];
}

type BacklogArtifactMeta = ArtifactMeta & { backlog?: Backlog; jira?: JiraMapping };

const jiraTargetSchema = {
  context: contextName,
  artifactId: z.string().describe("Id of the backlog artifact."),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]+$/, "must be a Jira project key such as PORT"),
  epicIssueType: z.string().default("Epic"),
  storyIssueType: z.string().default("Story").describe("Used for stories and spikes (spikes also get the label \"spike\")."),
  storyPointsField: z
    .string()
    .regex(/^customfield_\d+$/)
    .optional()
    .describe("Custom field id for story points in this Jira site, e.g. customfield_10016. Left out, points only appear in the description."),
};

type JiraTargetArgs = { context: string; artifactId: string; projectKey: string; epicIssueType: string; storyIssueType: string; storyPointsField?: string };

type PlannedItem = {
  id: string;
  level: "epic" | "story";
  summary: string;
  action: "create" | "update" | "unchanged";
  key?: string;
  hash: string;
  fields: Record<string, unknown>;
  epicId?: string;
  /** For updates: the issue's current timestamp, and whether someone edited it in Jira since our last write. */
  jiraUpdated?: string;
  editedInJira?: boolean;
  /** The issue this item was published to no longer exists, so it is created again. */
  recreate?: boolean;
};

/** The Product Owner: backlog prompts, saving and checking backlogs, and publishing them to Jira. */
export function registerBacklogTools(server: McpServer, deps: Deps): void {
  const { store } = deps;

  const loadBacklog = async (context: string, artifactId: string) => {
    const doc = await getArtifact(store, context, artifactId);
    const meta = doc.metadata as BacklogArtifactMeta;
    if (doc.kind !== "backlog" || !meta.backlog) throw new Error(`${artifactId} is not a backlog artifact.`);
    return { doc, meta, backlog: meta.backlog };
  };

  server.registerTool(
    "backlog_save",
    {
      title: "Save backlog",
      description:
        "Saves a backlog of epics and user stories as a versioned artifact in the requirement context and runs the quality check. " +
        "Saving again with the same title creates a new version; keep epic and story ids stable so Jira issues are updated rather than duplicated.",
      inputSchema: { context: contextName, backlog: backlogSchema },
    },
    guard(async ({ context, backlog }) => {
      const sourceIds = [...new Set(backlog.epics.flatMap((e) => [...(e.sourceIds ?? []), ...e.stories.flatMap((s) => s.sourceIds ?? [])]))];
      const doc = await saveArtifact(store, context, {
        kind: "backlog",
        title: backlog.title,
        content: backlogToMarkdown(backlog),
        sourceIds,
        extra: { backlog },
      });
      const meta = doc.metadata as BacklogArtifactMeta;
      const stories = backlog.epics.reduce((n, e) => n + e.stories.length, 0);
      const findings = checkBacklog(backlog, (await store.load(context)).documents);
      return text(
        `Saved backlog "${backlog.title}" as ${doc.id}, version ${meta.version} (${backlog.epics.length} epics, ${stories} stories, status ${meta.status}).\n\n${findingsToText(findings)}`,
      );
    }),
  );

  server.registerTool(
    "backlog_get",
    {
      title: "Get backlog",
      description: "Returns a saved backlog as JSON, in the shape backlog_save expects, so it can be revised with its ids intact.",
      inputSchema: { context: contextName, artifactId: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ context, artifactId }) => {
      const { meta, backlog } = await loadBacklog(context, artifactId);
      const published = meta.jira ? `\n\nPublished to Jira project ${meta.jira.projectKey}: ${Object.entries(meta.jira.items).map(([id, i]) => `${id}=${i.key}`).join(", ")}` : "";
      return text(`${JSON.stringify(backlog, null, 2)}${published}`);
    }),
  );

  server.registerTool(
    "backlog_check",
    {
      title: "Check backlog quality",
      description: "Runs the backlog quality check: structure, INVEST signals, testable acceptance criteria, and traceability to the context inputs.",
      inputSchema: { context: contextName, artifactId: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ context, artifactId }) => {
      const { backlog } = await loadBacklog(context, artifactId);
      return text(findingsToText(checkBacklog(backlog, (await store.load(context)).documents)));
    }),
  );

  /** Works out every create and update. Shared by preview and publish so they cannot disagree. */
  const plan = async (args: JiraTargetArgs) => {
    const { doc, meta, backlog } = await loadBacklog(args.context, args.artifactId);
    const errors = checkBacklog(backlog, []).filter((f) => f.level === "error");
    if (errors.length) throw new Error(`Fix the backlog errors before publishing:\n${findingsToText(errors)}`);
    if (meta.jira && meta.jira.projectKey !== args.projectKey) {
      throw new Error(`This backlog was published to Jira project ${meta.jira.projectKey}. Publish to that project, or save the backlog under a new title for ${args.projectKey}.`);
    }

    const client = deps.atlassian();
    const project = await client.getProject(args.projectKey);
    for (const type of [args.epicIssueType, args.storyIssueType]) {
      if (!project.issueTypes.includes(type)) {
        throw new Error(`Project ${args.projectKey} has no issue type "${type}". Available: ${project.issueTypes.join(", ")}.`);
      }
    }

    const context = await store.load(args.context);
    const titles = new Map(context.documents.map((d) => [d.id, d.title]));
    const mapping: JiraMapping = meta.jira ?? { projectKey: args.projectKey, items: {}, links: [] };
    const labelsFor = (item: Epic | Story, extra: string[] = []) =>
      [...new Set(["sf-agent-po", ...(item.labels ?? []), ...(item.priority ? [`moscow-${item.priority}`] : []), ...extra])];

    const items: PlannedItem[] = [];
    const planItem = (id: string, level: PlannedItem["level"], summary: string, jiraKey: string | undefined, fields: Record<string, unknown>, epicId?: string) => {
      const h = hash(JSON.stringify({ fields, epicId, types: [args.epicIssueType, args.storyIssueType, args.storyPointsField] }));
      const known = mapping.items[id];
      const key = known?.key ?? jiraKey;
      const action = !key ? "create" : known && known.hash === h ? "unchanged" : "update";
      items.push({ id, level, summary, action, key, hash: h, fields, epicId });
    };

    for (const epic of backlog.epics) {
      planItem(epic.id, "epic", epic.summary, epic.jiraKey, {
        summary: epic.summary,
        description: epicDescription(epic, backlog, titles),
        labels: labelsFor(epic),
      });
      for (const story of epic.stories) {
        planItem(
          story.id,
          "story",
          story.summary,
          story.jiraKey,
          {
            summary: story.summary,
            description: storyDescription(story, backlog, titles),
            labels: labelsFor(story, story.type === "spike" ? ["spike"] : []),
            ...(args.storyPointsField && story.storyPoints ? { [args.storyPointsField]: story.storyPoints } : {}),
          },
          epic.id,
        );
      }
    }

    // Check every issue about to be updated: it may have been deleted, or edited in Jira since our last write.
    for (const item of items) {
      if (item.action !== "update") continue;
      const known = mapping.items[item.id];
      try {
        item.jiraUpdated = await client.getIssueUpdated(item.key!);
        item.editedInJira = !!known?.updated && known.updated !== item.jiraUpdated;
      } catch (err) {
        if (!(err instanceof AtlassianError && err.status === 404)) throw err;
        if (!known) throw new Error(`${item.id} revises ${item.key}, which does not exist or is not visible. Fix its jiraKey or remove it.`);
        Object.assign(item, { action: "create", key: undefined, recreate: true });
      }
    }

    // Dependency links between stories, by local id, that do not exist yet.
    const keyOf = (id: string) => items.find((i) => i.id === id)?.key;
    const links = backlog.epics
      .flatMap((e) => e.stories)
      .flatMap((s) => (s.dependsOn ?? []).map((blocker) => ({ blocker, blocked: s.id })))
      .filter(({ blocker, blocked }) => {
        const [a, b] = [keyOf(blocker), keyOf(blocked)];
        return !(a && b && mapping.links.includes(`${a}>${b}`));
      });

    const payload = {
      action: "jira_publish",
      context: args.context,
      artifactId: doc.id,
      artifactVersion: meta.version,
      target: { projectKey: args.projectKey, epicIssueType: args.epicIssueType, storyIssueType: args.storyIssueType, storyPointsField: args.storyPointsField },
      items: items.map((i) => [i.id, i.action, i.key ?? null, i.hash, i.jiraUpdated ?? null]),
      links: links.map((l) => `${l.blocker}>${l.blocked}`),
    };
    return { doc, backlog, client, project, mapping, items, links, payload };
  };

  server.registerTool(
    "jira_publish_preview",
    {
      title: "Preview Jira publish",
      description:
        "Lists exactly which Jira epics and stories would be created or updated from a backlog artifact, and returns an approval token. " +
        "Show it to the user; call jira_publish only after they explicitly approve.",
      inputSchema: jiraTargetSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const { doc, project, items, links, payload } = await plan(args);
      const count = (a: PlannedItem["action"]) => items.filter((i) => i.action === a).length;
      const lines = items.map((i) => {
        const indent = i.level === "story" ? "  " : "";
        const type = i.level === "epic" ? args.epicIssueType : args.storyIssueType;
        const what = i.action === "create" ? `create ${type}${i.recreate ? " (its earlier issue was deleted)" : ""}` : `${i.action} ${i.key}`;
        const edited = i.editedInJira ? " WARNING: edited in Jira since the last publish; those edits will be replaced" : "";
        return `${indent}- ${i.id} ${i.summary}: ${what}${edited}`;
      });
      const updates = count("update")
        ? `\nUpdating overwrites the summary, description and labels of those issues in Jira, including edits made there since the last publish.`
        : "";
      return text(
        [
          `Jira publish preview for project ${project.key} (${project.name})`,
          ``,
          `- Backlog: ${doc.id} "${doc.title}", version ${doc.metadata.version}`,
          `- ${count("create")} to create, ${count("update")} to update, ${count("unchanged")} unchanged, ${links.length} dependency link(s) to add`,
          `- Approval token: ${approvalToken(deps.approvalSecret, payload)}`,
          updates,
          ``,
          ...lines,
          ...(links.length ? ["", "Dependency links (blocker blocks blocked):", ...links.map((l) => `- ${l.blocker} blocks ${l.blocked}`)] : []),
          ``,
          `Ask the user to approve before publishing.`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "jira_publish",
    {
      title: "Publish to Jira",
      description:
        "Creates and updates Jira epics and stories from a backlog artifact. Requires the approval token from jira_publish_preview with the same arguments, " +
        "and must only be called after the user explicitly approved that preview.",
      inputSchema: { ...jiraTargetSchema, approvalToken: z.string().describe("Token returned by jira_publish_preview.") },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard(async ({ approvalToken: token, ...args }) => {
      const { doc, client, mapping, items, links, payload } = await plan(args);
      checkApproval(deps.approvalSecret, payload, token);
      const creates = items.filter((i) => i.action === "create").length;
      const updates = items.filter((i) => i.action === "update").length;
      await confirmWithUser(server, `Create ${creates} and update ${updates} issue(s) in Jira project ${args.projectKey}, and add ${links.length} dependency link(s)?`);

      const done: string[] = [];
      // Saves progress after every issue, so a failure part-way never leads to duplicates on the next run.
      const record = async (item: PlannedItem, key: string, url: string) => {
        mapping.items[item.id] = { key, url, hash: item.hash, updated: await client.getIssueUpdated(key) };
        await updateArtifactMeta(store, args.context, doc, () => ({ jira: { ...mapping } }));
      };

      try {
        for (const item of items) {
          if (item.action === "unchanged") continue;
          const parentKey = item.epicId ? mapping.items[item.epicId]?.key : undefined;
          const fields = { ...item.fields, ...(parentKey ? { parent: { key: parentKey } } : {}) };
          const issueType = item.level === "epic" ? args.epicIssueType : args.storyIssueType;
          const result =
            item.action === "create"
              ? await client.createIssue({ project: { key: args.projectKey }, issuetype: { name: issueType }, ...fields })
              : await client.updateIssue(item.key!, fields);
          await record(item, result.key, result.url);
          done.push(`${item.action === "create" ? "Created" : "Updated"} ${result.key} ${item.summary}`);
        }
        for (const link of links) {
          const blocker = mapping.items[link.blocker].key;
          const blocked = mapping.items[link.blocked].key;
          await client.linkBlocks(blocker, blocked);
          mapping.links.push(`${blocker}>${blocked}`);
          await updateArtifactMeta(store, args.context, doc, () => ({ jira: { ...mapping } }));
          done.push(`Linked ${blocker} blocks ${blocked}`);
        }
      } catch (err) {
        throw new Error(
          `${(err as Error).message}\n\nCompleted before the failure:\n${done.map((d) => `- ${d}`).join("\n") || "- nothing"}\n\n` +
            "Progress is saved. Fix the cause, then run jira_publish_preview again: issues already created will be updated, not duplicated.",
        );
      }

      const publishedVersion = doc.metadata.version;
      // If the backlog was saved again while this ran, the newer version is still unpublished.
      await updateArtifactMeta(store, args.context, doc, (meta) => ({
        status: meta.version === publishedVersion ? "published" : "changed",
        jira: { ...mapping, publishedVersion },
      }));
      return text(done.length ? `Published to Jira project ${args.projectKey}:\n${done.map((d) => `- ${d}`).join("\n")}` : "Nothing to publish: Jira is already up to date.");
    }),
  );

  const contextArg = z.string().optional().describe('Requirement context name (default "default").');

  server.registerPrompt(
    "po_backlog",
    {
      title: "Product Owner: build the backlog",
      description: "Turn the inputs in a requirement context (and the SA's design, if any) into epics and user stories with acceptance criteria.",
      argsSchema: { context: contextArg, scope: z.string().optional().describe("Optional scope, e.g. a capability or release.") },
    },
    ({ context, scope }) => userPrompt(poBacklogPrompt({ context: context || "default", scope })),
  );

  server.registerPrompt(
    "po_review_stories",
    {
      title: "Product Owner: review Jira stories",
      description: "Review the Jira stories in a requirement context for readiness and propose rewrites and splits.",
      argsSchema: { context: contextArg, scope: z.string().optional().describe("Optional subset, e.g. Jira keys or an epic.") },
    },
    ({ context, scope }) => userPrompt(poReviewStoriesPrompt({ context: context || "default", scope })),
  );
}
