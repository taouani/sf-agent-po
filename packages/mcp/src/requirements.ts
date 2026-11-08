// Requirements (phase 4, decision D1): the agent extracts the requirements of a context from
// its inputs, the checks look at them, and the user confirms the list on the approval page.
// Confirmed requirements keep their ids ("R1", "R2"...) for the life of the context, so the
// design, the backlog and the traceability matrix can point to them.
//
// Statements are masked before anything is stored or shown to a model; the page shows the
// real values, since only the user's browser sees it.

import {
  REQUIREMENT_ID,
  REQUIREMENT_KINDS,
  REQUIREMENT_PRIORITIES,
  type ContextRepository,
  type Masker,
  type Requirement,
  type RequirementChange,
  type RequirementRepository,
  type SourceDocument,
} from "@sf-agent-po/core";
import { z } from "zod";
import { requestDigest, type RequirementItem, type RequirementsRequest } from "./approval/server.js";
import { SENSITIVE, VAGUE, type Finding } from "./backlog.js";
import type { Reviewer } from "./inputs.js";

/** Requirements one proposal can hold. */
export const MAX_REQUIREMENTS = 200;

export const proposedRequirementSchema = z.object({
  id: z.string().regex(REQUIREMENT_ID, "use an id the context gave, such as R3").optional().describe("The id of a requirement this one revises. Leave it out for a new requirement."),
  kind: z.enum(REQUIREMENT_KINDS),
  statement: z.string().trim().min(5).max(1_000).describe("One requirement, in one sentence. Keep pseudonyms as they are."),
  priority: z.enum(REQUIREMENT_PRIORITIES).describe("MoSCoW priority, as the inputs state or imply it."),
  sourceIds: z.array(z.string().regex(/^doc-[0-9a-f]{10}$/, "use a context document id such as doc-1a2b3c4d5e")).max(20).describe("The context documents it comes from."),
});

export const requirementProposalSchema = z.array(proposedRequirementSchema).min(1).max(MAX_REQUIREMENTS);

export type ProposedRequirement = z.infer<typeof proposedRequirementSchema>;

/** A statement compared with others: case, spacing and final punctuation do not count. */
export const normalizeStatement = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.!;:]+$/, "");

/** Sentences in a statement, abbreviations aside. */
const sentences = (s: string) =>
  s
    .replace(/\b(e\.g|i\.e|etc|vs|approx|cf)\./gi, "$1")
    .split(/[.!?](?:\s+|$)/)
    .filter((p) => p.trim()).length;

/** Whether a document is an input (not something the agents wrote, nor the org's metadata). */
export const isInputDocument = (doc: SourceDocument) => !(doc.metadata as { artifact?: boolean } | undefined)?.artifact && !["metadata", "org"].includes(doc.kind);

/** Where a proposed requirement is in the findings: its id, or "new 3" (its place in the proposal). */
const whereOf = (r: ProposedRequirement, i: number) => r.id ?? `new ${i + 1}`;

/**
 * Deterministic checks on a proposal (masked), against what the context already has:
 * `existing` is every requirement of the context, dropped ones too, and `contextDocs` its
 * documents. An error stops the proposal before the user sees it.
 */
export function checkRequirements(proposal: readonly ProposedRequirement[], existing: readonly Requirement[], contextDocs: readonly SourceDocument[]): Finding[] {
  const findings: Finding[] = [];
  const add = (level: Finding["level"], where: string, message: string) => findings.push({ level, where, message });
  const known = new Map(existing.map((r) => [r.id, r]));
  const docs = new Map(contextDocs.map((d) => [d.id, d]));

  const ids = new Map<string, number>();
  const statements = new Map<string, string>();
  const cited = new Set<string>();
  proposal.forEach((r, i) => {
    const where = whereOf(r, i);
    const before = r.id ? known.get(r.id) : undefined;
    if (r.id) {
      ids.set(r.id, (ids.get(r.id) ?? 0) + 1);
      if (!before) add("error", where, `${r.id} is not a requirement of this context. Leave the id out for a new requirement.`);
    }
    const norm = normalizeStatement(r.statement);
    const twin = statements.get(norm);
    if (twin) add("error", where, `Says the same as ${twin}; keep one of them.`);
    else statements.set(norm, where);

    if (!r.sourceIds.length && before?.origin !== "user") add("error", where, "No source: cite the documents the requirement comes from.");
    for (const id of r.sourceIds) {
      cited.add(id);
      const doc = docs.get(id);
      if (!doc) add("error", where, `Source ${id} is not a document in this context.`);
      else if (!isInputDocument(doc)) add("warning", where, `Source ${id} ("${doc.title}") is not an input but something the agents wrote or the org's metadata; cite the inputs it comes from.`);
    }
    if (sentences(r.statement) > 1) add("warning", where, "States more than one sentence; a requirement should state one thing, so split it if it holds several.");
    if (r.kind === "non-functional") {
      const vague = r.statement.match(VAGUE);
      if (vague) add("warning", where, `"${vague[0]}" cannot be tested; state a measurable target.`);
    }
  });
  for (const [id, n] of ids) if (n > 1) add("error", id, `${id} is in the proposal ${n} times.`);

  const inProposal = new Set(proposal.flatMap((r) => (r.id ? [r.id] : [])));
  const kept = existing.filter((r) => r.status !== "dropped" && !inProposal.has(r.id));
  if (kept.length) add("info", "proposal", `${kept.map((r) => r.id).join(", ")} ${kept.length === 1 ? "is" : "are"} not in the proposal; the user sees ${kept.length === 1 ? "it" : "them"} on the page as kept from before.`);

  const compliance = new Set(proposal.filter((r) => r.kind === "compliance" || r.kind === "non-functional" || r.kind === "constraint").flatMap((r) => r.sourceIds));
  for (const doc of contextDocs) {
    if (!isInputDocument(doc)) continue;
    const sensitive = SENSITIVE.test(`${doc.title}\n${doc.content}`);
    if (!cited.has(doc.id)) add(sensitive ? "warning" : "info", doc.id, `"${doc.title}" is not cited by any requirement${sensitive ? ", and it mentions security or compliance" : ""}.`);
    else if (sensitive && !compliance.has(doc.id)) add("warning", doc.id, `"${doc.title}" mentions security or compliance, but no compliance, non-functional or constraint requirement cites it.`);
  }
  return findings;
}

export interface RequirementsKit {
  contexts: ContextRepository;
  requirements: RequirementRepository;
  masker: Masker;
  reviewer: Reviewer;
}

export interface RequirementsOutcome {
  /**
   * - `invalid`: the checks found errors; nothing was shown to the user.
   * - `approved`: the user confirmed the list; `requirements` is the context's list now.
   * - `rejected` or `expired`: nothing changed.
   */
  status: "invalid" | "approved" | "rejected" | "expired";
  findings: Finding[];
  /** The context's requirements (masked), dropped ones aside. */
  requirements: Requirement[];
  /** Ids the user dropped. */
  dropped: string[];
  /** Ids of the requirements the user typed. */
  typed: string[];
  /** The user's comment, masked. */
  comment?: string;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Checks a proposal and, when it has no error, asks the user to confirm it on the approval
 * page, with the requirements kept from before. On approval, the ticked requirements are
 * confirmed with the priorities the user chose, the existing ones left unticked are dropped,
 * and the lines the user typed are added. A rejected or expired request changes nothing.
 */
export async function proposeRequirements(kit: RequirementsKit, context: string, proposal: readonly ProposedRequirement[]): Promise<RequirementsOutcome> {
  const { contexts, requirements, masker } = kit;
  const existing = requirements.list(context, { dropped: true });
  const docs = contexts.documents(context);

  // What the agent wrote is masked like any output: pseudonyms stay, values in clear are hidden.
  const masked = (await masker.maskOutputs(context, proposal.map((r) => r.statement))).texts;
  const byStatement = new Map(existing.map((r) => [normalizeStatement(r.statement), r]));
  const items: ProposedRequirement[] = proposal.map((r, i) => {
    const statement = masked[i]!;
    // A new requirement that says what an existing one says takes its id, so it is not listed twice.
    const twin = r.id ? undefined : byStatement.get(normalizeStatement(statement));
    return { ...r, statement, sourceIds: [...new Set(r.sourceIds)], ...(twin && !proposal.some((p) => p.id === twin.id) ? { id: twin.id } : {}) };
  });
  const findings = checkRequirements(items, existing, docs);
  const outcome = (status: RequirementsOutcome["status"], extra: Partial<RequirementsOutcome> = {}): RequirementsOutcome => ({
    status,
    findings,
    requirements: requirements.list(context),
    dropped: [],
    typed: [],
    ...extra,
  });
  if (findings.some((f) => f.level === "error")) return outcome("invalid");

  const known = new Map(existing.map((r) => [r.id, r]));
  const real = (text: string) => masker.unmask(context, text).text;
  const titles = new Map(docs.map((d) => [d.id, real(d.title)]));
  const sourcesOf = (ids: readonly string[]) => ids.map((id) => titles.get(id) ?? id);
  let fresh = 0;
  const offered: { item: RequirementItem; change: RequirementChange; before?: Requirement }[] = items.map((r) => {
    const before = r.id ? known.get(r.id) : undefined;
    const note = !before
      ? "New"
      : before.status === "dropped"
        ? "Dropped before, proposed again"
        : before.statement === r.statement && before.kind === r.kind && before.priority === r.priority && same(before.sourceIds, r.sourceIds)
          ? "Unchanged"
          : "Changed";
    const key = r.id ?? `n${++fresh}`;
    return {
      item: { key, ...(r.id ? { id: r.id } : {}), kind: r.kind, priority: r.priority, statement: real(r.statement), sources: sourcesOf(r.sourceIds), note },
      change: { ...(r.id ? { id: r.id } : {}), kind: r.kind, statement: r.statement, priority: r.priority, status: "confirmed", sourceIds: r.sourceIds },
      ...(before ? { before } : {}),
    };
  });
  const proposed = new Set(items.flatMap((r) => (r.id ? [r.id] : [])));
  for (const r of existing) {
    if (r.status === "dropped" || proposed.has(r.id)) continue;
    offered.push({
      item: { key: r.id, id: r.id, kind: r.kind, priority: r.priority, statement: real(r.statement), sources: sourcesOf(r.sourceIds), note: r.origin === "user" ? "Kept from before, typed by you" : "Kept from before" },
      change: { id: r.id, kind: r.kind, statement: r.statement, priority: r.priority, status: "confirmed", sourceIds: r.sourceIds },
      before: r,
    });
  }

  const req: RequirementsRequest = {
    kind: "requirements",
    title: context,
    items: offered.map((o) => o.item),
    warnings: findings.filter((f) => f.level === "warning").map((f) => real(`${f.where}: ${f.message}`)),
  };
  const decision = await kit.reviewer.review(req);
  if (decision.digest !== requestDigest(req)) throw new Error("The decision does not match the requirements shown, so nothing was saved.");
  const comment = decision.comment ? (await masker.mask(context, decision.comment)).text : undefined;
  if (decision.status !== "approved") return outcome(decision.status === "rejected" ? "rejected" : "expired", comment ? { comment } : {});

  const selected = new Set(decision.selected ?? []);
  const changes: RequirementChange[] = [];
  const dropped: string[] = [];
  for (const { item, change, before } of offered) {
    if (!selected.has(item.key)) {
      if (before && before.status !== "dropped") {
        changes.push({ ...change, kind: before.kind, statement: before.statement, priority: before.priority, sourceIds: before.sourceIds, status: "dropped" });
        dropped.push(before.id);
      }
      continue;
    }
    const chosen = { ...change, priority: decision.priorities?.[item.key] ?? change.priority };
    const unchanged =
      before && before.status === "confirmed" && before.statement === chosen.statement && before.kind === chosen.kind && before.priority === chosen.priority && same(before.sourceIds, chosen.sourceIds);
    if (!unchanged) changes.push(chosen);
  }
  const lines = decision.lines ?? [];
  const typedText = lines.length ? await Promise.all(lines.map(async (l) => (await masker.mask(context, l)).text)) : [];
  const typedChanges: RequirementChange[] = typedText.map((statement) => ({ kind: "functional", statement, priority: "must", status: "confirmed", origin: "user", sourceIds: [] }));
  const saved = requirements.save(context, [...changes, ...typedChanges]);
  const typed = saved.slice(changes.length).map((r) => r.id);
  return outcome("approved", { dropped, typed, ...(comment ? { comment } : {}) });
}

/** The context's requirements as the model reads them (masked). */
export function requirementsToText(list: readonly Requirement[]): string {
  if (!list.length) return "No requirements yet.";
  return list
    .map((r) => `- ${r.id} [${r.kind}, ${r.priority}${r.status === "confirmed" ? "" : `, ${r.status}`}] ${r.statement}${r.sourceIds.length ? ` (from ${r.sourceIds.join(", ")})` : r.origin === "user" ? " (typed by the user)" : ""}`)
    .join("\n");
}
