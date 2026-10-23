import { z } from "zod";
import type { SourceDocument } from "../context/types.js";

const localId = z
  .string()
  .regex(/^[A-Za-z][\w-]{0,31}$/, "use a short id such as E1 or S1-2")
  .describe("Stable id within this backlog, e.g. E1 for an epic, S1 for a story. Keep it unchanged across versions.");

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
  labels: z.array(z.string().regex(/^\S+$/, "Jira labels cannot contain spaces")).optional(),
  dependsOn: z.array(z.string()).optional().describe("Ids of stories that must be done first."),
  sourceIds: z.array(z.string()).optional().describe("Context document ids this story comes from."),
  jiraKey: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]+-\d+$/, "must be a Jira issue key such as PORT-12")
    .optional()
    .describe("Existing Jira issue this item revises. Leave empty for new items."),
});

export const epicSchema = z.object({
  id: localId,
  summary: z.string().min(5).max(255),
  outcome: z.string().min(10).describe("The business outcome the epic delivers."),
  successMetrics: z.array(z.string()).optional(),
  scopeNotes: z.string().optional().describe("What is in and out of scope."),
  priority: z.enum(PRIORITIES).optional(),
  labels: z.array(z.string().regex(/^\S+$/, "Jira labels cannot contain spaces")).optional(),
  sourceIds: z.array(z.string()).optional(),
  jiraKey: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]+-\d+$/, "must be a Jira issue key such as PORT-12")
    .optional()
    .describe("Existing Jira issue this item revises. Leave empty for new items."),
  stories: z.array(storySchema),
});

export const backlogSchema = z.object({
  title: z.string().min(3),
  summary: z.string().optional().describe("A short overview for stakeholders."),
  epics: z.array(epicSchema).min(1),
  assumptions: z.array(z.string()).optional(),
  openQuestions: z
    .array(z.object({ question: z.string().min(3), owner: z.string().optional(), sourceIds: z.array(z.string()).optional() }))
    .optional(),
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

const PRIORITY_LABEL: Record<(typeof PRIORITIES)[number], string> = { must: "Must have", should: "Should have", could: "Could have", wont: "Won't have (this time)" };

/** Renders the backlog as Markdown: what the SA agent reads, and what goes to Confluence. */
export function backlogToMarkdown(backlog: Backlog): string {
  const out: string[] = [`# ${backlog.title}`, ""];
  if (backlog.summary) out.push(backlog.summary, "");
  for (const epic of backlog.epics) {
    out.push(`## ${epic.id}: ${epic.summary}`, "", `**Outcome:** ${epic.outcome}`, "");
    if (epic.priority) out.push(`**Priority:** ${PRIORITY_LABEL[epic.priority]}`, "");
    if (epic.successMetrics?.length) out.push("**Success metrics:**", ...epic.successMetrics.map((m) => `- ${m}`), "");
    if (epic.scopeNotes) out.push(`**Scope:** ${epic.scopeNotes}`, "");
    if (epic.sourceIds?.length) out.push(`Sources: ${epic.sourceIds.join(", ")}`, "");
    for (const s of epic.stories) {
      out.push(`### ${s.id}: ${s.summary}${s.type === "spike" ? " (spike)" : ""}`, "", userStoryText(s), "");
      const facts = [
        s.priority ? `Priority: ${PRIORITY_LABEL[s.priority]}` : undefined,
        s.storyPoints ? `Story points: ${s.storyPoints}` : undefined,
        s.dependsOn?.length ? `Depends on: ${s.dependsOn.join(", ")}` : undefined,
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
  return out.join("\n").trimEnd() + "\n";
}

export interface Finding {
  level: "error" | "warning" | "info";
  where: string;
  message: string;
}

const FIBONACCI = new Set([1, 2, 3, 5, 8, 13, 21]);
const VAGUE = /\b(fast|quick(ly)?|user[- ]friendly|easy|easily|intuitive|appropriate(ly)?|etc\.?|and so on|as needed|seamless(ly)?|robust)\b/i;
const GENERIC_PERSONA = /^(a |an |the )?(user|users|someone|customer|person)$/i;
const SENSITIVE = /\b(security|secure|encrypt\w*|gdpr|hipaa|pci|sox|mfa|sso|privacy|personal data|pii|compliance|audit\w*|retention|consent)\b/i;

/**
 * Deterministic quality checks the PO agent runs before showing a backlog to
 * the user: structure, INVEST signals, testable acceptance criteria, and
 * traceability back to the inputs, especially security and compliance ones.
 */
export function checkBacklog(backlog: Backlog, contextDocs: SourceDocument[]): Finding[] {
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
  const docIds = new Set(contextDocs.map((d) => d.id));
  const referenced = new Set<string>();
  const checkSources = (where: string, sourceIds: string[] | undefined) => {
    for (const id of sourceIds ?? []) {
      referenced.add(id);
      if (!docIds.has(id)) add("warning", where, `Source ${id} is not a document in this context.`);
    }
  };

  for (const epic of backlog.epics) {
    if (!epic.stories.length) add("error", epic.id, "Epic has no stories.");
    checkSources(epic.id, epic.sourceIds);
    for (const s of epic.stories) {
      const where = s.id;
      checkSources(where, s.sourceIds);
      if (!s.sourceIds?.length && !epic.sourceIds?.length) add("warning", where, "No source documents: the story cannot be traced to a requirement.");
      if (GENERIC_PERSONA.test(s.persona.trim())) add("warning", where, `Persona "${s.persona}" is generic; name the role, e.g. "Renewals agent".`);
      if (s.storyPoints !== undefined && !FIBONACCI.has(s.storyPoints)) add("warning", where, `Story points ${s.storyPoints} is not on the 1, 2, 3, 5, 8, 13, 21 scale.`);
      if (s.storyPoints !== undefined && s.storyPoints > 8) add("warning", where, `At ${s.storyPoints} points the story is likely too big for a sprint; consider splitting it.`);
      if (s.acceptanceCriteria.length > 8) add("warning", where, `${s.acceptanceCriteria.length} acceptance criteria suggest the story should be split.`);
      s.acceptanceCriteria.forEach((ac, i) => {
        const vague = `${ac.given} ${ac.when} ${ac.then}`.match(VAGUE);
        if (vague) add("warning", `${where} AC${i + 1}`, `"${vague[0]}" is not testable; state a measurable outcome.`);
      });
      for (const dep of s.dependsOn ?? []) {
        if (dep === s.id) add("error", where, "A story cannot depend on itself.");
        else if (!storyIds.has(dep)) add("error", where, `Depends on ${dep}, which is not a story in this backlog.`);
      }
      if (s.type === "spike" && s.storyPoints && s.storyPoints > 5) add("info", where, "Spikes are usually time-boxed to a few days.");
    }
  }
  checkSources("open questions", backlog.openQuestions?.flatMap((q) => q.sourceIds ?? []));

  for (const doc of contextDocs) {
    const isInput = !(doc.metadata as { artifact?: boolean } | undefined)?.artifact && !["metadata", "org"].includes(doc.kind);
    if (!isInput || referenced.has(doc.id)) continue;
    if (SENSITIVE.test(`${doc.title}\n${doc.content}`)) {
      add("warning", doc.id, `"${doc.title}" mentions security or compliance requirements but no epic or story cites it.`);
    } else {
      add("info", doc.id, `"${doc.title}" is not cited by any epic or story.`);
    }
  }

  if (backlog.openQuestions?.length && !allStories(backlog).some(({ story }) => story.type === "spike")) {
    add("info", "open questions", "There are open questions but no spikes; consider a spike for any question that blocks estimation.");
  }
  return findings;
}

export function findingsToText(findings: Finding[]): string {
  if (!findings.length) return "Quality check: no issues found.";
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...findings].sort((a, b) => order[a.level] - order[b.level]);
  const counts = (["error", "warning", "info"] as const).map((l) => `${findings.filter((f) => f.level === l).length} ${l}(s)`).join(", ");
  return [`Quality check: ${counts}.`, ...sorted.map((f) => `- ${f.level.toUpperCase()} [${f.where}] ${f.message}`)].join("\n");
}
