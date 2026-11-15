// The "requirements, decisions and open points" page: one Confluence page that gathers, for a
// backlog or a design, the context's confirmed requirements, the decisions taken (the
// backlog's and the designs'), the open questions, and what is still open (requirements not
// delivered, assumptions, risks). It is built from what the server already keeps, masked, like
// every artifact: the real values are put back only for the approved write.

import type { ContextRepository, Requirement, RequirementRepository } from "@sf-agent-po/core";
import type { Artifact } from "./artifacts.js";
import type { Backlog } from "./backlog.js";
import type { DecisionsSection } from "./design/schema.js";
import { cell, oneLine } from "./design/render.js";

/** Joins sentences, without doubling the full stop one already ends with. */
const sentences = (parts: (string | undefined)[]) => parts.filter((p): p is string => !!p?.trim()).map((p) => p.trim().replace(/\.+$/, "")).join(". ");

const PRIORITY: Record<Requirement["priority"], string> = { must: "Must", should: "Should", could: "Could", wont: "Won't" };
const KIND: Record<Requirement["kind"], string> = { functional: "Functional", "non-functional": "Non-functional", constraint: "Constraint", compliance: "Compliance" };

interface DesignMeta {
  artifact?: boolean;
  artifactType?: string;
  design?: { decisions?: DecisionsSection; gaps?: { requirementId?: string; story?: string; reason: string }[] };
}

/** One source of decisions and open points: the artifact itself, then the context's designs. */
interface Source {
  name: string;
  decisions: { id: string; title: string; choice: string; reason?: string; options?: string[]; owner?: string; requirementIds?: string[] }[];
  openQuestions: { question: string; owner?: string }[];
  gaps: { what: string; reason: string }[];
  assumptions: string[];
  risks: { risk: string; mitigation?: string }[];
}

function fromBacklog(name: string, b: Backlog): Source {
  return {
    name,
    decisions: b.decisions ?? [],
    openQuestions: b.openQuestions ?? [],
    gaps: (b.gaps ?? []).map((g) => ({ what: g.requirementId, reason: g.reason })),
    assumptions: b.assumptions ?? [],
    risks: [],
  };
}

function fromDesign(name: string, meta: DesignMeta): Source {
  const d = meta.design;
  return {
    name,
    decisions: d?.decisions?.decisions ?? [],
    openQuestions: d?.decisions?.openQuestions ?? [],
    gaps: (d?.gaps ?? []).flatMap((g) => (g.requirementId || g.story ? [{ what: (g.requirementId ?? g.story)!, reason: g.reason }] : [])),
    assumptions: [],
    risks: d?.decisions?.risks ?? [],
  };
}

const kindName = (doc: Artifact) => (doc.kind === "backlog" ? "Backlog" : (doc.metadata as DesignMeta).artifactType === "detailed" ? "Detailed design" : "High-level design");

/** The default page title, masked like the artifact's. */
export const decisionsTitle = (artifactTitle: string) => `${artifactTitle}: requirements, decisions and open points`;

/**
 * The page's masked Markdown. The artifact comes first; when it is a backlog, the context's
 * designs follow, since the backlog follows their decisions.
 */
export function decisionsMarkdown(contexts: ContextRepository, requirements: RequirementRepository | undefined, context: string, doc: Artifact, title: string): { content: string; counts: Record<string, number> } {
  const sources: Source[] = [];
  const own = `${kindName(doc)} "${doc.title}"`;
  if (doc.kind === "backlog") sources.push(fromBacklog(own, (doc.metadata as { backlog?: Backlog }).backlog ?? { title: doc.title, epics: [] }));
  else sources.push(fromDesign(own, doc.metadata as DesignMeta));
  if (doc.kind === "backlog") {
    for (const d of contexts.documents(context)) {
      const meta = d.metadata as DesignMeta | undefined;
      if (d.kind === "design" && meta?.artifact && d.id !== doc.id && d.masked) sources.push(fromDesign(`${kindName(d as Artifact)} "${d.title}"`, meta));
    }
  }
  const confirmed = (requirements?.list(context) ?? []).filter((r) => r.status === "confirmed");

  const out: string[] = [`# ${oneLine(title)}`, "", `From the context's confirmed requirements and ${sources.map((s) => s.name).join(", ")} (version ${doc.metadata.version}).`, ""];
  const none = () => out.push("None recorded.", "");

  out.push("## Requirements", "");
  if (confirmed.length) {
    out.push("| Id | Requirement | Kind | Priority |", "| --- | --- | --- | --- |");
    for (const r of confirmed) out.push(`| ${r.id} | ${cell(r.statement)} | ${KIND[r.kind] ?? cell(r.kind)} | ${PRIORITY[r.priority] ?? cell(r.priority)} |`);
    out.push("");
  } else none();

  const decisions = sources.flatMap((s) => s.decisions.map((d) => ({ ...d, from: s.name })));
  out.push("## Decisions", "");
  if (decisions.length) {
    out.push("| Id | Decision | Choice | Reason | Requirements | From |", "| --- | --- | --- | --- | --- | --- |");
    for (const d of decisions) {
      const reason = sentences([d.reason, d.options?.length ? `Options considered: ${d.options.join("; ")}` : undefined, d.owner ? `Owner: ${d.owner}` : undefined]);
      out.push(`| ${d.id} | ${cell(d.title)} | ${cell(d.choice)} | ${cell(reason)} | ${cell(d.requirementIds?.join(", "))} | ${cell(d.from)} |`);
    }
    out.push("");
  } else none();

  const questions = sources.flatMap((s) => s.openQuestions.map((q) => ({ ...q, from: s.name })));
  out.push("## Open questions", "");
  if (questions.length) {
    out.push("| Question | Owner | From |", "| --- | --- | --- |");
    for (const q of questions) out.push(`| ${cell(q.question)} | ${cell(q.owner)} | ${cell(q.from)} |`);
    out.push("");
  } else none();

  out.push("## Open points", "");
  const gaps = sources.flatMap((s) => s.gaps.map((g) => ({ ...g, from: s.name })));
  const assumptions = sources.flatMap((s) => s.assumptions.map((a) => ({ a, from: s.name })));
  const risks = sources.flatMap((s) => s.risks.map((r) => ({ ...r, from: s.name })));
  if (!gaps.length && !assumptions.length && !risks.length) none();
  if (gaps.length) {
    out.push("### Not delivered or not addressed", "", "| Requirement or story | Reason | From |", "| --- | --- | --- |");
    for (const g of gaps) out.push(`| ${cell(g.what)} | ${cell(g.reason)} | ${cell(g.from)} |`);
    out.push("");
  }
  if (assumptions.length) {
    out.push("### Assumptions to confirm", "", "| Assumption | From |", "| --- | --- |");
    for (const x of assumptions) out.push(`| ${cell(x.a)} | ${cell(x.from)} |`);
    out.push("");
  }
  if (risks.length) {
    out.push("### Risks", "", "| Risk | Mitigation | From |", "| --- | --- | --- |");
    for (const r of risks) out.push(`| ${cell(r.risk)} | ${cell(r.mitigation)} | ${cell(r.from)} |`);
    out.push("");
  }
  return {
    content: out.join("\n").trimEnd() + "\n",
    counts: { requirements: confirmed.length, decisions: decisions.length, questions: questions.length, openPoints: gaps.length + assumptions.length + risks.length },
  };
}
