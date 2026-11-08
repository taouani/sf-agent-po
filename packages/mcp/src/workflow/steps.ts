// The steps every workflow shares, and the four workflows. The high-level design is written
// section by section (design-steps.ts); the detailed design and the backlog become steps of
// their own in later PRs, and until then end with one step that follows the agent's full
// method and points to the saved design or backlog.

import type { SourceDocument } from "@sf-agent-po/core";
import { z } from "zod";
import { WORKFLOWS } from "../prompts.js";
import { isInputDocument, proposeRequirements, requirementProposalSchema, requirementsToText, type ProposedRequirement } from "../requirements.js";
import { confirmScope, SourceGoneError, storedScope } from "../scope-tools.js";
import { readySources } from "../metadata-tools.js";
import { backlogSchema, checkBacklog, type Finding } from "../backlog.js";
import { contextLanguage } from "../checks.js";
import { assembleStep, hldSectionSteps } from "./design-steps.js";
import type { StepDefinition, StepOutcome, StepState, WorkflowDefinition, WorkflowKit } from "./engine.js";

const docLine = (d: SourceDocument) => `- [${d.id}] ${d.kind}: ${d.title}`;
const error = (where: string, message: string): Finding => ({ level: "error", where, message });

/** The user's comment, masked, as a finding the model sees with the rest. */
const commentFinding = (comment: string | undefined): Finding[] => (comment ? [{ level: "info", where: "user", message: `The user's comment: ${comment}` }] : []);

type RequirementsAnswer = { requirements: ProposedRequirement[] } | { keep: true };

export const requirementsStep: StepDefinition<RequirementsAnswer> = {
  id: "requirements",
  title: "Requirements",
  shape:
    '{"requirements": [{"kind": "functional" | "non-functional" | "constraint" | "compliance", "statement": "...", "priority": "must" | "should" | "could" | "wont", "sourceIds": ["doc-..."], "id": "R3 (only to revise an existing one)"}]}\n' +
    'or, to keep the confirmed requirements as they are: {"keep": true}',
  schema: z.union([z.object({ requirements: requirementProposalSchema }).strict(), z.object({ keep: z.literal(true) }).strict()]),
  brief({ kit, context }) {
    const docs = kit.contexts.documents(context);
    const inputs = docs.filter(isInputDocument);
    const others = docs.filter((d) => !isInputDocument(d));
    const existing = kit.requirements.list(context, { dropped: true });
    const confirmed = existing.filter((r) => r.status === "confirmed");
    return [
      "List the requirements the inputs state or imply. Read every input with context_get first.",
      `Inputs (${inputs.length}):\n${inputs.length ? inputs.map(docLine).join("\n") : "- none: ask the user to add the meeting notes, emails or documents with the context_add tools"}`,
      ...(others.length ? [`Also in the context, not inputs (do not cite them as sources):\n${others.map(docLine).join("\n")}`] : []),
      existing.length
        ? `Requirements so far:\n${requirementsToText(existing)}\nRevise one by giving its id. Leave out the ones that still hold: the user sees them as kept. Only the user drops a requirement.`
        : "There are no requirements yet.",
      [
        "Rules:",
        "- One need per requirement, in one sentence that can be tested. Split a statement that joins two needs.",
        "- kind: functional (what the system does), non-functional (how well: performance, availability, usability, with a measurable target), constraint (a limit on the solution: a technology, a date, a budget), compliance (a law, a regulation or a policy: GDPR, retention, consent, audit).",
        "- priority: MoSCoW, as the inputs say or imply it. Do not mark everything must.",
        "- sourceIds: the inputs it comes from. A requirement without a source is refused.",
        "- Do not invent requirements the inputs do not support; list a gap as an open question for the user instead.",
        "The user then confirms the list in their browser: they untick what is wrong, change priorities and add what is missing.",
      ].join("\n"),
      ...(confirmed.length ? [`${confirmed.length} requirement(s) are confirmed. If the inputs have not changed since, answer {"keep": true}.`] : []),
    ].join("\n\n");
  },
  async submit(answer, { kit, context, call }): Promise<StepOutcome> {
    if ("keep" in answer) {
      const confirmed = kit.requirements.list(context).filter((r) => r.status === "confirmed");
      if (!confirmed.length) return { kind: "retry", attempt: true, findings: [error("answer", "No requirement is confirmed yet, so there is nothing to keep: propose the requirements.")] };
      return { kind: "passed", findings: [], summary: `${confirmed.length} requirement(s) kept: ${confirmed.map((r) => r.id).join(", ")}.`, saved: { confirmed: confirmed.map((r) => r.id) } };
    }
    const out = await proposeRequirements({ ...kit, reviewer: kit.reviewerFor(call) }, context, answer.requirements);
    const extra = commentFinding(out.comment);
    switch (out.status) {
      case "invalid":
        return { kind: "retry", attempt: true, findings: out.findings };
      case "rejected":
        return { kind: "retry", attempt: true, findings: [error("user", "The user rejected the list. Ask them what is wrong before proposing it again."), ...extra] };
      case "expired":
        return { kind: "retry", attempt: false, findings: extra, message: "The user did not confirm the list in time, or closed the page. Ask them whether to show it again, then submit it again." };
      case "changed":
        return { kind: "retry", attempt: false, findings: extra, message: "The requirements changed while the user was deciding (another confirmation). Read them again with workflow_step, then submit." };
      case "approved": {
        const confirmed = out.requirements.filter((r) => r.status === "confirmed");
        const changes = [
          ...(out.dropped.length ? [`the user dropped ${out.dropped.join(", ")}`] : []),
          ...(out.typed.length ? [`added ${out.typed.join(", ")}`] : []),
        ];
        return {
          kind: "passed",
          findings: [...out.findings.filter((f) => f.level !== "error"), ...extra],
          summary: `${confirmed.length} requirement(s) confirmed${changes.length ? `; ${changes.join(", ")}` : ""}.`,
          saved: { confirmed: confirmed.map((r) => r.id), dropped: out.dropped, typed: out.typed },
          message: `Confirmed requirements:\n${requirementsToText(out.requirements)}`,
        };
      }
    }
  },
};

type ScopeAnswer = { objects: string[]; reason?: string; source?: string } | { keep: true } | { skip: string };

export const scopeStep: StepDefinition<ScopeAnswer> = {
  id: "scope",
  title: "Scope",
  shape:
    '{"objects": ["Account", "Policy__c"], "reason": "why these objects, in a sentence or two", "source": "org:00D... (optional; the newest one by default)"}\n' +
    'or, to keep the confirmed scope: {"keep": true}\n' +
    'or, only when no org or project is indexed: {"skip": "why"}',
  schema: z.union([
    z.object({ objects: z.array(z.string().min(1)).min(1).max(30), reason: z.string().max(2_000).optional(), source: z.string().optional() }).strict(),
    z.object({ keep: z.literal(true) }).strict(),
    z.object({ skip: z.string().min(3).max(500) }).strict(),
  ]),
  brief({ kit, context }) {
    const sources = kit.index ? readySources(kit.index) : [];
    const stored = storedScope(kit.contexts, context);
    return [
      "Propose the Salesforce objects this work touches, so the design looks closely at them and what is linked to them.",
      sources.length
        ? `Indexed: ${sources.map((s) => s.source).join(", ")}. Find the objects with metadata_summary and metadata_search, from the confirmed requirements.`
        : "Nothing is indexed. Ask the user whether to index the org or a project folder with metadata_index; if they say no, skip this step and say why.",
      stored
        ? `Confirmed scope (${stored.confirmedAt}) in ${stored.source}: ${stored.objects.join(", ")}. Answer {"keep": true} if it still fits the requirements.`
        : "No scope is confirmed yet.",
      "The user confirms the objects in their browser; the server then adds their fields, rules and record types, and the automation, code and layouts linked to them.",
    ].join("\n\n");
  },
  async submit(answer, { kit, context, call }): Promise<StepOutcome> {
    const sources = kit.index ? readySources(kit.index) : [];
    if ("skip" in answer) {
      if (sources.length) return { kind: "retry", attempt: true, findings: [error("answer", `${sources.map((s) => s.source).join(", ")} ${sources.length === 1 ? "is" : "are"} indexed: propose the objects instead of skipping.`)] };
      const why = (await kit.masker.maskOutput(context, answer.skip)).text;
      return { kind: "passed", findings: [{ level: "warning", where: "scope", message: `No org or project is indexed, so the design cannot be checked against the existing metadata: ${why}` }], summary: "Skipped: nothing indexed." };
    }
    if ("keep" in answer) {
      const stored = storedScope(kit.contexts, context);
      if (!stored) return { kind: "retry", attempt: true, findings: [error("answer", "No scope is confirmed yet, so there is nothing to keep: propose the objects.")] };
      if (!sources.some((s) => s.source === stored.source)) return { kind: "retry", attempt: true, findings: [error("answer", `The confirmed scope is in ${stored.source}, which is not indexed any more: propose the objects again.`)] };
      return { kind: "passed", findings: [], summary: `Scope kept: ${stored.objects.join(", ")}.`, saved: stored };
    }
    if (!kit.index || !sources.length) return { kind: "retry", attempt: true, findings: [error("answer", "Nothing is indexed, so no scope can be confirmed: index an org or a project with metadata_index, or skip this step.")] };
    let out;
    try {
      out = await confirmScope({ ...kit, index: kit.index }, call, context, answer);
    } catch (err) {
      // The source went while the user decided: not the model's doing. An unknown object or source is.
      return { kind: "retry", attempt: !(err instanceof SourceGoneError), findings: [error("objects", (await kit.masker.maskOutput(context, (err as Error).message)).text)] };
    }
    if (out.status === "confirmed") return { kind: "passed", findings: [], summary: `Scope confirmed: ${out.stored!.objects.join(", ")}.`, saved: out.stored, message: out.text };
    if (out.status === "expired") return { kind: "retry", attempt: false, findings: [], message: out.text };
    return { kind: "retry", attempt: true, findings: [error("user", out.text)] };
  },
};

type ArtifactAnswer = { artifactId: string } | { none: string };

/**
 * The step that follows the agent's full method (the 0.x text) and ends with a saved design or
 * backlog. `expects` says which: a design of a type, or a backlog.
 */
export function methodStep(workflow: keyof typeof WORKFLOWS, expects: { kind: "design"; type: "high-level" | "detailed" } | { kind: "backlog"; optional?: boolean }): StepDefinition<ArtifactAnswer> {
  const what = expects.kind === "design" ? `${expects.type} design` : "backlog";
  const save = expects.kind === "design" ? `design_save (designType "${expects.type}")` : "backlog_save";
  const optional = expects.kind === "backlog" && expects.optional;
  return {
    id: expects.kind === "design" ? "design" : workflow === "po_review_stories" ? "review" : "backlog",
    title: expects.kind === "design" ? `Draft the ${what}` : optional ? "Review the stories" : "Draft the backlog",
    shape: `{"artifactId": "doc-..."}: the ${what} you saved with ${save}${optional ? `\nor, when the user wants no stories saved: {"none": "why"}` : ""}`,
    schema: z.union([
      z.object({ artifactId: z.string().regex(/^doc-[0-9a-f]{10}$/, "use the document id that the save tool returned, such as doc-1a2b3c4d5e") }).strict(),
      z.object({ none: z.string().min(3).max(500) }).strict(),
    ]),
    brief(s: StepState) {
      const confirmed = s.kit.requirements.list(s.context).filter((r) => r.status === "confirmed");
      const method = WORKFLOWS[workflow].text({ context: s.context, focus: s.focus, industry: s.industry });
      return [
        confirmed.length
          ? `Confirmed requirements (cite their ids, such as R1, where the ${what} addresses them):\n${requirementsToText(confirmed)}`
          : "No requirement is confirmed: base the work on the inputs, and say so to the user.",
        "The requirements and the scope are already settled in this run: skip the method's steps that list requirements or propose the scope, and follow the rest.",
        `Method:\n\n${method}`,
        `When the ${what} is saved with ${save} and its quality check has no error, submit its id.`,
      ].join("\n\n");
    },
    async submit(answer, { kit, context, run }): Promise<StepOutcome> {
      if ("none" in answer) {
        if (!optional) return { kind: "retry", attempt: true, findings: [error("answer", `This step ends with a saved ${what}: save it with ${save} and submit its id.`)] };
        const why = (await kit.masker.maskOutput(context, answer.none)).text;
        return { kind: "passed", findings: [], summary: `No stories saved: ${why}` };
      }
      const doc = kit.contexts.getDocument(context, answer.artifactId);
      const meta = doc?.metadata as { artifact?: boolean; artifactType?: string; version?: number; savedAt?: string; backlog?: unknown } | undefined;
      if (!doc) return { kind: "retry", attempt: true, findings: [error("artifactId", `No document ${answer.artifactId} in context "${context}".`)] };
      const right = meta?.artifact && doc.kind === expects.kind && (expects.kind !== "design" || meta.artifactType === expects.type);
      if (!right) return { kind: "retry", attempt: true, findings: [error("artifactId", `${answer.artifactId} is not a ${what}: submit the id that ${save} returned.`)] };
      // Saved in this run: a save with unchanged content, or a publish, keeps the earlier time.
      if (!meta?.savedAt || meta.savedAt < run.createdAt) return { kind: "retry", attempt: true, findings: [error("artifactId", `${answer.artifactId} was written before this run started: save the new version with ${save}, then submit its id.`)] };
      if (expects.kind === "backlog") {
        const parsed = backlogSchema.safeParse(meta.backlog);
        if (!parsed.success) return { kind: "retry", attempt: true, findings: [error("artifactId", `${answer.artifactId} holds no backlog the check can read: save it again with backlog_save.`)] };
        const errors = checkBacklog(parsed.data, kit.contexts.documents(context).filter((d) => d.masked), contextLanguage(kit.contexts, context)).filter((f) => f.level === "error");
        if (errors.length) return { kind: "retry", attempt: true, findings: [...errors, error("artifactId", "The backlog's quality check has errors: fix them, save it again with backlog_save, then submit its id.")] };
      }
      return { kind: "passed", findings: [], summary: `Saved as ${doc.id}, version ${meta?.version ?? 1}: ${doc.title}.`, saved: { artifactId: doc.id, version: meta?.version ?? 1 } };
    },
  } as StepDefinition<ArtifactAnswer>;
}

// A run started with metadata on keeps its scope step if it is resumed with metadata off: the
// step then says nothing is indexed and can be skipped.
const withScope = (kit: WorkflowKit) => (kit.index ? [scopeStep] : []);

export const WORKFLOW_DEFINITIONS: Record<keyof typeof WORKFLOWS, WorkflowDefinition> = {
  sa_high_level_design: {
    id: "sa_high_level_design",
    title: WORKFLOWS.sa_high_level_design.title,
    next: "Show the user the design, and offer to publish it to Confluence with confluence_publish.",
    steps: (kit) => [requirementsStep, ...withScope(kit), ...hldSectionSteps, assembleStep] as StepDefinition[],
    // A run started before the design had its section steps ends the old way, with a saved design.
    optional: [scopeStep as StepDefinition, methodStep("sa_high_level_design", { kind: "design", type: "high-level" }) as StepDefinition],
  },
  sa_detailed_design: {
    id: "sa_detailed_design",
    title: WORKFLOWS.sa_detailed_design.title,
    next: "Show the user the design, and offer to publish it to Confluence with confluence_publish.",
    steps: (kit) => [requirementsStep, ...withScope(kit), methodStep("sa_detailed_design", { kind: "design", type: "detailed" })] as StepDefinition[],
    optional: [scopeStep as StepDefinition],
  },
  po_backlog: {
    id: "po_backlog",
    title: WORKFLOWS.po_backlog.title,
    next: "Show the user the backlog, and offer to publish it to Jira with jira_publish.",
    steps: () => [requirementsStep, methodStep("po_backlog", { kind: "backlog" })] as StepDefinition[],
  },
  po_review_stories: {
    id: "po_review_stories",
    title: WORKFLOWS.po_review_stories.title,
    next: "Tell the user what the review found; if stories were saved, offer to publish them to Jira with jira_publish.",
    steps: () => [methodStep("po_review_stories", { kind: "backlog", optional: true })] as StepDefinition[],
  },
};
