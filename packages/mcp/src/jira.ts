// The Product Owner's backlogs: saved masked like designs, checked, and published to Jira
// with the real values put back only for the write, once the user approved, on the approval
// page, every issue as it will be written. What the tools return holds pseudonyms only, and
// what Jira holds now (summaries, labels, the project's name) is shown on the page only.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { adfToText, AtlassianError, type AtlassianClient, type CreateField, type IssueState } from "@sf-agent-po/connectors";
import { z } from "zod";
import { requestDigest, type PublishRequest } from "./approval/server.js";
import { type Artifact, type ArtifactMeta, getArtifact, hash, type JiraMapping, updateArtifactMeta } from "./artifacts.js";
import {
  allStories,
  type AdfNode,
  type Backlog,
  backlogSchema,
  checkBacklog,
  coverageFindings,
  type Epic,
  epicDescription,
  findingsToText,
  mapAdfText,
  maskBacklog,
  saveBacklog,
  type Story,
  storyDescription,
} from "./backlog.js";
import { atlassianCall, decisionComment, type PublishKit } from "./publish.js";
import { contextLanguage } from "./checks.js";
import type { DetailedDesign } from "./design/detailed-schema.js";
import { planSubtasks, type SubtaskMode } from "./subtasks.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

type BacklogMeta = ArtifactMeta & { backlog?: Backlog };

/** Fields a project requires on create, by level, as the user gave them: kept per project in the context. */
type LevelFields = Partial<Record<"epic" | "story" | "subtask", Record<string, unknown>>>;

/** Fields that may be set on create: custom fields and the standard ones a project may require. People (assignee, reporter) are not: they would be kept. */
const SETTABLE_FIELD = /^(customfield_\d+|components|fixVersions|versions|priority|duedate|environment|security)$/;
/** A value naming a person, which is never kept. */
const namesPerson = (value: unknown): boolean =>
  Array.isArray(value) ? value.some(namesPerson) : !!value && typeof value === "object" && Object.entries(value).some(([k, v]) => /^(accountId|emailAddress|username)$/.test(k) || namesPerson(v));
const levelFields = z
  .record(z.string().regex(SETTABLE_FIELD, "must be a custom field id such as customfield_10100, or components, fixVersions, versions, priority, duedate, environment or security"), z.unknown())
  .refine((o) => Object.keys(o).length <= 20, "at most 20 fields")
  .refine((o) => !namesPerson(o), "must not name a person (accountId, emailAddress, username): set people in Jira, with a default or an automation");
const fieldsArg = z
  .object({ epic: levelFields.optional(), story: levelFields.optional(), subtask: levelFields.optional() })
  .strict()
  .describe(
    'Fields the project requires when an issue is created, by level, in Jira\'s REST format: {"epic": {"customfield_10011": "{summary}"}, "story": {"customfield_10100": {"value": "CRM Team"}, "components": [{"name": "Salesforce"}]}}. ' +
      'Find them with jira_fields. "{summary}" stands for the issue\'s summary. Set only on create. Kept for the project once a publish with them went through, so later publishes reuse them; a level given replaces that level only. ' +
      'Pass a level as {} to forget it, or {} to forget them all (with the next publish that has something to write).',
  );

/** The fields kept for a project in a context. */
function savedFields(contexts: PublishKit["contexts"], context: string, projectKey: string): LevelFields | undefined {
  const all = contexts.get(context)?.settings.jiraFields as Record<string, LevelFields> | undefined;
  const kept = all?.[projectKey];
  return kept && typeof kept === "object" ? kept : undefined;
}

/** A field value with each string masked, so what is kept holds no personal data in clear. */
async function maskLeaves(value: unknown, mask: (t: string) => Promise<string>): Promise<unknown> {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return Promise.all(value.map((v) => maskLeaves(v, mask)));
  if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await maskLeaves(v, mask)] as const)));
  return value;
}

/** A field value with each string's pseudonyms put back, and "{summary}" made the issue's summary. */
function fieldValue(value: unknown, reveal: (t: string) => string, summary: string): unknown {
  if (typeof value === "string") return reveal(value).split("{summary}").join(summary);
  if (Array.isArray(value)) return value.map((v) => fieldValue(v, reveal, summary));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fieldValue(v, reveal, summary)]));
  return value;
}

type JiraTarget = {
  context: string;
  artifactId: string;
  projectKey: string;
  epicIssueType: string;
  storyIssueType: string;
  storyPointsField?: string;
  fields?: LevelFields;
  subtasks: boolean;
  subtaskMode: SubtaskMode;
  detailedDesignId?: string;
  subtaskIssueType?: string;
};

/** One epic or story, masked, and what publishing does with it. */
interface PlannedItem {
  id: string;
  level: "epic" | "story" | "subtask";
  /** The masked summary. */
  summary: string;
  /** "skip" is for won't-have items, which stay out of Jira. */
  action: "create" | "update" | "unchanged" | "skip";
  skipReason?: string;
  key?: string;
  /** Hash of the masked fields and labels sent, so a change to anything else never forces an update. */
  hash: string;
  /** Masked: summary, description (ADF) and, when asked, story points. */
  fields: { summary: string; description: AdfNode } & Record<string, unknown>;
  /** Masked labels. */
  labels: string[];
  epicId?: string;
  /** A sub-task's story id. */
  parentId?: string;
  /** The issue as it is in Jira now (in clear: for the approval page only). */
  current?: IssueState;
  /** Whether someone edited the issue in Jira since our last write. */
  editedInJira?: boolean;
  /** The issue this item was published to no longer exists, so it is created again. */
  recreate?: boolean;
  /** A story that changes epic in Jira: `to` is the epic's key, or undefined when the epic is created in this run. */
  move?: { from?: string; to?: string };
}

/** Labels the publisher sets itself; replaced on every update. */
const MANAGED_LABEL = /^(sf-agent-po|spike|moscow-.+)$/;

/** On update, keeps labels added in Jira and replaces the ones this backlog set before. */
export function mergeLabels(current: string[], previous: string[] | undefined, ours: string[]): string[] {
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
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The labels publishing sets on an epic or story. */
export const labelsFor = (item: Epic | Story, extra: string[] = []) => [...new Set(["sf-agent-po", ...(item.labels ?? []), ...(item.priority ? [`moscow-${item.priority}`] : []), ...extra])];

/** A story's fields as publishing sends them, masked. */
export function storyFields(story: Story, backlog: Backlog, titles: Map<string, string>, storyPointsField?: string): PlannedItem["fields"] {
  return {
    summary: story.summary,
    description: storyDescription(story, backlog, titles),
    // Points are only ever set, never cleared, so an estimate made in Jira survives a backlog without one.
    ...(storyPointsField && story.storyPoints ? { [storyPointsField]: story.storyPoints } : {}),
  };
}

/** What publishing records of what it sent, to see whether an item changed since. */
export const itemHash = (fields: PlannedItem["fields"], labels: string[]) => hash(JSON.stringify({ ...fields, labels }));

/** Jira's limit on a summary, which a real value can take the summary past. */
const SUMMARY_MAX = 255;
export const oneLine = (s: string) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= SUMMARY_MAX ? flat : flat.slice(0, SUMMARY_MAX).replace(/[\uD800-\uDBFF]$/, "");
};

/**
 * A publish that stopped part-way. `done` lists what was written, from masked fields: it is
 * added to the error after the message is masked, so its pseudonyms stay as they are.
 */
export class PartialPublishError extends Error {
  constructor(
    message: string,
    readonly done: string,
  ) {
    super(message);
  }
}

const jira = <T>(what: string, run: () => Promise<T>) => atlassianCall("Jira", what, run);

export function registerBacklogTools(server: McpServer, kit: PublishKit): void {
  const { contexts, masker, guard, contextName, lock } = kit;
  /** The context's masked documents: the only ones the check and the descriptions may quote. */
  const maskedDocs = (context: string) => contexts.documents(context).filter((d) => d.masked);

  /**
   * The quality check, with the context's confirmed requirements when the server keeps them: an
   * item may cite only those. A backlog that cites some is told which ones no story delivers; one
   * that cites none (from before requirements, or of part of the work) is not.
   */
  const quality = (context: string, backlog: Backlog) => {
    const confirmed = kit.requirements?.list(context).filter((r) => r.status === "confirmed");
    const findings = checkBacklog(backlog, maskedDocs(context), contextLanguage(contexts, context), confirmed ? { requirements: confirmed } : {});
    const cites = backlog.epics.some((e) => e.requirementIds?.length || e.stories.some((s) => s.requirementIds?.length));
    return confirmed && cites ? [...findings, ...coverageFindings(backlog, confirmed, "warning")] : findings;
  };

  const loadBacklog = (context: string, artifactId: string) => {
    const doc = getArtifact(contexts, context, artifactId);
    const meta = doc.metadata as BacklogMeta;
    if (doc.kind !== "backlog" || !meta.backlog) throw new Error(`${artifactId} is not a backlog artifact.`);
    return { doc, meta, backlog: meta.backlog };
  };

  server.registerTool(
    "backlog_save",
    {
      title: "Save backlog",
      description:
        "Saves a backlog of epics and user stories as a versioned artifact in the requirement context and runs the quality check. " +
        "Saving again with the same title creates a new version; keep epic and story ids stable so Jira issues are updated rather than duplicated. " +
        "Keep the pseudonyms from the inputs (such as [PERSON_1]) as they are: their real values are put back when the user approves a publish. " +
        "Personal data written in clear is masked when the backlog is saved.",
      inputSchema: { context: contextName, backlog: backlogSchema },
    },
    guard(async ({ context, backlog: written }: { context: string; backlog: Backlog }) => {
      const { backlog, hidden } = await maskBacklog(masker, context, written);
      const doc = saveBacklog(contexts, context, backlog);
      const meta = doc.metadata;
      const stories = backlog.epics.reduce((n, e) => n + e.stories.length, 0);
      const note = hidden ? ` ${hidden} value(s) written in clear were masked; use the pseudonyms in later versions.` : "";
      return text(
        `Saved backlog "${doc.title}" as ${doc.id}, version ${meta.version} (${backlog.epics.length} epics, ${stories} stories, status ${meta.status}).${note}\n\n` +
          findingsToText(quality(context, backlog)),
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
    guard(async ({ context, artifactId }: { context: string; artifactId: string }) => {
      const { meta, backlog } = loadBacklog(context, artifactId);
      const published = meta.jira
        ? `\n\nPublished to Jira project ${meta.jira.projectKey}: ${Object.entries(meta.jira.items)
            .map(([id, i]) => `${id}=${i.key}`)
            .join(", ")}`
        : "";
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
    guard(async ({ context, artifactId }: { context: string; artifactId: string }) => {
      const { backlog } = loadBacklog(context, artifactId);
      return text(findingsToText(quality(context, backlog)));
    }),
  );

  /** Works out every create, update and skip, from the masked backlog and what Jira holds now. */
  const plan = async (args: JiraTarget, doc: Artifact, meta: BacklogMeta, backlog: Backlog, client: AtlassianClient) => {
    const errors = checkBacklog(backlog, []).filter((f) => f.level === "error");
    if (errors.length) throw new Error(`Fix the backlog errors before publishing:\n${findingsToText(errors)}`);
    if (meta.jira && meta.jira.projectKey !== args.projectKey) {
      throw new Error(`This backlog was published to Jira project ${meta.jira.projectKey}. Publish to that project, or save the backlog under a new title for ${args.projectKey}.`);
    }
    const project = await jira("return the project", () => client.getProject(args.projectKey));
    for (const type of [args.epicIssueType, args.storyIssueType]) {
      if (!project.issueTypes.includes(type)) throw new Error(`Project ${args.projectKey} has no issue type "${type}". Available: ${project.issueTypes.join(", ")}.`);
    }

    const titles = new Map(maskedDocs(args.context).map((d) => [d.id, d.title]));
    const mapping: JiraMapping = structuredClone(meta.jira) ?? { projectKey: args.projectKey, items: {}, links: [] };

    const items: PlannedItem[] = [];
    const add = (item: Epic | Story, level: PlannedItem["level"], skipReason: string | undefined, fields: PlannedItem["fields"], labels: string[], epicId?: string) => {
      const known = mapping.items[item.id];
      if (!known && item.jiraKey && !item.jiraKey.startsWith(`${args.projectKey}-`)) throw new Error(`${item.id} revises ${item.jiraKey}, which is not in project ${args.projectKey}.`);
      items.push({
        id: item.id,
        level,
        summary: item.summary,
        action: skipReason ? "skip" : "create",
        skipReason,
        key: known?.key ?? item.jiraKey,
        hash: itemHash(fields, labels),
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
        const fields = storyFields(story, backlog, titles, args.storyPointsField);
        add(story, "story", skipReason, fields, labelsFor(story, story.type === "spike" ? ["spike"] : []), epic.id);
      }
    }

    // Sub-tasks from the detailed design that builds this backlog: one per component change (under the first story that needs it, or each story it cites, by mode).
    const notes: string[] = [];
    const found = args.subtasks ? designFor(args.context, doc.id, args.detailedDesignId) : undefined;
    const design = found?.chosen;
    if (found?.note) notes.push(found.note);
    let subtaskType: string | undefined;
    let unmatched: string[] = [];
    if (design) {
      const types = project.subtaskTypes ?? [];
      if (args.subtaskIssueType && !types.includes(args.subtaskIssueType))
        throw new Error(`Project ${args.projectKey} has no sub-task issue type "${args.subtaskIssueType}". Available: ${types.join(", ") || "none"}.`);
      subtaskType = args.subtaskIssueType ?? types.find((t) => /^sub-?task$/i.test(t.replace(/\s+/g, ""))) ?? types[0];
      const storyItems = new Map(items.filter((i) => i.level === "story").map((i) => [i.id, i]));
      const planned = planSubtasks(backlog, design.design, design.doc.title, (story) => mapping.items[story.id]?.key ?? story.jiraKey, {
        mode: args.subtaskMode,
        skipped: (story) => storyItems.get(story.id)?.action === "skip",
        known: (id) => !!mapping.items[id],
        previous: (id) => !!mapping.subtasks?.includes(id),
      });
      unmatched = planned.unmatched;
      if (!subtaskType) notes.push(`Project ${args.projectKey} has no sub-task issue type, so the ${planned.subtasks.length} sub-task(s) of the detailed design ${design.doc.id} are left out; the stories are published.`);
      else if (!planned.subtasks.length) notes.push(`The detailed design ${design.doc.id} gives no sub-task to these stories: its deployment list cites none of them.`);
      else {
        const byStory = new Map<string, PlannedItem[]>();
        for (const t of planned.subtasks) {
          const story = storyItems.get(t.storyId)!;
          const fields = { summary: t.summary, description: t.description };
          const labels = ["sf-agent-po"];
          const known = mapping.items[t.id];
          const item: PlannedItem = {
            id: t.id,
            level: "subtask",
            summary: t.summary,
            action: story.action === "skip" ? "skip" : "create",
            ...(story.action === "skip" ? { skipReason: `its story ${story.id} is not published` } : {}),
            ...(known ? { key: known.key } : {}),
            hash: hash(JSON.stringify({ ...fields, labels })),
            fields,
            labels,
            parentId: story.id,
          };
          byStory.set(story.id, [...(byStory.get(story.id) ?? []), item]);
        }
        // Each story's sub-tasks right after it: created once their story exists, and shown under it.
        items.splice(0, items.length, ...items.flatMap((i) => [i, ...(i.level === "story" ? (byStory.get(i.id) ?? []) : [])]));
      }
    }

    // Two items writing to one issue would overwrite each other on every publish.
    const owners = new Map<string, string>();
    for (const item of items) {
      if (!item.key) continue;
      const other = owners.get(item.key);
      if (other) throw new Error(`${other} and ${item.id} both point at ${item.key} (through jiraKey or an earlier publish). Give the new item its own id, or remove its jiraKey.`);
      owners.set(item.key, item.id);
    }

    // Every issue this publish would touch: it may have been deleted, edited in Jira, or moved to another epic.
    const keyed = items.filter((i) => i.key && i.action !== "skip");
    const states = await mapLimit(keyed, 8, (i) =>
      client.getIssueState(i.key!).catch((err) => {
        if (err instanceof AtlassianError && err.status === 404) return undefined;
        if (err instanceof AtlassianError) throw new Error(`Jira did not return ${i.key} (HTTP ${err.status}). Nothing was written.`);
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

    // A sub-task still in Jira while its story is created again is left where it is, and a new one goes under the new story.
    const strays: string[] = [];
    for (const item of items) {
      if (item.level !== "subtask" || !item.current) continue;
      const story = items.find((i) => i.id === item.parentId)!;
      if (story.action === "create") {
        strays.push(`${item.id} (${item.key})`);
        Object.assign(item, { action: "create", key: undefined, current: undefined });
      }
    }

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

    // Dependency links between stories that do not exist yet. Won't-have stories are not in Jira to link.
    const published = (id: string) => byId.get(id)?.action !== "skip";
    const links = backlog.epics
      .flatMap((e) => e.stories)
      .flatMap((s) => [...new Set(s.dependsOn ?? [])].map((blocker) => ({ blocker, blocked: s.id })))
      .filter(({ blocker, blocked }) => published(blocker) && published(blocked))
      .filter(({ blocker, blocked }) => {
        const [a, b] = [byId.get(blocker)!.key, byId.get(blocked)!.key];
        return !(a && b && mapping.links.includes(`${a}>${b}`));
      });

    // Issues published from ids no longer in the backlog, or sub-tasks not planned this time, are left alone.
    // Only those still open: one closed or deleted in Jira is dealt with, so it is not listed again on every publish.
    const left = Object.entries(mapping.items).filter(([id]) => !byId.has(id));
    const open = left.length
      ? await client.getStories(left.map(([, i]) => i.key)).then(
          (found) => (key: string) => !!found.get(key) && found.get(key)!.status !== "done",
          () => () => true, // best effort: listed when Jira cannot say
        )
      : () => true;
    const gone = left.filter(([, i]) => open(i.key));
    const orphans = gone.filter(([id]) => !id.includes(":")).map(([id, i]) => `${id} (${i.key})`);
    const unplanned = [...gone.filter(([id]) => id.includes(":")).map(([id, i]) => `${id} (${i.key})`), ...strays];
    return { project, mapping, items, links, orphans, unplanned, notes, unmatched, subtaskType, design: design?.doc };
  };

  /**
   * The detailed design whose deployment list gives the sub-tasks: the one named, or the newest
   * that builds this backlog. `note` tells the model which one, and what was left out.
   */
  const designFor = (context: string, backlogId: string, id?: string) => {
    const designs = maskedDocs(context).filter((d) => d.kind === "design" && (d.metadata as ArtifactMeta).artifact && (d.metadata as ArtifactMeta).artifactType === "detailed");
    const json = (d: (typeof designs)[number]) => (d.metadata as { design?: DetailedDesign }).design;
    if (id) {
      const doc = designs.find((d) => d.id === id);
      if (!doc) throw new Error(`${id} is not a detailed design in context "${context}".`);
      const design = json(doc);
      if (!design) throw new Error(`${id} was not written by the detailed design workflow, so it has no deployment list to make sub-tasks from.`);
      const other = design.scope?.backlogId && design.scope.backlogId !== backlogId ? ` Its stories come from another backlog (${design.scope.backlogId}): only the ones that are also in this backlog get sub-tasks.` : "";
      return { chosen: { doc, design }, note: `Sub-tasks come from the detailed design ${doc.id}.${other}` };
    }
    const linked = designs
      .filter((d) => json(d)?.scope?.backlogId === backlogId)
      .sort((a, b) => String((b.metadata as ArtifactMeta).savedAt ?? b.updatedAt).localeCompare(String((a.metadata as ArtifactMeta).savedAt ?? a.updatedAt)));
    if (!linked.length) {
      const any = designs.some((d) => json(d));
      return { chosen: undefined, note: any ? "No detailed design names this backlog in its scope, so no sub-task was planned: pass detailedDesignId to take them from one." : undefined };
    }
    const [doc, ...others] = linked;
    return {
      chosen: { doc: doc!, design: json(doc!)! },
      note: `Sub-tasks come from the detailed design ${doc!.id}, the newest that builds this backlog.${others.length ? ` Also building it, and left out: ${others.map((d) => d.id).join(", ")} (pass detailedDesignId to use one of them).` : ""}`,
    };
  };

  server.registerTool(
    "jira_fields",
    {
      title: "Required Jira fields",
      description:
        "Lists the fields a Jira project requires when an epic, a story or a sub-task is created, with the values Jira allows, and the fields that may hold story points. " +
        "Ask the user which value to use for each, then pass them to jira_publish as fields. Names and values are masked.",
      inputSchema: {
        context: contextName,
        projectKey: z.string().regex(/^[A-Z][A-Z0-9_]+$/, "must be a Jira project key such as PORT"),
        issueTypes: z.array(z.string().min(1)).min(1).max(5).default(["Epic", "Story"]).describe("The issue types to look at, as jira_publish names them (epicIssueType, storyIssueType, subtaskIssueType)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ context, projectKey, issueTypes }: { context: string; projectKey: string; issueTypes: string[] }) => {
      if (!kit.atlassian) throw new Error("Jira is not set up for this server.");
      const client = kit.atlassian();
      // Set by jira_publish itself, or by Jira.
      const own = new Set(["summary", "description", "project", "issuetype", "parent", "labels"]);
      const sections: string[] = [];
      for (const type of issueTypes) {
        const fields: CreateField[] = await client.createFields(projectKey, type).catch((err) => {
          if (err instanceof AtlassianError) throw new Error(`Jira refused to list the fields of ${type} in ${projectKey} (HTTP ${err.status}).${err.detail?.length ? ` Jira says: ${err.detail.join("; ")}` : ""}`);
          throw err;
        });
        const required = fields.filter((f) => f.required && !f.hasDefault && !own.has(f.id));
        const points = fields.filter((f) => /story ?points?|points? d'histoire|estimation/i.test(f.name) && f.type === "number");
        const lines = required.map((f) => {
          const values = f.allowed.length ? `; allowed: ${f.allowed.map((v) => (v.id ? `${v.name} (id ${v.id})` : v.name)).join(", ")}${f.allowedCount > f.allowed.length ? `, and ${f.allowedCount - f.allowed.length} more` : ""}` : "";
          const epicName = /^epic name$/i.test(f.name) ? ' (pass "{summary}" to use the epic\'s summary)' : "";
          const person = /\buser\b/.test(f.type) ? " (a person: give it a default in Jira, or set it there; jira_publish does not keep people)" : "";
          return `- ${f.id} "${f.name}" (${f.type})${epicName}${person}${values}`;
        });
        sections.push(
          [
            `${type}: ${required.length ? `${required.length} required field(s) Jira does not fill itself:` : "no required field beyond what jira_publish sets."}`,
            ...lines,
            ...(points.length ? [`Story points field: ${points.map((f) => `${f.id} "${f.name}"`).join(", ")} (pass it as storyPointsField).`] : []),
          ].join("\n"),
        );
      }
      // Jira's text is input, masked as such: a name that looks like a pseudonym is not taken for one.
      const masked = await masker.mask(context, sections.join("\n\n"));
      return text(
        `${masked.text}\n\n` +
          'Pass the values as fields to jira_publish, by level, in Jira\'s format: an option as {"value": "name"} or {"id": "10001"}, several as [{"name": "..."}]. Ask the user for any value you cannot tell.',
      );
    }),
  );

  server.registerTool(
    "jira_publish",
    {
      title: "Publish to Jira",
      description:
        "Creates and updates Jira epics and stories from a backlog artifact, and links dependent stories. The user sees every issue exactly as it will be written, " +
        "with the real values, in their browser, and Jira is written only if they approve it there; the call waits for them. " +
        "Updating replaces the summary and description of issues published before; labels added in Jira, status, assignee and comments are kept. " +
        "Publishing again updates the same issues.",
      inputSchema: {
        context: contextName,
        artifactId: z.string().describe("Id of the backlog artifact."),
        projectKey: z.string().regex(/^[A-Z][A-Z0-9_]+$/, "must be a Jira project key such as PORT"),
        epicIssueType: z.string().default("Epic"),
        storyIssueType: z.string().default("Story").describe('Used for stories and spikes (spikes also get the label "spike").'),
        storyPointsField: z
          .string()
          .regex(/^customfield_\d+$/)
          .optional()
          .describe("Custom field id for story points in this Jira site, e.g. customfield_10016. Left out, points only appear in the description."),
        subtasks: z
          .boolean()
          .default(true)
          .describe("Add the sub-tasks of the deployment list of the detailed design that builds this backlog."),
        subtaskMode: z
          .enum(["per-change", "per-story"])
          .default("per-change")
          .describe(
            '"per-change": one sub-task per component change, under the first story that needs it, naming the other stories. "per-story": one under every story the change cites. Sub-tasks already in Jira that a mode no longer plans are left as they are.',
          ),
        detailedDesignId: z.string().optional().describe("The detailed design to take the sub-tasks from. Left out: the newest one whose stories come from this backlog."),
        subtaskIssueType: z.string().optional().describe("The sub-task issue type. Left out: the project's own, read from Jira."),
        fields: fieldsArg.optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard((args: JiraTarget, call) =>
      lock.run(`${args.context}:${args.artifactId}`, async () => {
        const { context } = args;
        const { doc, meta, backlog } = loadBacklog(context, args.artifactId);
        if (!kit.atlassian) throw new Error("Jira is not set up for this server.");
        const client = kit.atlassian();
        const { project, mapping, items, links, orphans, unplanned, notes, unmatched, subtaskType, design } = await plan(args, doc, meta, backlog, client);
        // Saved with the mapping once the publish goes through (never on a rejection): where each change went this time.
        const plannedTasks = items.filter((i) => i.level === "subtask" && i.action !== "skip").map((i) => i.id);
        if (plannedTasks.length) mapping.subtasks = plannedTasks;
        // What stays in Jira untouched, masked: the model tells the user which issues to close, as this tool never deletes.
        const leftInJira = [
          ...(orphans.length ? [`No longer in this backlog, left as they are in Jira: ${orphans.join(", ")}.`] : []),
          ...(unplanned.length ? [`Sub-tasks not planned in this publish, left as they are in Jira: ${unplanned.join(", ")}. Tell the user to close them in Jira if the work is covered elsewhere.`] : []),
        ];
        const noteText = notes.length || leftInJira.length ? `\n\n${[...notes, ...leftInJira].join("\n")}` : "";
        const version = doc.metadata.version;
        // The report credits the stories to the model label set when they were published.
        const publishedModel = () => {
          const m = contexts.get(context)?.settings.model;
          return typeof m === "string" && m.trim() ? m.trim() : undefined;
        };
        const markPublished = () =>
          updateArtifactMeta(contexts, context, doc, (m) => ({
            // Saved again while this ran: the new version is still unpublished.
            status: m.version === version ? "published" : "changed",
            jira: { ...mapping, publishedVersion: version, ...(publishedModel() && { model: publishedModel() }) },
          }));

        // A story as sent, masked, for the Jira diff to compare with.
        const sentStories = kit.feedback ? new Map(allStories(backlog).map(({ story }) => [story.id, story])) : undefined;
        const keepSent = (planned: PlannedItem[]) => {
          const stories = planned.flatMap((item) => {
            const story = item.level === "story" ? sentStories?.get(item.id) : undefined;
            const key = mapping.items[item.id]?.key;
            if (!story || !key) return [];
            const points = args.storyPointsField ? item.fields[args.storyPointsField] : undefined;
            return [
              {
                context,
                artifact: doc.id,
                item: item.id,
                artifactVersion: version,
                issueKey: key,
                summary: item.fields.summary,
                text: adfToText(item.fields.description),
                criteria: story.acceptanceCriteria.length,
                ...(typeof points === "number" && args.storyPointsField && { points, pointsField: args.storyPointsField }),
              },
            ];
          });
          kit.feedback?.saveSent(stories);
        };
        // Stories left unchanged are as they were sent (their hash matches): kept too, when they were not before.
        const keepUnchanged = () => {
          const keptBefore = kit.feedback?.sent(context, doc.id);
          keepSent(items.filter((i) => i.action === "unchanged" && !keptBefore?.has(i.id)));
        };
        const count = (a: PlannedItem["action"]) => items.filter((i) => i.action === a).length;
        const skipped = count("skip");
        const skippedItems = items.filter((i) => i.action === "skip" && i.level !== "subtask").length;
        const skippedTasks = skipped - skippedItems;
        const skippedNote =
          skippedItems || skippedTasks
            ? `\n\nSkipped ${[skippedItems ? `${skippedItems} won't-have item(s)` : "", skippedTasks ? `${skippedTasks} sub-task(s) of stories not published` : ""].filter(Boolean).join(" and ")}; they stay in the backlog only.`
            : "";
        if (!count("create") && !count("update") && !links.length) {
          // Nothing of it was ever in Jira (all won't have): nothing is recorded either.
          if (Object.keys(mapping.items).length) {
            keepUnchanged();
            markPublished();
          }
          return text(`Nothing to publish: Jira project ${args.projectKey} is already up to date.${skippedNote}${noteText}`);
        }

        // The real values, for the page and the write. Secrets and unknown pseudonyms stay masked.
        const kept = new Set<string>();
        const revealed = new Map<string, { type: string; value: string }>();
        const reveal = (t: string) => {
          const out = masker.unmask(context, t);
          out.kept.forEach((k) => kept.add(k));
          out.revealed.forEach((r) => revealed.set(`${r.type}\0${r.value}`, r));
          return out.text;
        };
        const label = (l: string) => reveal(l).replace(/\s+/g, "_");
        const written = new Map(
          items.map((i) => [
            i.id,
            {
              fields: { ...i.fields, summary: oneLine(reveal(i.fields.summary)), description: mapAdfText(i.fields.description, reveal) } as PlannedItem["fields"],
              labels: [...new Set(i.labels.map(label))],
            },
          ]),
        );
        const title = reveal(backlog.title);

        // The page: every issue as it will be written, and what Jira holds now.
        const issueType = (i: PlannedItem) => (i.level === "epic" ? args.epicIssueType : i.level === "subtask" ? subtaskType! : args.storyIssueType);
        const describe = (i: PlannedItem) => {
          const w = written.get(i.id)!;
          if (i.action === "skip") return `skipped, ${i.skipReason}${i.key ? `; ${i.key} is left as it is in Jira` : ""}`;
          if (i.action === "create") return `create ${issueType(i)}${i.recreate ? ` (its earlier issue ${mapping.items[i.id]!.key} was deleted)` : ""}`;
          if (i.action === "unchanged") return `unchanged ${i.key}`;
          const notes = [
            i.current && i.current.summary !== w.fields.summary ? `its summary is now "${i.current.summary}"` : undefined,
            i.move ? `moves from ${i.move.from ? `epic ${i.move.from}` : "no epic"} to ${i.move.to ?? `the new epic ${i.epicId}`}` : undefined,
            i.editedInJira
              ? i.level === "subtask"
                ? "changed in Jira since the last publish (status, comments and work logs stay; an edited summary or description is replaced)"
                : "WARNING: edited in Jira since the last publish; those edits will be replaced"
              : undefined,
            i.level === "subtask" && i.current?.parentKey && i.current.parentKey !== mapping.items[i.parentId!]?.key ? `Jira shows it under ${i.current.parentKey}, where it stays` : undefined,
          ].filter(Boolean);
          return `update ${i.key}${notes.length ? `; ${notes.join("; ")}` : ""}`;
        };
        const indent = (s: string, by: string) => s.replace(/^/gm, by);
        const lines = items.flatMap((i) => {
          const w = written.get(i.id)!;
          const pad = i.level === "story" ? "    " : i.level === "subtask" ? "        " : "";
          // A sub-task's id repeats its summary: the summary is enough.
          const head = `${pad}${i.level === "subtask" ? "" : `${i.id} · `}${w.fields.summary}: ${describe(i)}`;
          if (i.action === "skip" || i.action === "unchanged") return [head];
          const points = args.storyPointsField && w.fields[args.storyPointsField] !== undefined ? [`Story points (${args.storyPointsField}): ${String(w.fields[args.storyPointsField])}`] : [];
          const labels = i.action === "update" ? mergeLabels(i.current?.labels ?? [], mapping.items[i.id]?.labels?.map(label), w.labels) : w.labels;
          const body = [`Labels: ${labels.join(", ")}`, ...points, "", adfToText(w.fields.description).trim()].join("\n");
          return [head, indent(body, `${pad}  | `), ""];
        });
        // Fields the project requires on create: given now, or kept from an earlier publish.
        // A level given replaces that level of what is kept; {} given forgets them all.
        const given = args.fields;
        const forgetAll = !!given && !Object.keys(given).length;
        const extra: LevelFields = forgetAll ? {} : { ...savedFields(contexts, context, args.projectKey), ...given };
        const extraFor = (i: PlannedItem, summary: string) => {
          const set = extra[i.level];
          return set ? (fieldValue(set, reveal, summary) as Record<string, unknown>) : {};
        };
        const levelName = { epic: args.epicIssueType, story: args.storyIssueType, subtask: subtaskType ?? "Sub-task" } as const;
        const extraLines = (["epic", "story", "subtask"] as const).flatMap((level) => {
          const set = extra[level];
          if (!set || !Object.keys(set).length) return [];
          const shown = fieldValue(set, reveal, "<the issue's summary>") as Record<string, unknown>;
          return [`Set when ${levelName[level]} issues are created: ${Object.entries(shown).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")}`];
        });
        const req: PublishRequest = {
          kind: "publish",
          target:
            `Jira project ${project.key} (${project.name}): ${count("create")} to create, ${count("update")} to update, ${count("unchanged")} unchanged, ` +
            `${skipped} skipped, ${links.length} dependency link(s) to add` +
            (count("update") ? ". Updating replaces the summary and description of those issues, and story points when set; labels added in Jira, status, assignee and comments are kept" : ""),
          title,
          body: [
            ...(extraLines.length ? [...extraLines, ""] : []),
            ...(design && subtaskType ? [`Sub-tasks (${subtaskType}) come from the detailed design "${reveal(design.title)}" and are listed under their story.`, ""] : []),
            ...lines,
            ...(links.length ? ["Dependency links (the first blocks the second):", ...links.map((l) => `- ${l.blocker} blocks ${l.blocked}`), ""] : []),
            ...(unmatched.length ? [`Its deployment list also cites stories that are not in this backlog, so they get no sub-task: ${unmatched.map(reveal).join(", ")}`] : []),
            ...notes.map(reveal),
            ...(orphans.length ? [`No longer in this backlog, left as they are in Jira: ${orphans.join(", ")}`] : []),
            ...(unplanned.length ? [`Sub-tasks not planned in this publish, left as they are in Jira: ${unplanned.map(reveal).join(", ")}`] : []),
          ]
            .join("\n")
            .trimEnd(),
          kept: [...kept],
        };
        const decision = await kit.reviewerFor(call).review(req);
        if (decision.digest !== requestDigest(req)) throw new Error("The decision does not match what was shown for approval, so nothing was written.");
        // What the page showed from Jira is in clear too, and the comment may quote it.
        const fromJira = [project.name, ...items.flatMap((i) => (i.current ? [i.current.summary, ...i.current.labels] : []))];
        const comment = () => decisionComment(masker, context, decision.comment, [...revealed.values(), ...fromJira.map((value) => ({ type: "PRIVATE", value }))]);
        if (decision.status !== "approved") {
          const why = decision.status === "expired" ? "did not approve it in time, or closed the page" : "rejected it";
          return text(`Nothing was written: the user ${why}.${await comment()}`);
        }

        // Kept for the project, masked: a level once an issue was created with it or the run went through, so values Jira refused are not kept; forgetting once approved.
        const keepLevels = (levels: Partial<Record<keyof LevelFields, Record<string, unknown> | undefined>>, all = false) =>
          contexts.updateSettings(context, (current) => {
            const projects = { ...((current.jiraFields as Record<string, LevelFields> | undefined) ?? {}) };
            const kept: LevelFields = all ? {} : { ...projects[args.projectKey] };
            for (const [level, value] of Object.entries(levels) as [keyof LevelFields, Record<string, unknown> | undefined][]) {
              if (value && Object.keys(value).length) kept[level] = value;
              else delete kept[level];
            }
            if (Object.keys(kept).length) projects[args.projectKey] = kept;
            else delete projects[args.projectKey];
            return { ...current, jiraFields: projects };
          });
        if (forgetAll) keepLevels({}, true);
        const forgotten = Object.fromEntries(Object.entries(given ?? {}).filter(([, v]) => v && !Object.keys(v).length));
        if (Object.keys(forgotten).length) keepLevels(forgotten);
        const toKeep = new Set((Object.keys(given ?? {}) as (keyof LevelFields)[]).filter((level) => Object.keys(given![level] ?? {}).length));
        const keepAfterCreate = async (level: keyof LevelFields) => {
          if (!toKeep.delete(level)) return;
          // Not kept if masking fails: kept unmasked never, and the publish goes on.
          const masked = await maskLeaves(given![level], async (t) => (await masker.maskOutput(context, t)).text).catch(() => undefined);
          if (masked) keepLevels({ [level]: masked as Record<string, unknown> });
        };
        const done: string[] = [];
        const save = () => updateArtifactMeta(contexts, context, doc, () => ({ jira: { ...mapping } }));
        // Best effort: the timestamp only feeds the "edited in Jira" warning, so failing to read it must not fail the publish.
        const refreshUpdated = async (id: string) => {
          const entry = mapping.items[id]!;
          const updated = await client.getIssueState(entry.key).then(
            (state) => state.updated,
            () => undefined,
          );
          if (updated) {
            entry.updated = updated;
            save();
          }
        };
        // The mapping is saved right after every write, so a failure part-way never leads to duplicates on the next run.
        const record = async (item: PlannedItem, key: string, url: string) => {
          mapping.items[item.id] = { key, url, hash: item.hash, labels: item.labels };
          keepSent([item]);
          save();
          await refreshUpdated(item.id);
        };
        const step = async <T>(what: string, run: () => Promise<T>) => {
          try {
            return await run();
          } catch (err) {
            // What Jira said is wrong (a required field, an unknown value): guard masks the whole message, as it may quote a value.
            const said = err instanceof AtlassianError && err.detail?.length ? ` Jira says: ${err.detail.join("; ")}` : "";
            const hint = /is required|required field|not valid|invalid/i.test(said) ? " Check the project's fields with jira_fields, then publish again with fields." : "";
            const why = err instanceof AtlassianError ? `Jira refused to ${what} (HTTP ${err.status}).${said}${hint}` : (err as Error).message;
            throw new PartialPublishError(
              why,
              `\nCompleted before the failure:\n${done.map((d) => `- ${d}`).join("\n") || "- nothing"}\n\n` +
                "Progress is saved. Fix the cause, then publish again: issues already created will be updated, not duplicated.",
            );
          }
        };

        for (const item of items) {
          if (item.action === "unchanged" || item.action === "skip") continue;
          const w = written.get(item.id)!;
          const parentKey = item.level === "subtask" ? mapping.items[item.parentId!]?.key : item.epicId ? mapping.items[item.epicId]?.key : undefined;
          // A sub-task is created under its story and stays there.
          const parent = parentKey && (item.action === "create" || item.move) ? { parent: { key: parentKey } } : {};
          if (item.action === "create") {
            const result = await step(`create ${item.id}`, () =>
              client.createIssue({ ...extraFor(item, w.fields.summary), project: { key: args.projectKey }, issuetype: { name: issueType(item) }, ...w.fields, labels: w.labels, ...parent }),
            );
            await record(item, result.key, result.url);
            await keepAfterCreate(item.level);
            done.push(`Created ${result.key} ${item.summary}`);
          } else {
            const labels = mergeLabels(item.current?.labels ?? [], mapping.items[item.id]?.labels?.map(label), w.labels);
            const result = await step(`update ${item.key}`, () => client.updateIssue(item.key!, { ...w.fields, labels, ...parent }));
            await record(item, result.key, result.url);
            done.push(`Updated ${result.key} ${item.summary}${item.move ? `, now under epic ${parentKey}` : ""}`);
          }
        }
        for (const link of links) {
          const blocker = mapping.items[link.blocker]!.key;
          const blocked = mapping.items[link.blocked]!.key;
          await step(`link ${blocker} to ${blocked}`, () => client.linkBlocks(blocker, blocked));
          mapping.links.push(`${blocker}>${blocked}`);
          save();
          done.push(`Linked ${blocker} blocks ${blocked}`);
          // A new link changes both issues' timestamps; refreshed, so the next publish does not report it as an edit made in Jira.
          await refreshUpdated(link.blocker);
          await refreshUpdated(link.blocked);
        }

        keepUnchanged();
        markPublished();
        // A run that went through keeps the levels no create tried: the user approved them, and Jira refused none.
        for (const level of [...toKeep]) await keepAfterCreate(level);
        return text(`Published to Jira project ${args.projectKey}:\n${done.map((d) => `- ${d}`).join("\n")}${skippedNote}${noteText}${await comment()}`);
      }),
    ),
  );
}
