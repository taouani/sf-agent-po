// The high-level design as Markdown, in the template's sixteen sections, from its JSON. The
// traceability table is computed from the requirement ids the sections cite.

import type { DiagramGraph } from "@sf-agent-po/connectors";
import type { Requirement } from "@sf-agent-po/core";
import { tracedItems, type HighLevelDesign } from "./schema.js";

export interface RequirementGap {
  requirementId: string;
  reason: string;
}

/** A table cell: one line, with its pipes escaped. */
export const cell = (v: string | number | undefined) => (v === undefined || v === "" ? "" : String(v).replace(/\r?\n+/g, " ").replace(/\|/g, "\\|"));

export function table(head: readonly string[], rows: readonly (readonly (string | number | undefined)[])[]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

/** Text on one line: a heading or a list item would end at a line break. */
export const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, " ").trim();
export const bullets = (items: readonly string[]) => items.map((i) => `- ${oneLine(i)}`).join("\n");
export const ids = (list: readonly string[]) => (list.length ? list.join(", ") : "");
export const NOT_DONE = "_Not written: this step failed its checks or was left out._";

/**
 * A Mermaid label, quoted: a quote or a pipe would end it. Brackets stay, inside the quotes, so
 * pseudonyms such as [ORG_1] are still found and replaced by their values when it is published.
 */
export const label = (s: string) => `"${s.replace(/"/g, "#quot;").replace(/\|/g, "#124;").replace(/\s+/g, " ").trim()}"`;

const SHAPE = { salesforce: ["[", "]"], external: ["[[", "]]"], user: ["([", "])"], data: ["[(", ")]"] } as const;

function diagram(d: NonNullable<NonNullable<HighLevelDesign["solution"]>["diagram"]>): string {
  // The agent's ids are only references: Mermaid gets its own (n1, n2...), which no reserved word or masking can break.
  const ids = new Map(d.nodes.map((n, i) => [n.id, `n${i + 1}`]));
  const lines = ["flowchart LR"];
  for (const n of d.nodes) {
    const [open, close] = SHAPE[n.kind];
    lines.push(`  ${ids.get(n.id)}${open}${label(n.label)}${close}`);
  }
  for (const e of d.edges) {
    const [from, to] = [ids.get(e.from), ids.get(e.to)];
    if (from && to) lines.push(`  ${from} -->${e.label ? `|${label(e.label)}|` : ""} ${to}`);
  }
  return `\`\`\`mermaid diagram=solution\n${lines.join("\n")}\n\`\`\``;
}

/** An ER diagram of the relationships, when every object name is an identifier Mermaid takes as it is. */
function erDiagram(objects: NonNullable<HighLevelDesign["dataModel"]>["objects"]): string | undefined {
  const pairs = objects.flatMap((o) => o.relationships.map((r) => ({ from: r.to.trim(), to: o.name.trim(), r })));
  // A name with a pseudonym in it would lose its brackets, and its value on publishing: no diagram then.
  if (!pairs.length || pairs.some((p) => !/^[A-Za-z]\w*$/.test(p.from) || !/^[A-Za-z]\w*$/.test(p.to))) return undefined;
  const lines = pairs.map((p) => `  ${p.from} ${p.r.kind === "master-detail" ? "||--|{" : "|o--o{"} ${p.to} : ${label(p.r.field)}`);
  return `\`\`\`mermaid diagram=data-model\nerDiagram\n${lines.join("\n")}\n\`\`\``;
}

/**
 * The diagrams of a high-level design by the name its Mermaid blocks carry ("```mermaid
 * diagram=solution"), as nodes and edges: Confluence shows them with the draw.io app.
 */
export function highLevelDiagrams(d: HighLevelDesign): Record<string, DiagramGraph> {
  const out: Record<string, DiagramGraph> = {};
  const s = d.solution?.diagram;
  if (s) out.solution = { nodes: s.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind })), edges: s.edges.map((e) => ({ from: e.from, to: e.to, label: e.label })) };
  const objects = d.dataModel?.objects ?? [];
  const pairs = objects.flatMap((o) => o.relationships.map((r) => ({ child: o.name.trim(), parent: r.to.trim(), r })));
  if (pairs.length) {
    const names = [...new Set(pairs.flatMap((p) => [p.parent, p.child]))];
    out["data-model"] = {
      nodes: names.map((name) => ({ id: name, label: name, kind: "object" })),
      // From the object that holds the field to the one it points to.
      edges: pairs.map((p) => ({ from: p.child, to: p.parent, label: `${p.r.field} (${p.r.kind})` })),
    };
  }
  return out;
}

export function renderHighLevelDesign(d: HighLevelDesign, requirements: readonly Requirement[], gaps: readonly RequirementGap[] = []): string {
  const out: string[] = [`# ${oneLine(d.title)}`];
  const section = (title: string, body: string | undefined) => out.push(`## ${title}\n\n${body?.trim() ? body.trim() : NOT_DONE}`);

  const c = d.context;
  section(
    "1. Context and scope",
    c &&
      [
        `**Goals**\n\n${bullets(c.goals)}`,
        `**In scope**\n\n${bullets(c.inScope)}`,
        `**Out of scope**\n\n${c.outOfScope.length ? bullets(c.outOfScope) : "Nothing stated."}`,
        `**Assumptions**\n\n${c.assumptions.length ? bullets(c.assumptions) : "None stated."}`,
      ].join("\n\n"),
  );
  section(
    "2. Personas and licences",
    c && table(["Persona", "Internal", "What they do", "Licence", "Users"], c.personas.map((p) => [p.name, p.internal ? "yes" : "no", p.does, p.licence, p.count])),
  );

  const cs = d.currentState;
  section(
    "3. Current state",
    cs &&
      [
        cs.summary,
        cs.components.length ? table(["Type", "Name", "Notes"], cs.components.map((x) => [x.type, x.name, x.notes])) : "",
        cs.debt.length ? `**Technical debt**\n\n${table(["Component", "Issue"], cs.debt.map((x) => [x.component, x.issue]))}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
  );

  const s = d.solution;
  section(
    "4. Solution overview",
    s &&
      [
        s.overview,
        `**Org strategy:** ${oneLine(s.orgStrategy)}`,
        table(["Id", "Component", "Type", "Status", "Purpose", "Requirements"], s.components.map((x) => [x.id, x.name, x.type, x.status, x.purpose, ids(x.requirementIds)])),
        s.diagram ? diagram(s.diagram) : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
  );

  const dm = d.dataModel;
  section(
    "5. Data model",
    dm &&
      (dm.objects.length
        ? [
            ...dm.objects.map((o) =>
              [
                `### ${oneLine(`${o.name}${o.label ? ` (${o.label})` : ""}: ${o.status}`)}`,
                o.whyNotStandard ? `Why not a standard object: ${o.whyNotStandard}` : "",
                o.volume ? `Volume: ${o.volume}` : "",
                o.recordTypes.length ? `Record types: ${o.recordTypes.join(", ")}` : "",
                o.fields.length ? table(["Field", "Type", "Status", "Description"], o.fields.map((f) => [f.name, f.type, f.status, f.description])) : "",
                o.relationships.length ? table(["Relationship", "To", "Kind", "Why"], o.relationships.map((r) => [r.field, r.to, r.kind, r.reason])) : "",
              ]
                .filter(Boolean)
                .join("\n\n"),
            ),
            erDiagram(dm.objects) ?? "",
          ]
            .filter(Boolean)
            .join("\n\n")
        : "No object is added or changed."),
  );

  const a = d.automation;
  section(
    "6. Automation and business logic",
    a &&
      (a.automations.length
        ? table(
            ["Id", "Automation", "Type", "Status", "Runs on", "Order", "What", "Why", "Requirements"],
            a.automations.map((x) => [x.id, x.name, x.type, x.status, [x.object, x.event].filter(Boolean).join(", "), x.order, x.what, x.why, ids(x.requirementIds)]),
          )
        : "No automation is added or changed."),
  );
  section("7. User experience", s ? (s.userExperience ?? "Nothing stated.") : undefined);

  const i = d.integrations;
  section(
    "8. Integrations",
    i &&
      (i.integrations.length
        ? table(
            ["Id", "System", "Direction", "Pattern", "Mechanism", "Volume and frequency", "Error handling", "Requirements"],
            i.integrations.map((x) => [x.id, x.system, x.direction, x.pattern, x.mechanism, [x.volume, x.frequency].filter(Boolean).join("; "), x.errorHandling, ids(x.requirementIds)]),
          )
        : "No integration."),
  );
  section("9. Reporting and analytics", s ? (s.reporting ?? "Nothing stated.") : undefined);

  const sec = d.security;
  section(
    "10. Security, sharing and compliance",
    sec &&
      [
        sec.sharing.length
          ? table(["Object", "Internal default", "External default", "Notes"], sec.sharing.map((x) => [x.object, x.internal, x.external, x.notes]))
          : "No sharing setting is changed.",
        sec.accessByPersona ? `**Access by persona:** ${oneLine(sec.accessByPersona)}` : "",
        sec.measures.length ? table(["Id", "Measure", "Requirements"], sec.measures.map((x) => [x.id, x.measure, ids(x.requirementIds)])) : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
  );
  section(
    "11. Non-functional requirements",
    sec && (sec.nonFunctional.length ? table(["Topic", "Target", "Requirements"], sec.nonFunctional.map((x) => [x.topic, x.target, ids(x.requirementIds)])) : "None stated."),
  );

  const im = d.impact;
  section(
    "12. Impact on the existing org",
    im && (im.changes.length ? table(["Type", "Component", "Change", "Risk", "Notes"], im.changes.map((x) => [x.type, x.name, x.change, x.risk, x.notes])) : "No existing component is changed."),
  );
  section("13. Delivery approach", im ? (im.delivery ?? "Nothing stated.") : undefined);

  const dc = d.decisions;
  section(
    "14. Decisions",
    dc &&
      (dc.decisions.length
        ? table(["Id", "Decision", "Options considered", "Choice", "Why", "Requirements"], dc.decisions.map((x) => [x.id, x.title, x.options.join("; "), x.choice, x.reason, ids(x.requirementIds)]))
        : "None recorded."),
  );
  section(
    "15. Risks, assumptions and open questions",
    dc &&
      [
        `**Risks**\n\n${dc.risks.length ? table(["Risk", "Mitigation"], dc.risks.map((x) => [x.risk, x.mitigation])) : "None recorded."}`,
        `**Assumptions**\n\n${c?.assumptions.length ? bullets(c.assumptions) : "See section 1."}`,
        `**Open questions**\n\n${dc.openQuestions.length ? table(["Question", "Who answers"], dc.openQuestions.map((x) => [x.question, x.owner])) : "None."}`,
      ].join("\n\n"),
  );

  const traced = tracedItems(d);
  const gapOf = new Map(gaps.map((g) => [g.requirementId, g.reason]));
  section(
    "16. Traceability",
    requirements.length
      ? table(
          ["Requirement", "Priority", "Statement", "Sources", "Addressed by"],
          requirements.map((r) => {
            const by = traced.filter((t) => t.requirementIds.includes(r.id)).map((t) => `${t.section}: ${t.item}`);
            const gap = gapOf.get(r.id);
            return [r.id, r.priority, r.statement, r.sourceIds.join(", "), by.length ? by.join("; ") : gap ? `Not addressed: ${gap}` : "Not addressed"];
          }),
        )
      : "No requirement was confirmed.",
  );
  return `${out.join("\n\n")}\n`;
}
