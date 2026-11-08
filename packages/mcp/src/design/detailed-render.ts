// The detailed design as Markdown, in the template's sections, from its JSON. The tests mapped
// to each acceptance criterion and the story traceability are computed from it.

import type { Requirement } from "@sf-agent-po/core";
import { storyItems, type DetailedDesign } from "./detailed-schema.js";
import { bullets, ids, NOT_DONE, table } from "./render.js";

export interface StoryGap {
  story: string;
  reason: string;
}

const yes = (b: boolean) => (b ? "yes" : "");

function sizeOf(f: { length?: number | undefined; precision?: number | undefined; scale?: number | undefined }): string {
  if (f.precision) return `${f.precision}${f.scale !== undefined ? `, ${f.scale}` : ""}`;
  return f.length ? String(f.length) : "";
}

export function renderDetailedDesign(d: DetailedDesign, requirements: readonly Requirement[], gaps: readonly StoryGap[] = []): string {
  const out: string[] = [`# ${d.title}`];
  const section = (title: string, body: string | undefined) => out.push(`## ${title}\n\n${body?.trim() ? body.trim() : NOT_DONE}`);
  const join = (parts: readonly (string | number | false | undefined)[]) => parts.filter(Boolean).join("\n\n");

  const sc = d.scope;
  section(
    "1. Scope",
    sc &&
      join([
        sc.summary,
        sc.highLevelDesignId && `Refines the high-level design ${sc.highLevelDesignId}.`,
        sc.backlogId && `Stories from the backlog ${sc.backlogId}.`,
        table(
          ["Story", "Summary", "Requirements", "Acceptance criteria"],
          sc.stories.map((s) => [s.ref, s.summary, ids(s.requirementIds), s.acceptanceCriteria.map((a) => `${a.id}: ${a.text}`).join("; ")]),
        ),
      ]),
  );

  const dm = d.dataModel;
  section(
    "2. Data model changes",
    dm &&
      (dm.objects.length
        ? dm.objects
            .map((o) =>
              join([
                `### ${o.name}${o.label ? ` (${o.label})` : ""}: ${o.status}`,
                o.fields.length &&
                  table(
                    ["Field", "Label", "Type", "Length", "Required", "Default", "Values", "External ID, unique", "Help text", "Classification", "Access"],
                    o.fields.map((f) => [
                      `${f.name} (${f.status})`,
                      f.label,
                      f.relationship ? `${f.type} to ${f.relationship.to}` : f.type,
                      sizeOf(f),
                      yes(f.required),
                      f.defaultValue,
                      f.valueSet ? `value set ${f.valueSet}` : f.picklistValues.join(", "),
                      [f.externalId && "external ID", f.unique && "unique"].filter(Boolean).join(", "),
                      f.helpText ?? f.description,
                      f.classification ? [f.classification.sensitivity, ...f.classification.compliance].join(", ") : "",
                      f.access.map((a) => `${a.permissionSet} (${a.edit ? "edit" : "read"})`).join(", "),
                    ]),
                  ),
                o.recordTypes.length && table(["Record type", "Status", "Description"], o.recordTypes.map((r) => [r.name, r.status, r.description])),
                o.validationRules.length && table(["Validation rule", "Status", "Error condition", "Message"], o.validationRules.map((v) => [v.name, v.status, v.condition, v.message])),
                o.layouts && `Layouts: ${o.layouts}`,
              ]),
            )
            .join("\n\n")
        : "No object is added or changed."),
  );

  const a = d.automation;
  section(
    "3. Automation",
    a &&
      (join([
        a.flows.length &&
          table(
            ["Id", "Flow", "Kind", "Status", "Runs on", "Entry criteria", "Run as", "Steps", "Fault handling", "Order"],
            a.flows.map((f) => [f.id, f.name, f.kind, f.status, [f.object, f.event, f.timing].filter(Boolean).join(", "), f.entryCriteria, f.runAs, f.steps.join("; "), f.faultHandling, f.order]),
          ),
        a.apex.length &&
          table(
            ["Id", "Apex", "Kind", "Status", "Runs on", "Responsibility", "Sharing", "User mode", "Async", "Bulk", "Test class"],
            a.apex.map((x) => [x.id, x.name, x.kind, x.status, [x.object, x.events.join(", ")].filter(Boolean).join(": "), x.responsibility, x.sharing, yes(x.userMode), yes(x.async), x.bulk, x.testClass]),
          ),
        a.orderNotes && `**Order of execution:** ${a.orderNotes}`,
      ]) || "No automation is added or changed."),
  );

  const ui = d.userInterface;
  section(
    "4. User interface",
    ui &&
      (join([
        ui.pages.length && table(["Page", "Kind", "Status", "Object", "Content"], ui.pages.map((p) => [p.name, p.kind, p.status, p.object, p.content])),
        ui.components.length &&
          table(["Component", "Kind", "Status", "Purpose", "Inputs", "Events"], ui.components.map((c) => [c.name, c.kind, c.status, c.purpose, c.inputs.join(", "), c.events.join(", ")])),
      ]) || "No user interface change."),
  );

  const i = d.integrations;
  section(
    "5. Integrations",
    i &&
      (i.integrations.length
        ? i.integrations
            .map((x) =>
              join([
                `### ${x.id} ${x.system} (${x.direction}, ${x.pattern})`,
                bullets(
                  [
                    x.endpoint && `Endpoint: ${x.endpoint}`,
                    `Authentication: ${x.authentication}${x.namedCredential ? `; Named Credential ${x.namedCredential}` : ""}${x.externalCredential ? `, External Credential ${x.externalCredential}` : ""}`,
                    x.integrationUser && `Integration user: ${x.integrationUser}`,
                    `Mapping: ${x.mapping}`,
                    `Errors: ${x.errorHandling}`,
                    x.retries && `Retries: ${x.retries}`,
                    x.logging && `Logging: ${x.logging}`,
                    x.limits && `Limits: ${x.limits}`,
                  ].filter((l): l is string => Boolean(l)),
                ),
              ]),
            )
            .join("\n\n")
        : "No integration."),
  );

  const sec = d.security;
  section(
    "6. Security",
    sec &&
      (join([
        sec.permissionSets.length &&
          table(["Permission set", "Status", "Purpose", "Grants", "Group"], sec.permissionSets.map((p) => [p.name, p.status, p.purpose, p.grants.join("; "), p.group])),
        sec.sharing.length &&
          table(["Object", "Internal default", "External default", "Sharing rules"], sec.sharing.map((x) => [x.object, x.internal, x.external, x.rules.join("; ")])),
        sec.customPermissions.length && table(["Custom permission", "Purpose"], sec.customPermissions.map((c) => [c.name, c.purpose])),
        sec.guestAccess && `**Guest access:** ${sec.guestAccess}`,
      ]) || "No security change."),
  );

  const t = d.tests;
  section(
    "7. Test approach",
    t &&
      (join([
        t.apex.length && table(["Apex test class", "Covers", "Scenarios"], t.apex.map((x) => [x.testClass, x.covers.join(", "), x.scenarios.join("; ")])),
        t.flows.length && table(["Flow test", "Scenarios"], t.flows.map((x) => [x.flow, x.scenarios.join("; ")])),
        t.acceptance.length && `**Acceptance**\n\n${table(["Story", "Criterion", "Kind", "Test"], t.acceptance.map((x) => [x.story, x.criterion, x.kind, x.test]))}`,
        t.data && `**Test data:** ${t.data}`,
      ]) || "No test is described."),
  );

  const dp = d.deployment;
  section(
    "8. Deployment",
    dp &&
      join([
        dp.components.length ? table(["Type", "Component", "Change", "Stories", "Notes"], dp.components.map((c) => [c.type, c.name, c.change, ids(c.stories), c.notes])) : "No component.",
        dp.preSteps.length && `**Before deploying**\n\n${bullets(dp.preSteps)}`,
        dp.postSteps.length && `**After deploying**\n\n${bullets(dp.postSteps)}`,
        dp.dataLoads.length && `**Data loads**\n\n${bullets(dp.dataLoads)}`,
        `**Rollback:** ${dp.rollback}`,
      ]),
  );

  const dc = d.decisions;
  section(
    "9. Open questions and risks",
    dc &&
      join([
        dc.decisions.length &&
          `**Decisions**\n\n${table(["Id", "Decision", "Options considered", "Choice", "Why", "Requirements"], dc.decisions.map((x) => [x.id, x.title, x.options.join("; "), x.choice, x.reason, ids(x.requirementIds)]))}`,
        `**Risks**\n\n${dc.risks.length ? table(["Risk", "Mitigation"], dc.risks.map((x) => [x.risk, x.mitigation])) : "None recorded."}`,
        `**Open questions**\n\n${dc.openQuestions.length ? table(["Question", "Who answers"], dc.openQuestions.map((x) => [x.question, x.owner])) : "None."}`,
      ]),
  );

  const items = storyItems(d);
  const gapOf = new Map(gaps.map((g) => [g.story, g.reason]));
  const statement = new Map(requirements.map((r) => [r.id, r.statement]));
  section(
    "10. Traceability",
    sc
      ? table(
          ["Story", "Requirements", "Built by", "Tests"],
          sc.stories.map((s) => {
            const by = items.filter((x) => x.stories.includes(s.ref)).map((x) => `${x.section}: ${x.item}`);
            const tests = (t?.acceptance ?? []).filter((x) => x.story === s.ref).map((x) => x.criterion);
            const gap = gapOf.get(s.ref);
            return [
              `${s.ref} ${s.summary}`,
              s.requirementIds.map((id) => (statement.has(id) ? `${id} ${statement.get(id)}` : id)).join("; "),
              by.length ? [...new Set(by)].join("; ") : gap ? `Not built here: ${gap}` : "Not built here",
              [...new Set(tests)].join(", "),
            ];
          }),
        )
      : undefined,
  );
  return `${out.join("\n\n")}\n`;
}
