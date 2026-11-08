// Backlogs: the Product Owner agent's epics and stories, how they read as Markdown and in Jira
// (Atlassian Document Format), the quality check, and how a backlog the agent wrote is masked
// before it is saved. Every function here works on the masked backlog; the real values are put
// back only for the write to Jira (jira.ts).

import type { ContextRepository, Masker, Requirement, SourceDocument } from "@sf-agent-po/core";
import { z } from "zod";
import { hash, saveArtifact, type Artifact } from "./artifacts.js";
import { checkRules, languageFinding, type OutputLanguage } from "./checks.js";

const localId = z
  .string()
  .regex(/^[A-Za-z][\w-]{0,31}$/, "use a short id such as E1 or S1-2")
  .describe("Stable id within this backlog, e.g. E1 for an epic, S1 for a story. Keep it unchanged across versions.");

const jiraKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]+-\d+$/, "must be a Jira issue key such as PORT-12")
  .optional()
  .describe("Existing Jira issue this item revises. Leave empty for new items.");

/** Context document ids, as the context tools give them: nothing else (a name, a note) fits. */
const sourceIds = z.array(z.string().regex(/^doc-[0-9a-f]{10}$/, "use a context document id such as doc-1a2b3c4d5e")).optional();

/** The confirmed requirements an item delivers, by their ids (R1, R2...): the traceability links. */
const requirementIds = z
  .array(z.string().regex(/^R[1-9]\d{0,5}$/, "use requirement ids such as R1"))
  .max(40)
  .optional();

const labels = z.array(z.string().regex(/^\S+$/, "Jira labels cannot contain spaces")).optional();

export const PRIORITIES = ["must", "should", "could", "wont"] as const;

export const acceptanceCriterionSchema = z.object({
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1),
});

export const storySchema = z.object({
  id: localId,
  type: z.enum(["story", "spike"]).default("story").describe("A spike is a time-boxed investigation that answers an open question."),
  summary: z.string().min(5).max(255),
  persona: z.string().min(2).describe('Who benefits, e.g. "Renewals agent" or "Policyholder".'),
  want: z.string().min(3).describe('The "I want" part of the story.'),
  benefit: z.string().min(3).describe('The "so that" part of the story.'),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
  nonFunctional: z.array(z.string()).optional().describe("Security, performance, compliance or other constraints on this story."),
  technicalNotes: z.string().optional().describe("Pointers to the design, e.g. the components involved. Not a full design."),
  priority: z.enum(PRIORITIES).optional().describe("MoSCoW priority."),
  storyPoints: z.number().int().positive().optional(),
  labels,
  dependsOn: z.array(localId).optional().describe("Ids of stories that must be done first."),
  requirementIds: requirementIds.describe("Ids of the confirmed requirements this story delivers, such as R1."),
  sourceIds: sourceIds.describe("Context document ids this story comes from."),
  jiraKey,
});

export const epicSchema = z.object({
  id: localId,
  summary: z.string().min(5).max(255),
  outcome: z.string().min(10).describe("The business outcome the epic delivers."),
  successMetrics: z.array(z.string()).optional(),
  scopeNotes: z.string().optional().describe("What is in and out of scope."),
  priority: z.enum(PRIORITIES).optional(),
  labels,
  requirementIds: requirementIds.describe("Ids of the confirmed requirements the epic's stories deliver, such as R1."),
  sourceIds,
  jiraKey,
  stories: z.array(storySchema),
});

export const backlogSchema = z.object({
  title: z.string().min(3),
  summary: z.string().optional().describe("A short overview for stakeholders."),
  epics: z.array(epicSchema).min(1),
  assumptions: z.array(z.string()).optional(),
  openQuestions: z
    .array(z.object({ question: z.string().min(3), owner: z.string().optional(), sourceIds }))
    .optional(),
  gaps: z
    .array(z.object({ requirementId: z.string().regex(/^R[1-9]\d{0,5}$/, "use a requirement id such as R1"), reason: z.string().min(3) }))
    .optional()
    .describe("Confirmed requirements no story delivers, each with the reason: out of scope, or waiting on an open question."),
});

export type Backlog = z.infer<typeof backlogSchema>;
export type Epic = z.infer<typeof epicSchema>;
export type Story = z.infer<typeof storySchema>;

export function allStories(backlog: Backlog): { epic: Epic; story: Story }[] {
  return backlog.epics.flatMap((epic) => epic.stories.map((story) => ({ epic, story })));
}

export function userStoryText(s: Story): string {
  return `As a ${s.persona}, I want ${s.want}, so that ${s.benefit}.`;
}

/**
 * Calls `f` on every free-text field of a backlog, in a fixed order, and returns the backlog
 * with what it returned. Ids, Jira keys, source ids and dependencies are structure, not text.
 */
export function mapBacklogText(backlog: Backlog, f: (text: string) => string): Backlog {
  const opt = (t: string | undefined) => (t === undefined ? undefined : f(t));
  const list = (l: string[] | undefined) => l?.map(f);
  return {
    ...backlog,
    title: f(backlog.title),
    summary: opt(backlog.summary),
    epics: backlog.epics.map((e) => ({
      ...e,
      summary: f(e.summary),
      outcome: f(e.outcome),
      successMetrics: list(e.successMetrics),
      scopeNotes: opt(e.scopeNotes),
      labels: list(e.labels),
      stories: e.stories.map((s) => ({
        ...s,
        summary: f(s.summary),
        persona: f(s.persona),
        want: f(s.want),
        benefit: f(s.benefit),
        acceptanceCriteria: s.acceptanceCriteria.map((ac) => ({ given: f(ac.given), when: f(ac.when), then: f(ac.then) })),
        nonFunctional: list(s.nonFunctional),
        technicalNotes: opt(s.technicalNotes),
        labels: list(s.labels),
      })),
    })),
    assumptions: list(backlog.assumptions),
    openQuestions: backlog.openQuestions?.map((q) => ({ ...q, question: f(q.question), owner: opt(q.owner) })),
    gaps: backlog.gaps?.map((g) => ({ ...g, reason: f(g.reason) })),
  };
}

/**
 * Masks what the agent wrote in clear in every text field (Masker.maskOutputs, with one run of
 * the detection for all fields but the title), keeping its pseudonyms.
 */
export async function maskBacklog(masker: Masker, context: string, backlog: Backlog): Promise<{ backlog: Backlog; hidden: number }> {
  // The title is masked alone: it names the artifact, so it must not depend on the other fields.
  const title = await masker.maskOutput(context, backlog.title);
  const rest = await maskBacklogFields(masker, context, backlog);
  const hidden = rest.hidden + Object.values(title.report.counts).reduce((a, b) => a + b, 0);
  return { backlog: { ...rest.backlog, title: title.text }, hidden };
}

/** Masks every text field but the title, in one run of the detection. */
export async function maskBacklogFields(masker: Masker, context: string, backlog: Backlog): Promise<{ backlog: Backlog; hidden: number }> {
  const texts: string[] = [];
  mapBacklogText(backlog, (t) => (texts.push(t), t));
  const unique = [...new Set(texts.slice(1))];
  if (!unique.length) return { backlog, hidden: 0 };
  const out = await masker.maskOutputs(context, unique);
  const byText = new Map(unique.map((t, i) => [t, out.texts[i]!]));
  const hidden = Object.values(out.report.counts).reduce((a, b) => a + b, 0);
  let first = true;
  return { backlog: mapBacklogText(backlog, (t) => (first ? ((first = false), t) : byText.get(t)!)), hidden };
}

/** Saves a masked backlog as a versioned artifact: a new version when its content changed. */
export function saveBacklog(contexts: ContextRepository, context: string, backlog: Backlog): Artifact {
  const sourceIds = [...new Set(backlog.epics.flatMap((e) => [...(e.sourceIds ?? []), ...e.stories.flatMap((s) => s.sourceIds ?? [])]))];
  return saveArtifact(contexts, context, {
    kind: "backlog",
    title: backlog.title,
    content: backlogToMarkdown(backlog),
    sourceIds,
    extra: { backlog },
    fingerprint: hash(JSON.stringify(backlog)),
  });
}

const PRIORITY_LABEL: Record<(typeof PRIORITIES)[number], string> = { must: "Must have", should: "Should have", could: "Could have", wont: "Won't have (this time)" };

/** Renders the backlog as Markdown: what the Solution Architect agent reads. */
export function backlogToMarkdown(backlog: Backlog): string {
  const out: string[] = [`# ${backlog.title}`, ""];
  if (backlog.summary) out.push(backlog.summary, "");
  for (const epic of backlog.epics) {
    out.push(`## ${epic.id}: ${epic.summary}`, "", `**Outcome:** ${epic.outcome}`, "");
    if (epic.priority) out.push(`**Priority:** ${PRIORITY_LABEL[epic.priority]}`, "");
    if (epic.successMetrics?.length) out.push("**Success metrics:**", ...epic.successMetrics.map((m) => `- ${m}`), "");
    if (epic.scopeNotes) out.push(`**Scope:** ${epic.scopeNotes}`, "");
    if (epic.requirementIds?.length) out.push(`Requirements: ${epic.requirementIds.join(", ")}`, "");
    if (epic.sourceIds?.length) out.push(`Sources: ${epic.sourceIds.join(", ")}`, "");
    for (const s of epic.stories) {
      out.push(`### ${s.id}: ${s.summary}${s.type === "spike" ? " (spike)" : ""}`, "", userStoryText(s), "");
      const facts = [
        s.priority ? `Priority: ${PRIORITY_LABEL[s.priority]}` : undefined,
        s.storyPoints ? `Story points: ${s.storyPoints}` : undefined,
        s.dependsOn?.length ? `Depends on: ${s.dependsOn.join(", ")}` : undefined,
        s.requirementIds?.length ? `Requirements: ${s.requirementIds.join(", ")}` : undefined,
        s.sourceIds?.length ? `Sources: ${s.sourceIds.join(", ")}` : undefined,
      ].filter(Boolean);
      if (facts.length) out.push(facts.join(" · "), "");
      out.push("**Acceptance criteria**", "");
      s.acceptanceCriteria.forEach((ac, i) => out.push(`${i + 1}. **Given** ${ac.given} **when** ${ac.when} **then** ${ac.then}`));
      out.push("");
      if (s.nonFunctional?.length) out.push("**Non-functional**", ...s.nonFunctional.map((n) => `- ${n}`), "");
      if (s.technicalNotes) out.push(`**Technical notes:** ${s.technicalNotes}`, "");
    }
  }
  if (backlog.assumptions?.length) out.push("## Assumptions", ...backlog.assumptions.map((a) => `- ${a}`), "");
  if (backlog.openQuestions?.length) {
    out.push("## Open questions", ...backlog.openQuestions.map((q) => `- ${q.question}${q.owner ? ` (owner: ${q.owner})` : ""}`), "");
  }
  if (backlog.gaps?.length) out.push("## Requirements not delivered", ...backlog.gaps.map((g) => `- ${g.requirementId}: ${g.reason}`), "");
  return out.join("\n").trimEnd() + "\n";
}

export interface Finding {
  level: "error" | "warning" | "info";
  where: string;
  message: string;
}

const SCALE = new Set([1, 2, 3, 5, 8, 13]);

/** How a draft's dependency on a story not written yet reads. */
export const NOT_WRITTEN = "which is not a story written so far";

export interface BacklogCheckOptions {
  /** The context's confirmed requirements: an item may cite only these. Left out, requirement ids are not checked. */
  requirements?: readonly Requirement[];
  /**
   * A backlog still being written, in a workflow run: what only the whole backlog shows (an epic
   * with no stories yet, inputs no item cites) is not checked, and a dependency on a story not
   * written yet is a warning.
   */
  draft?: boolean;
}

/** Whether a story is won't have, by its own priority or its epic's: it is not published to Jira. */
const isWont = (epic: Epic, story: Story) => story.priority === "wont" || epic.priority === "wont";

/**
 * Deterministic quality checks on a backlog: structure, INVEST signals, testable acceptance
 * criteria, and traceability back to the inputs, especially security and compliance ones.
 * `contextDocs` are the context's masked documents: what the findings quote is masked.
 * `language` is the context's output language: the word lists are that language's
 * (content/checks), and a backlog written in another one is flagged.
 */
export function checkBacklog(backlog: Backlog, contextDocs: SourceDocument[], language: OutputLanguage = "en", options: BacklogCheckOptions = {}): Finding[] {
  const rules = checkRules(language);
  const findings: Finding[] = [];
  const add = (level: Finding["level"], where: string, message: string) => findings.push({ level, where, message });

  const ids = new Map<string, number>();
  for (const e of backlog.epics) {
    ids.set(e.id, (ids.get(e.id) ?? 0) + 1);
    for (const s of e.stories) ids.set(s.id, (ids.get(s.id) ?? 0) + 1);
  }
  for (const [id, n] of ids) if (n > 1) add("error", id, `Id ${id} is used ${n} times; ids must be unique across epics and stories.`);
  const jiraKeys = new Map<string, string>();
  for (const item of [...backlog.epics, ...allStories(backlog).map(({ story }) => story)]) {
    if (!item.jiraKey) continue;
    const other = jiraKeys.get(item.jiraKey);
    if (other) add("error", item.id, `Jira issue ${item.jiraKey} is also set on ${other}; each item must revise a different issue.`);
    jiraKeys.set(item.jiraKey, item.id);
  }

  const storyIds = new Set(allStories(backlog).map(({ story }) => story.id));
  const wontIds = new Set(allStories(backlog).filter(({ epic, story }) => isWont(epic, story)).map(({ story }) => story.id));
  const docIds = new Set(contextDocs.map((d) => d.id));
  const referenced = new Set<string>();
  const checkSources = (where: string, sourceIds: string[] | undefined) => {
    for (const id of sourceIds ?? []) {
      referenced.add(id);
      if (!docIds.has(id)) add("warning", where, `Source ${id} is not a document in this context.`);
    }
  };
  const requirements = options.requirements && new Map(options.requirements.map((r) => [r.id, r]));
  const checkRequirements = (where: string, ids: string[] | undefined) => {
    if (!requirements) return;
    const unique = [...new Set(ids ?? [])];
    // A requirement's own sources are cited through it.
    for (const id of unique) for (const doc of requirements.get(id)?.sourceIds ?? []) referenced.add(doc);
    const unknown = unique.filter((id) => !requirements.has(id));
    if (unknown.length) add("error", where, `${unknown.join(", ")} ${unknown.length === 1 ? "is not a confirmed requirement" : "are not confirmed requirements"}: cite only the confirmed ids.`);
  };

  for (const epic of backlog.epics) {
    if (!epic.stories.length && !options.draft) add("error", epic.id, "Epic has no stories.");
    checkSources(epic.id, epic.sourceIds);
    checkRequirements(epic.id, epic.requirementIds);
    for (const s of epic.stories) {
      const where = s.id;
      checkSources(where, s.sourceIds);
      checkRequirements(where, s.requirementIds);
      if (!s.sourceIds?.length && !epic.sourceIds?.length && !s.requirementIds?.length) {
        add("warning", where, "No source documents and no requirement: the story cannot be traced to what was asked.");
      }
      if (rules.genericPersona(s.persona)) add("warning", where, `Persona "${s.persona}" is generic; name the role, e.g. "Renewals agent".`);
      if (s.storyPoints !== undefined && !SCALE.has(s.storyPoints)) add("warning", where, `Story points ${s.storyPoints} is not on the 1, 2, 3, 5, 8, 13 scale.`);
      if (s.storyPoints !== undefined && s.storyPoints > 8) add("warning", where, `At ${s.storyPoints} points the story is likely too big for a sprint; consider splitting it.`);
      if (s.acceptanceCriteria.length > 8) add("warning", where, `${s.acceptanceCriteria.length} acceptance criteria suggest the story should be split.`);
      s.acceptanceCriteria.forEach((ac, i) => {
        const vague = `${ac.given} ${ac.when} ${ac.then}`.match(rules.vague);
        if (vague) add("warning", `${where} AC${i + 1}`, `"${vague[0]}" is not testable; state a measurable outcome.`);
      });
      for (const dep of s.dependsOn ?? []) {
        if (dep === s.id) add("error", where, "A story cannot depend on itself.");
        else if (!storyIds.has(dep))
          options.draft
            ? add("warning", where, `Depends on ${dep}, ${NOT_WRITTEN}: it must be by the time the last epic is written.`)
            : add("error", where, `Depends on ${dep}, which is not a story in this backlog.`);
        else if (s.priority !== "wont" && epic.priority !== "wont" && wontIds.has(dep)) add("warning", where, `Depends on ${dep}, which is won't have and is not published to Jira.`);
      }
      if (epic.priority === "wont" && s.priority && s.priority !== "wont") {
        add("warning", where, `Priority is ${s.priority} but epic ${epic.id} is won't have, so the story is not published to Jira.`);
      }
      if (s.type === "spike" && s.storyPoints && s.storyPoints > 5) add("info", where, "Spikes are usually time-boxed to a few days.");
    }
  }
  checkSources("open questions", backlog.openQuestions?.flatMap((q) => q.sourceIds ?? []));
  for (const cycle of dependencyCycles(backlog)) {
    add("error", cycle[0]!, `Circular dependency: ${cycle.join(" depends on ")}. None of these stories can start first.`);
  }

  for (const doc of options.draft ? [] : contextDocs) {
    const isInput = !(doc.metadata as { artifact?: boolean } | undefined)?.artifact && !["metadata", "org"].includes(doc.kind);
    if (!isInput || referenced.has(doc.id)) continue;
    if (rules.sensitive.test(`${doc.title}\n${doc.content}`)) {
      add("warning", doc.id, `"${doc.title}" mentions security or compliance requirements but no epic or story cites it.`);
    } else {
      add("info", doc.id, `"${doc.title}" is not cited by any epic or story.`);
    }
  }

  const written = allStories(backlog).flatMap(({ story: s }) => [s.summary, s.want, s.benefit, ...s.acceptanceCriteria.flatMap((ac) => [ac.given, ac.when, ac.then])]);
  const wrongLanguage = languageFinding([backlog.title, ...backlog.epics.flatMap((e) => [e.summary, e.outcome]), ...written], language, "backlog");
  if (wrongLanguage) findings.push(wrongLanguage);

  if (!options.draft && backlog.openQuestions?.length && !allStories(backlog).some(({ story }) => story.type === "spike")) {
    add("info", "open questions", "There are open questions but no spikes; consider a spike for any question that blocks estimation.");
  }
  return findings;
}

/**
 * The confirmed requirements no story delivers. A won't-have requirement needs no story, and a
 * won't-have story delivers nothing: it is not published.
 */
export function uncoveredRequirements(backlog: Backlog, requirements: readonly Requirement[]): Requirement[] {
  const covered = new Set(allStories(backlog).flatMap(({ epic, story }) => (isWont(epic, story) ? [] : (story.requirementIds ?? []))));
  return requirements.filter((r) => r.status === "confirmed" && r.priority !== "wont" && !covered.has(r.id));
}

/**
 * What the backlog leaves undelivered: a Must requirement as `must` says (an error in a workflow
 * run, a warning on a backlog saved by hand), a Should or Could one as a warning. `gaps` are the
 * requirements the user knows are left out, with the reason: they are not reported.
 */
export function coverageFindings(backlog: Backlog, requirements: readonly Requirement[], must: "error" | "warning", gaps: ReadonlySet<string> = new Set()): Finding[] {
  return uncoveredRequirements(backlog, requirements)
    .filter((r) => !gaps.has(r.id))
    .map((r) =>
      r.priority === "must"
        ? { level: must, where: r.id, message: `Must requirement ${r.id} is delivered by no story: cite it in the stories that deliver it${must === "error" ? ", or give the reason it is left out" : ""}.` }
        : { level: "warning", where: r.id, message: `${r.priority === "should" ? "Should" : "Could"} requirement ${r.id} is delivered by no story.` },
    );
}

/** Each dependency cycle between stories, as the ids along it with the first repeated at the end. */
function dependencyCycles(backlog: Backlog): string[][] {
  // Self-dependencies are reported on their own, so they are left out here.
  const edges = new Map(allStories(backlog).map(({ story }) => [story.id, (story.dependsOn ?? []).filter((d) => d !== story.id)]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (id: string) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      cycles.push([...stack.slice(stack.indexOf(id)), id]);
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of edges.get(id) ?? []) if (edges.has(dep)) visit(dep);
    stack.pop();
    state.set(id, "done");
  };
  for (const id of edges.keys()) visit(id);
  return cycles;
}

export function findingsToText(findings: Finding[]): string {
  if (!findings.length) return "Quality check: no issues found.";
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...findings].sort((a, b) => order[a.level] - order[b.level]);
  const counts = (["error", "warning", "info"] as const).map((l) => `${findings.filter((f) => f.level === l).length} ${l}(s)`).join(", ");
  return [`Quality check: ${counts}.`, ...sorted.map((f) => `- ${f.level.toUpperCase()} [${f.where}] ${f.message}`)].join("\n");
}

// Atlassian Document Format, the rich text of Jira Cloud descriptions. Built from the masked
// backlog; the real values go into its text nodes (unmaskAdf), which need no escaping.

export type AdfNode = { type: string; text?: string; content?: AdfNode[]; attrs?: Record<string, unknown>; marks?: { type: string }[]; version?: number };

const txt = (text: string, bold = false): AdfNode => (bold ? { type: "text", text, marks: [{ type: "strong" }] } : { type: "text", text });
const para = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content: content.filter((c) => c.text !== "") });
const heading = (text: string, level = 3): AdfNode => ({ type: "heading", attrs: { level }, content: [txt(text)] });
const bullets = (items: string[]): AdfNode => ({ type: "bulletList", content: items.map((i) => ({ type: "listItem", content: [para(txt(i))] })) });
const adf = (content: AdfNode[]): AdfNode => ({ type: "doc", version: 1, content });

export function storyDescription(story: Story, backlog: Backlog, sourceTitles: Map<string, string>): AdfNode {
  const content: AdfNode[] = [para(txt(userStoryText(story)))];
  content.push(heading("Acceptance criteria"));
  content.push({
    type: "orderedList",
    content: story.acceptanceCriteria.map((ac) => ({
      type: "listItem",
      content: [para(txt("Given ", true), txt(ac.given), txt(" when ", true), txt(ac.when), txt(" then ", true), txt(ac.then))],
    })),
  });
  if (story.nonFunctional?.length) content.push(heading("Non-functional requirements"), bullets(story.nonFunctional));
  if (story.technicalNotes) content.push(heading("Technical notes"), para(txt(story.technicalNotes)));
  const facts = [
    story.storyPoints ? `Story points: ${story.storyPoints}` : "",
    story.priority ? `Priority: ${story.priority}` : "",
    story.requirementIds?.length ? `Requirements: ${story.requirementIds.join(", ")}` : "",
  ].filter(Boolean);
  if (facts.length) content.push(para(txt(facts.join(" · "))));
  content.push(...footer(backlog, story.sourceIds, sourceTitles));
  return adf(content);
}

export function epicDescription(epic: Epic, backlog: Backlog, sourceTitles: Map<string, string>): AdfNode {
  const content: AdfNode[] = [heading("Outcome"), para(txt(epic.outcome))];
  if (epic.successMetrics?.length) content.push(heading("Success metrics"), bullets(epic.successMetrics));
  if (epic.scopeNotes) content.push(heading("Scope"), para(txt(epic.scopeNotes)));
  content.push(...footer(backlog, epic.sourceIds, sourceTitles));
  return adf(content);
}

function footer(backlog: Backlog, sourceIds: string[] | undefined, sourceTitles: Map<string, string>): AdfNode[] {
  const out: AdfNode[] = [];
  if (sourceIds?.length) {
    out.push(heading("Sources", 4), bullets(sourceIds.map((id) => (sourceTitles.has(id) ? `${sourceTitles.get(id)} (${id})` : id))));
  }
  out.push({ type: "rule" }, para(txt(`Generated by sf-agent-po from backlog "${backlog.title}".`)));
  return out;
}

/** A copy of an ADF document with `f` applied to every text node. */
export function mapAdfText(node: AdfNode, f: (text: string) => string): AdfNode {
  return {
    ...node,
    ...(node.text !== undefined && { text: f(node.text) }),
    ...(node.content && { content: node.content.map((c) => mapAdfText(c, f)) }),
  };
}
