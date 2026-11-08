// The backlog as steps (phase 4): the epics first, from the confirmed requirements; then the
// stories of each epic in turn, with their acceptance criteria, each epic checked on its own;
// then a last step that puts them together, checks that every Must requirement is delivered by
// a story, and saves the backlog.

import type { Requirement, SourceDocument } from "@sf-agent-po/core";
import { z } from "zod";
import { industryBlock } from "../agents/industries.js";
import { PO_PRACTICES } from "../agents/product-owner.js";
import {
  allStories,
  type Backlog,
  checkBacklog,
  coverageFindings,
  type Epic,
  epicSchema,
  type Finding,
  maskBacklogFields,
  NOT_WRITTEN,
  saveBacklog,
  type Story,
  storySchema,
  uncoveredRequirements,
} from "../backlog.js";
import { contextLanguage } from "../checks.js";
import { maskDeep } from "../design/mask.js";
import { requirementsToText } from "../requirements.js";
import { confirmedOf, plural } from "./design-steps.js";
import type { StepDefinition, StepOutcome, StepState } from "./engine.js";

/** One practice of PO_PRACTICES, by its bold heading. */
export function practice(heading: string): string {
  const line = PO_PRACTICES.split("\n").find((l) => l.startsWith(`- **${heading}`));
  if (!line) throw new Error(`No backlog practice "${heading}".`);
  return line;
}

const docLine = (d: SourceDocument) => `- [${d.id}] ${d.kind}: ${d.title}`;
const error = (where: string, message: string): Finding => ({ level: "error", where, message });

type EpicHead = Omit<Epic, "stories">;

const epicHead = z.strictObject((({ stories: _, ...rest }) => rest)(epicSchema.shape));
const epicsAnswer = z.strictObject({ epics: z.array(epicHead).min(1).max(30) });
const storiesAnswer = z.strictObject({
  epicId: epicSchema.shape.id,
  stories: z.array(z.strictObject({ ...storySchema.shape, acceptanceCriteria: z.array(z.strictObject(storySchema.shape.acceptanceCriteria.element.shape)).min(1) })).min(1).max(30),
});

type EpicsAnswer = { epics: EpicHead[] };
type StoriesAnswer = { epicId: string; stories: Story[] };
/** What the stories step holds: the stories written so far, by epic id. */
type StoriesSaved = { stories: Record<string, Story[]> };

/** The epics the epics step saved in a run, if it passed. */
export function epicsOf(run: StepState["run"]): EpicHead[] {
  const step = run.steps.find((s) => s.step === "epics");
  return step && (step.status === "passed" || step.status === "warned") ? ((step.answer as EpicsAnswer | undefined)?.epics ?? []) : [];
}

/** The stories written so far, by epic: kept even when the step failed, for the epics that passed. */
export function storiesOf(run: StepState["run"]): Record<string, Story[]> {
  return (run.steps.find((s) => s.step === "stories")?.answer as StoriesSaved | undefined)?.stories ?? {};
}

/** The backlog written so far: the epics, each with its stories (none yet for some). */
function draftOf(run: StepState["run"], title = ""): Backlog {
  const stories = storiesOf(run);
  return { title, epics: epicsOf(run).map((e) => ({ ...e, stories: stories[e.id] ?? [] })) };
}

/** The saved backlogs, for the title: a backlog saved under the same title is a new version of it, and keeps its Jira issues. */
function savedBacklogs(s: StepState): string[] {
  const backlogs = s.kit.contexts.documents(s.context).filter((d) => d.kind === "backlog" && (d.metadata as { artifact?: boolean } | undefined)?.artifact);
  return backlogs.length
    ? [
        `Saved backlogs:\n${backlogs.map(docLine).join("\n")}\nTo revise one of them, give it the same title: it is saved as a new version, and publishing updates its Jira issues instead of creating new ones. A new title starts a new backlog.`,
      ]
    : [];
}

/** The backlogs and designs already in the context: the backlog keeps their ids and follows them. */
function earlierWork(s: StepState): string[] {
  const docs = s.kit.contexts.documents(s.context);
  const backlogs = docs.filter((d) => d.kind === "backlog" && (d.metadata as { artifact?: boolean } | undefined)?.artifact);
  const designs = docs.filter((d) => d.kind === "design" && (d.metadata as { artifact?: boolean } | undefined)?.artifact);
  return [
    ...(backlogs.length
      ? [`Saved backlogs (read them with backlog_get, and keep their epic and story ids and Jira keys when you revise one):\n${backlogs.map(docLine).join("\n")}`]
      : []),
    ...(designs.length ? [`Designs (read them with context_read, and follow their decisions):\n${designs.map(docLine).join("\n")}`] : []),
  ];
}

const requirementsBlock = (confirmed: readonly Requirement[], what: string) =>
  confirmed.length
    ? `Confirmed requirements (cite the ids ${what} delivers; only these):\n${requirementsToText(confirmed)}`
    : "No requirement is confirmed: base the backlog on the inputs, and say so to the user.";

/** The requirements an epic cites that none of its published stories delivers. */
function undelivered(epic: EpicHead, stories: readonly Story[]): Finding[] {
  if (epic.priority === "wont") return [];
  const delivered = new Set(stories.filter((x) => x.priority !== "wont").flatMap((x) => x.requirementIds ?? []));
  return (epic.requirementIds ?? [])
    .filter((id) => !delivered.has(id))
    .map((id) => ({ level: "warning" as const, where: epic.id, message: `${epic.id} cites ${id}, but none of its stories delivers it: cite it in the story that does, or leave it to another epic.` }));
}

/** Warnings and infos about one epic's own items: the rest of the draft was checked when it was written. */
const about = (ids: ReadonlySet<string>) => (f: Finding) => f.level === "error" || f.where === "backlog" || ids.has(f.where.split(" ")[0]!);

export const epicsStep: StepDefinition<EpicsAnswer> = {
  id: "epics",
  title: "Epics",
  shape:
    '{"epics": [{"id": "E1", "summary": "Renewal letters", "outcome": "the business outcome", "successMetrics": ["..."], "scopeNotes": "in and out of scope",\n' +
    '  "priority": "must" | "should" | "could" | "wont", "requirementIds": ["R1"], "sourceIds": ["doc-..."], "jiraKey": "PORT-12 (only to revise an existing issue)"}]}',
  schema: epicsAnswer as z.ZodType<EpicsAnswer>,
  brief(s) {
    const confirmed = confirmedOf(s);
    const docs = s.kit.contexts.documents(s.context);
    return [
      "Group the work into epics, by business outcome. Each epic cites the confirmed requirements its stories will deliver: together, the epics should cover every Must requirement. You write the stories of each epic at the next step.",
      ["Epics", "Salesforce enabler work", "Traceability", "Priorities", "Stable ids"].map(practice).join("\n"),
      ...[industryBlock(s.industry).trim()].filter(Boolean),
      requirementsBlock(confirmed, "each epic"),
      ...earlierWork(s),
      `Context documents (read them with context_read):\n${docs.length ? docs.map(docLine).join("\n") : "- none"}`,
    ].join("\n\n");
  },
  async submit(answer, s): Promise<StepOutcome> {
    const confirmed = confirmedOf(s);
    const { backlog } = await maskBacklogFields(s.kit.masker, s.context, { title: "", epics: answer.epics.map((e) => ({ ...e, stories: [] })) });
    const findings = checkBacklog(backlog, s.kit.contexts.documents(s.context).filter((d) => d.masked), contextLanguage(s.kit.contexts, s.context), {
      requirements: confirmed,
      draft: true,
    });
    const cited = new Set(backlog.epics.filter((e) => e.priority !== "wont").flatMap((e) => e.requirementIds ?? []));
    for (const r of confirmed.filter((r) => r.priority === "must" && !cited.has(r.id)))
      findings.push({ level: "warning", where: r.id, message: `Must requirement ${r.id} is cited by no epic: add it to the epic whose stories will deliver it.` });
    if (findings.some((f) => f.level === "error")) return { kind: "retry", attempt: true, findings };
    const epics = backlog.epics.map(({ stories: _, ...e }) => e);
    const ids = [...cited].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    return { kind: "passed", findings, summary: `${plural(epics.length, "epic")}: ${epics.map((e) => e.id).join(", ")}.${ids.length ? ` Cites ${ids.join(", ")}.` : ""}`, saved: { epics } };
  },
};

export const storiesStep: StepDefinition<StoriesAnswer> = {
  id: "stories",
  title: "Stories and acceptance criteria",
  shape:
    '{"epicId": "E1", "stories": [{"id": "S1", "type": "story" | "spike", "summary": "...", "persona": "Renewals agent", "want": "...", "benefit": "...",\n' +
    '  "acceptanceCriteria": [{"given": "...", "when": "...", "then": "..."}], "nonFunctional": ["..."], "technicalNotes": "pointers to the design",\n' +
    '  "priority": "must" | "should" | "could" | "wont", "storyPoints": 3, "labels": ["..."], "dependsOn": ["S2"], "requirementIds": ["R1"], "sourceIds": ["doc-..."], "jiraKey": "PORT-13 (only to revise an existing issue)"}]}',
  schema: storiesAnswer as z.ZodType<StoriesAnswer>,
  brief(s) {
    const epics = epicsOf(s.run);
    if (!epics.length) return 'The epics step failed, so there is no epic to write stories for. Tell the user, and start the workflow again with restart set to true once they have looked at it. Until then, any answer is sent back.';
    const written = storiesOf(s.run);
    const next = epics.find((e) => !written[e.id]) ?? epics[epics.length - 1]!;
    const confirmed = confirmedOf(s);
    const cited = confirmed.filter((r) => next.requirementIds?.includes(r.id));
    const done = epics.filter((e) => written[e.id]);
    const later = epics.filter((e) => e !== next && !written[e.id]);
    const docs = s.kit.contexts.documents(s.context);
    return [
      `Write the stories of epic ${next.id}, "${next.summary}", with their acceptance criteria. Outcome: ${next.outcome}${next.scopeNotes ? `\nScope: ${next.scopeNotes}` : ""}`,
      cited.length ? `Requirements this epic cites (each should be delivered by at least one of its stories):\n${requirementsToText(cited)}` : "This epic cites no requirement.",
      done.length
        ? `Epics written so far (submit one again, with its epicId, to revise it before the last epic is written):\n${done.map((e) => `- ${e.id}: ${written[e.id]!.map((x) => x.id).join(", ")}`).join("\n")}`
        : "No story is written yet.",
      [
        "Submit one epic at a time, in any order: this one is a suggestion. Story ids must be unique across the backlog.",
        "A story may depend on a story of an epic not written yet: that is a warning until the last epic is written, when every dependency must name a story of the backlog.",
      ].join(" "),
      ...(later.length ? [`Epics after this one: ${later.map((e) => e.id).join(", ")}.`] : ["This is the last epic: the step passes once its stories pass."]),
      ["Stories", "INVEST", "Definition of Ready", "Acceptance criteria", "Non-functional requirements", "Open questions", "Dependencies", "Traceability", "Design alignment", "Stable ids"].map(practice).join("\n"),
      ...[industryBlock(s.industry).trim()].filter(Boolean),
      requirementsBlock(confirmed, "each story"),
      ...earlierWork(s),
      `Context documents (read them with context_read):\n${docs.length ? docs.map(docLine).join("\n") : "- none"}`,
    ].join("\n\n");
  },
  async submit(answer, s): Promise<StepOutcome> {
    const epics = epicsOf(s.run);
    const epic = epics.find((e) => e.id === answer.epicId);
    if (!epic)
      return {
        kind: "retry",
        attempt: true,
        findings: [error("epicId", epics.length ? `${answer.epicId} is not an epic of this backlog: use one of ${epics.map((e) => e.id).join(", ")}.` : "The epics step failed, so there is no epic to write stories for.")],
      };
    const confirmed = confirmedOf(s);
    const masked = (await maskBacklogFields(s.kit.masker, s.context, { title: "", epics: [{ ...epic, stories: answer.stories }] })).backlog.epics[0]!.stories;
    const before = storiesOf(s.run);
    const written = { ...before, [epic.id]: masked };
    // Every epic, those not written yet with no stories: an id is checked against the epics' too.
    const draft: Backlog = { title: "", epics: epics.map((e) => ({ ...e, stories: written[e.id] ?? [] })) };
    const left = epics.filter((e) => !written[e.id]);
    const checked = checkBacklog(draft, s.kit.contexts.documents(s.context).filter((d) => d.masked), contextLanguage(s.kit.contexts, s.context), {
      requirements: confirmed,
      draft: true,
    });
    // Once the last epic is written, what the draft let wait is due, and the step's findings are the whole backlog's.
    const findings = left.length
      ? checked.filter(about(new Set([epic.id, ...masked.map((x) => x.id)])))
      : checked.map((f): Finding => (f.message.includes(NOT_WRITTEN) ? { ...f, level: "error", message: f.message.replace(/: it must be .*$/, ": every dependency must name a story of the backlog.") } : f));
    for (const e of left.length ? [epic] : epics) findings.push(...undelivered(e, written[e.id] ?? []));
    if (findings.some((f) => f.level === "error")) return { kind: "retry", attempt: true, findings };

    const saved: StoriesSaved = { stories: written };
    const all = Object.values(written).flat();
    if (left.length) {
      const verb = before[epic.id] ? "were revised" : "passed";
      return {
        kind: "progress",
        findings,
        saved,
        fresh: !before[epic.id],
        message: `The stories of ${epic.id} ${verb}: ${plural(masked.length, "story", "stories")} (${masked.map((x) => x.id).join(", ")}). Next: epic ${left[0]!.id}.`,
      };
    }
    return { kind: "passed", findings, summary: `${plural(all.length, "story", "stories")} in ${plural(epics.length, "epic")}.`, saved };
  },
};

const gapSchema = z.strictObject({ requirementId: z.string().regex(/^R[1-9]\d{0,5}$/, "use a requirement id such as R1"), reason: z.string().trim().min(3).max(500) });
const assembleAnswer = z.strictObject({
  title: z.string().trim().min(3).max(200),
  summary: z.string().trim().min(1).max(2_000).optional(),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  openQuestions: z
    .array(
      z.strictObject({
        question: z.string().trim().min(3).max(500),
        owner: z.string().trim().min(1).max(120).optional(),
        sourceIds: z.array(z.string().regex(/^doc-[0-9a-f]{10}$/, "use a context document id such as doc-1a2b3c4d5e")).max(10).optional(),
      }),
    )
    .max(30)
    .optional(),
  gaps: z.array(gapSchema).max(60).default([]),
});
type AssembleAnswer = z.infer<typeof assembleAnswer>;

export const backlogAssembleStep: StepDefinition<AssembleAnswer> = {
  id: "assemble",
  title: "Assemble and save the backlog",
  shape:
    '{"title": "Policy renewals: backlog", "summary": "a short overview for stakeholders", "assumptions": ["..."],\n' +
    ' "openQuestions": [{"question": "...", "owner": "Business owner", "sourceIds": ["doc-..."]}],\n' +
    ' "gaps": [{"requirementId": "R7", "reason": "why no story delivers it: out of scope, or waiting on an open question"}]}',
  schema: assembleAnswer as z.ZodType<AssembleAnswer>,
  brief(s) {
    const draft = draftOf(s.run);
    const confirmed = confirmedOf(s);
    const open = uncoveredRequirements(draft, confirmed);
    const empty = draft.epics.filter((e) => !e.stories.length).map((e) => e.id);
    return [
      "Give the backlog its title, a short summary, the assumptions and the open questions, each with the role who should answer it. The server puts the epics and stories together, checks the whole backlog and saves it.",
      ...savedBacklogs(s),
      practice("Open questions"),
      open.length
        ? `Confirmed requirements no story delivers:\n${requirementsToText(open)}\nFor each Must, give the reason in gaps (out of scope, waiting on an open question...): a Must left out without a reason is sent back. Give the reason for the others too.`
        : "Every confirmed requirement is delivered by a story.",
      ...(empty.length ? [`These epics have no stories, because the stories step failed, and are left out of the backlog: ${empty.join(", ")}. Tell the user.`] : []),
    ].join("\n\n");
  },
  async submit(answer, s): Promise<StepOutcome> {
    const { kit, context, run } = s;
    const confirmed = confirmedOf(s);
    const draft = draftOf(run);
    const epics = draft.epics.filter((e) => e.stories.length);
    if (!epics.length) return { kind: "retry", attempt: true, findings: [error("stories", "No epic has stories, so there is no backlog to save: tell the user the earlier steps failed, and start again with restart set to true.")] };
    // Masked like a saved backlog: the title alone, since it names the artifact.
    const title = (await kit.masker.maskOutput(context, answer.title)).text;
    const rest = await maskDeep(kit.masker, context, { summary: answer.summary, assumptions: answer.assumptions, openQuestions: answer.openQuestions, gaps: answer.gaps });
    const backlog: Backlog = {
      title,
      ...(rest.summary ? { summary: rest.summary } : {}),
      epics,
      ...(rest.assumptions?.length ? { assumptions: rest.assumptions } : {}),
      ...(rest.openQuestions?.length ? { openQuestions: rest.openQuestions } : {}),
    };
    const known = new Set(confirmed.map((r) => r.id));
    const open = new Set(uncoveredRequirements(backlog, confirmed).map((r) => r.id));
    const findings: Finding[] = [];
    for (const g of rest.gaps) {
      if (!known.has(g.requirementId)) findings.push(error(g.requirementId, `${g.requirementId} is not a confirmed requirement.`));
      else if (!open.has(g.requirementId)) findings.push({ level: "warning", where: g.requirementId, message: `${g.requirementId} is delivered by a story, so it is not a gap: it is left out of the gaps.` });
    }
    findings.push(...coverageFindings(backlog, confirmed, "error", new Set(rest.gaps.map((g) => g.requirementId))));
    // The epics and stories passed their own steps: what the whole backlog still shows is for the user to see, not for this answer to fix.
    const whole = checkBacklog(backlog, kit.contexts.documents(context).filter((d) => d.masked), contextLanguage(kit.contexts, context), { requirements: confirmed });
    findings.push(...whole.map((f): Finding => (f.level === "error" ? { ...f, level: "warning", message: `${f.message} (Left from an earlier step: fix it with backlog_save, or run the workflow again.)` } : f)));
    for (const e of draft.epics.filter((x) => !x.stories.length)) findings.push({ level: "warning", where: e.id, message: `Epic ${e.id} has no stories (the stories step failed) and is left out of the backlog.` });
    if (findings.some((f) => f.level === "error")) return { kind: "retry", attempt: true, findings };
    // The reasons stay with the backlog, for the user and the traceability matrix.
    const gaps = rest.gaps.filter((g) => open.has(g.requirementId));
    if (gaps.length) backlog.gaps = gaps;
    const doc = saveBacklog(kit.contexts, context, backlog);
    const version = doc.metadata.version;
    const stories = allStories(backlog).length;
    return { kind: "passed", findings, summary: `Saved as ${doc.id}, version ${version}: ${doc.title} (${plural(epics.length, "epic")}, ${plural(stories, "story", "stories")}).`, saved: { artifactId: doc.id, version } };
  },
};

export const backlogSteps: StepDefinition[] = [epicsStep, storiesStep, backlogAssembleStep] as StepDefinition[];
