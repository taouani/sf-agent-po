import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ArtifactMeta, getArtifact, hash, saveArtifact, updateArtifactMeta } from "../artifacts/artifacts.js";
import { type Backlog, type Epic, type Story, backlogSchema, backlogToMarkdown, checkBacklog, findingsToText } from "../artifacts/backlog.js";
import { poBacklogPrompt, poReviewStoriesPrompt } from "../agents/product-owner.js";
import { AtlassianError, type IssueState } from "../connectors/atlassian.js";
import { approvalToken, checkApproval } from "../publish/approval.js";
import { epicDescription, storyDescription } from "../publish/adf.js";
import { type Deps, confirmWithUser, contextName, guard, text } from "./shared.js";
import { userPrompt } from "./design.js";

/** Where each backlog item was published in Jira, so republishing updates instead of duplicating. */
interface JiraMapping {
  projectKey: string;
  /**
   * `hash` covers the fields last sent; `labels` are the labels this backlog
   * set, so a label removed here is removed in Jira while labels added in Jira
   * stay; `updated` is Jira's timestamp right after our last write, to spot
   * edits made in Jira since.
   */
  items: Record<string, { key: string; url: string; hash: string; labels?: string[]; updated?: string }>;
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
  /** "skip" is for won't-have items, which stay out of Jira. */
  action: "create" | "update" | "unchanged" | "skip";
  skipReason?: string;
  key?: string;
  /** Hash of exactly what is sent, so a change to anything else never forces an update. */
  hash: string;
  fields: Record<string, unknown>;
  labels: string[];
  epicId?: string;
  /** The issue as it is in Jira now, for items published before or named by jiraKey. */
  current?: IssueState;
  /** Whether someone edited the issue in Jira since our last write. */
  editedInJira?: boolean;
  /** The issue this item was published to no longer exists, so it is created again. */
  recreate?: boolean;
  /** A story that changes epic in Jira: `to` is the epic's key, or undefined when the epic is created in this run. */
  move?: { from?: string; to?: string };
};

/** Labels the publisher sets itself; replaced on every update. */
const MANAGED_LABEL = /^(sf-agent-po|spike|moscow-.+)$/;

/** On update, keeps labels added in Jira and replaces the ones this backlog set before. */
function mergeLabels(current: string[], previous: string[] | undefined, ours: string[]): string[] {
  const ownedBefore = new Set(previous ?? []);
  return [...new Set([...current.filter((l) => !MANAGED_LABEL.test(l) && !ownedBefore.has(l)), ...ours])];
}

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping the order of results. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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
        fingerprint: hash(JSON.stringify(backlog)),
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

  /** Works out every create, update and skip. Shared by preview and publish so they cannot disagree. */
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
    const add = (item: Epic | Story, level: PlannedItem["level"], skipReason: string | undefined, fields: Record<string, unknown>, labels: string[], epicId?: string) => {
      const known = mapping.items[item.id];
      if (!known && item.jiraKey && !item.jiraKey.startsWith(`${args.projectKey}-`)) {
        throw new Error(`${item.id} revises ${item.jiraKey}, which is not in project ${args.projectKey}.`);
      }
      items.push({
        id: item.id,
        level,
        summary: item.summary,
        action: skipReason ? "skip" : "create",
        skipReason,
        key: known?.key ?? item.jiraKey,
        hash: hash(JSON.stringify({ ...fields, labels })),
        fields,
        labels,
        epicId,
      });
    };

    for (const epic of backlog.epics) {
      const epicSkipped = epic.priority === "wont";
      add(epic, "epic", epicSkipped ? "won't have" : undefined, { summary: epic.summary, description: epicDescription(epic, backlog, titles) }, labelsFor(epic));
      for (const story of epic.stories) {
        const skipReason = epicSkipped ? `its epic ${epic.id} is won't have` : story.priority === "wont" ? "won't have" : undefined;
        const fields = {
          summary: story.summary,
          description: storyDescription(story, backlog, titles),
          // Points are only ever set, never cleared, so an estimate made in Jira survives a backlog without one.
          ...(args.storyPointsField && story.storyPoints ? { [args.storyPointsField]: story.storyPoints } : {}),
        };
        add(story, "story", skipReason, fields, labelsFor(story, story.type === "spike" ? ["spike"] : []), epic.id);
      }
    }

    // Two items writing to one issue would overwrite each other on every publish.
    const owners = new Map<string, string>();
    for (const item of items) {
      if (!item.key) continue;
      const other = owners.get(item.key);
      if (other) {
        throw new Error(`${other} and ${item.id} both point at ${item.key} (through jiraKey or an earlier publish). Give the new item its own id, or remove its jiraKey.`);
      }
      owners.set(item.key, item.id);
    }

    // Look at every issue this publish would touch: it may have been deleted, edited in Jira, or moved to another epic.
    const keyed = items.filter((i) => i.key && i.action !== "skip");
    const states = await mapLimit(keyed, 8, (i) =>
      client.getIssueState(i.key!).catch((err) => {
        if (err instanceof AtlassianError && err.status === 404) return undefined;
        throw err;
      }),
    );
    keyed.forEach((item, n) => {
      const known = mapping.items[item.id];
      const state = states[n];
      if (!state) {
        if (!known) throw new Error(`${item.id} revises ${item.key}, which does not exist or is not visible. Fix its jiraKey or remove it.`);
        Object.assign(item, { action: "create", key: undefined, recreate: true });
        return;
      }
      item.current = state;
      item.editedInJira = !!known?.updated && known.updated !== state.updated;
      item.action = known && known.hash === item.hash ? "unchanged" : "update";
    });

    // A story already in Jira moves when its epic is created in this run, or when it sits under another epic in Jira.
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const item of items) {
      if (item.level !== "story" || !item.current) continue;
      const epic = byId.get(item.epicId!)!;
      const to = epic.action === "create" ? undefined : epic.key;
      if (to && item.current.parentKey === to) continue;
      item.move = { from: item.current.parentKey, to };
      item.action = "update";
    }

    // Dependency links between stories, by local id, that do not exist yet. Won't-have stories are not in Jira to link.
    const published = (id: string) => byId.get(id)?.action !== "skip";
    const links = backlog.epics
      .flatMap((e) => e.stories)
      .flatMap((s) => (s.dependsOn ?? []).map((blocker) => ({ blocker, blocked: s.id })))
      .filter(({ blocker, blocked }) => published(blocker) && published(blocked))
      .filter(({ blocker, blocked }) => {
        const [a, b] = [byId.get(blocker)!.key, byId.get(blocked)!.key];
        return !(a && b && mapping.links.includes(`${a}>${b}`));
      });

    // Issues published from ids that are no longer in the backlog are left alone.
    const orphans = Object.entries(mapping.items)
      .filter(([id]) => !byId.has(id))
      .map(([id, i]) => `${id} (${i.key})`);

    const payload = {
      action: "jira_publish",
      context: args.context,
      artifactId: doc.id,
      artifactVersion: meta.version,
      target: { projectKey: args.projectKey, epicIssueType: args.epicIssueType, storyIssueType: args.storyIssueType, storyPointsField: args.storyPointsField },
      items: items.map((i) => [i.id, i.action, i.key ?? null, i.hash, i.current?.updated ?? null, i.move ? (i.move.to ?? "new epic") : null]),
      links: links.map((l) => `${l.blocker}>${l.blocked}`),
    };
    return { doc, client, project, mapping, items, links, orphans, payload };
  };

  server.registerTool(
    "jira_publish_preview",
    {
      title: "Preview Jira publish",
      description:
        "Lists exactly which Jira epics and stories would be created, updated or skipped from a backlog artifact, and returns an approval token. " +
        "Show it to the user; call jira_publish only after they explicitly approve.",
      inputSchema: jiraTargetSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const { doc, project, mapping, items, links, orphans, payload } = await plan(args);
      const count = (a: PlannedItem["action"]) => items.filter((i) => i.action === a).length;
      const describe = (i: PlannedItem) => {
        const type = i.level === "epic" ? args.epicIssueType : args.storyIssueType;
        if (i.action === "skip") return `skipped, ${i.skipReason}${i.key ? `; ${i.key} is left as it is in Jira` : ""}`;
        if (i.action === "create") return `create ${type}${i.recreate ? ` (its earlier issue ${mapping.items[i.id].key} was deleted)` : ""}`;
        if (i.action === "unchanged") return `unchanged ${i.key}`;
        const notes = [
          i.current && i.current.summary !== i.summary ? `now "${i.current.summary}"` : undefined,
          i.move ? `moves from ${i.move.from ? `epic ${i.move.from}` : "no epic"} to ${i.move.to ?? `the new epic ${i.epicId}`}` : undefined,
          i.editedInJira ? "WARNING: edited in Jira since the last publish; those edits will be replaced" : undefined,
        ].filter(Boolean);
        return `update ${i.key}${notes.length ? `; ${notes.join("; ")}` : ""}`;
      };
      const lines = items.map((i) => `${i.level === "story" ? "  " : ""}- ${i.id} ${i.summary}: ${describe(i)}`);
      const updates = count("update")
        ? `\nUpdating overwrites the summary and description of those issues (and story points, when set), including edits made there since the last publish. ` +
          `Labels added in Jira, status, assignee and comments are kept.`
        : "";
      return text(
        [
          `Jira publish preview for project ${project.key} (${project.name})`,
          ``,
          `- Backlog: ${doc.id} "${doc.title}", version ${doc.metadata.version}`,
          `- ${count("create")} to create, ${count("update")} to update, ${count("unchanged")} unchanged, ${count("skip")} skipped, ${links.length} dependency link(s) to add`,
          `- Approval token: ${approvalToken(deps.approvalSecret, payload)}`,
          updates,
          ``,
          ...lines,
          ...(links.length ? ["", "Dependency links (blocker blocks blocked):", ...links.map((l) => `- ${l.blocker} blocks ${l.blocked}`)] : []),
          ...(orphans.length ? ["", `No longer in this backlog, left as they are in Jira: ${orphans.join(", ")}`] : []),
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
    guard(({ approvalToken: token, ...args }) =>
      deps.publishLock.run(`${args.context}:${args.artifactId}`, async () => {
        const { doc, client, mapping, items, links, payload } = await plan(args);
        checkApproval(deps.approvalSecret, payload, token);
        const creates = items.filter((i) => i.action === "create").length;
        const updates = items.filter((i) => i.action === "update").length;
        await confirmWithUser(server, `Create ${creates} and update ${updates} issue(s) in Jira project ${args.projectKey}, and add ${links.length} dependency link(s)?`);

        const done: string[] = [];
        const save = () => updateArtifactMeta(store, args.context, doc, () => ({ jira: { ...mapping } }));
        // Best effort: the timestamp only feeds the "edited in Jira" warning, so failing to read it must not fail the publish.
        const refreshUpdated = async (id: string) => {
          const entry = mapping.items[id];
          const updated = await client.getIssueState(entry.key).then(
            (state) => state.updated,
            () => undefined,
          );
          if (updated) {
            entry.updated = updated;
            await save();
          }
        };
        // Saves the mapping right after every write, so a failure part-way never leads to duplicates on the next run.
        const record = async (item: PlannedItem, key: string, url: string) => {
          mapping.items[item.id] = { key, url, hash: item.hash, labels: item.labels };
          await save();
          await refreshUpdated(item.id);
        };

        try {
          for (const item of items) {
            if (item.action === "unchanged" || item.action === "skip") continue;
            const parentKey = item.epicId ? mapping.items[item.epicId]?.key : undefined;
            const parent = parentKey && (item.action === "create" || item.move) ? { parent: { key: parentKey } } : {};
            if (item.action === "create") {
              const issueType = item.level === "epic" ? args.epicIssueType : args.storyIssueType;
              const result = await client.createIssue({ project: { key: args.projectKey }, issuetype: { name: issueType }, ...item.fields, labels: item.labels, ...parent });
              await record(item, result.key, result.url);
              done.push(`Created ${result.key} ${item.summary}`);
            } else {
              const labels = mergeLabels(item.current?.labels ?? [], mapping.items[item.id]?.labels, item.labels);
              const result = await client.updateIssue(item.key!, { ...item.fields, labels, ...parent });
              await record(item, result.key, result.url);
              done.push(`Updated ${result.key} ${item.summary}${item.move ? `, now under epic ${parentKey}` : ""}`);
            }
          }
          for (const link of links) {
            const blocker = mapping.items[link.blocker].key;
            const blocked = mapping.items[link.blocked].key;
            await client.linkBlocks(blocker, blocked);
            mapping.links.push(`${blocker}>${blocked}`);
            await save();
            done.push(`Linked ${blocker} blocks ${blocked}`);
            // A new link changes both issues' timestamps; refresh them so the next preview does not report it as an edit made in Jira.
            await refreshUpdated(link.blocker);
            await refreshUpdated(link.blocked);
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
        const skipped = items.filter((i) => i.action === "skip").length;
        const summary = done.length ? `Published to Jira project ${args.projectKey}:\n${done.map((d) => `- ${d}`).join("\n")}` : "Nothing to publish: Jira is already up to date.";
        return text(`${summary}${skipped ? `\n\nSkipped ${skipped} won't-have item(s); they stay in the backlog only.` : ""}`);
      }),
    ),
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
