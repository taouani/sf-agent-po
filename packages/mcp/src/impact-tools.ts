// Impact analysis (plan risk 4): for each component a piece of work adds, changes or deletes,
// what depends on it in the index, and the weak links: what the index cannot see (dynamic or
// unread Apex), inactive flows that would break once activated, dependents outside the scope
// the user confirmed, and the automation that saves records a new rule or required field can
// stop.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ComponentType, ContextRepository, IndexedComponent, Masker, MetadataIndex, Related, SnapshotInfo } from "@sf-agent-po/core";
import { z } from "zod";
import { line, pick, Pieces, readySources, sourceArg } from "./metadata-tools.js";
import type { CallContext } from "./review.js";
import { storedScope } from "./scope-tools.js";

type Text = { content: { type: "text"; text: string }[] };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });

export interface ImpactKit {
  index: MetadataIndex;
  contexts: ContextRepository;
  masker: Masker;
  guard: <A extends { context?: string }>(fn: (args: A, call: CallContext) => Promise<Text>) => (args: A, call: CallContext) => Promise<Text & { isError?: boolean }>;
  contextName: z.ZodDefault<z.ZodString>;
}

/** Components one call can analyse. */
const MAX_CHANGES = 30;
/** Dependents listed for one change. */
const MAX_DEPENDENTS = 100;
/** Dynamic Apex listed for one object. */
const MAX_BLIND = 15;

const CHANGES = ["add", "modify", "delete"] as const;
type Change = (typeof CHANGES)[number];

const VERB_IN: Record<string, string> = {
  references: "references it",
  reads: "reads it",
  writes: "writes it",
  triggers_on: "runs on its records",
  calls: "calls it",
  grants: "grants access to it",
  includes: "includes it",
  shows: "shows it",
  part_of: "belongs to it",
};

/** The object a component belongs to: itself for an object, its parent for a field or rule, or the object of "Object.Name". */
function objectOf(type: string, name: string, c?: IndexedComponent): string | undefined {
  if (type === "CustomObject") return c?.name ?? name;
  if (c?.parent && (c.parentType === undefined || c.parentType === "CustomObject")) return c.parent;
  if (["CustomField", "ValidationRule", "RecordType"].includes(type) && name.includes(".")) return name.split(".")[0];
  return undefined;
}

const inactive = (c: IndexedComponent) => c.type === "Flow" && typeof c.attrs.status === "string" && c.attrs.status !== "Active";

/** The scope's components (objects, children and members), by id, or undefined without a confirmed scope in this source. */
function scopeIds(kit: ImpactKit, context: string, snap: SnapshotInfo): Set<number> | undefined {
  const stored = storedScope(kit.contexts, context);
  if (!stored || stored.source !== snap.source) return undefined;
  const s = kit.index.scope(snap.id, stored.objects, { hops: 2, neighbours: false });
  return new Set([...s.objects, ...s.children, ...s.members.map((m) => m.component)].map((c) => c.id));
}

export function registerImpactTools(server: McpServer, kit: ImpactKit): void {
  const { index, guard, contextName } = kit;

  server.registerTool(
    "metadata_impact",
    {
      title: "Analyse the impact of changes",
      description:
        "For each component the work adds, changes or deletes (objects, fields, validation rules, flows, Apex...), lists what depends on it in the index, one or two links away, " +
        "and flags the weak links: Apex the index cannot follow (queries built from strings, classes named at run time), inactive flows that would break once activated, " +
        "dependents outside the confirmed scope, and the automation that saves records a new rule or required field can stop. Use it for the design's impact section and before a backlog.",
      inputSchema: {
        context: contextName,
        source: sourceArg,
        changes: z
          .array(
            z.object({
              type: z.string().describe('"CustomField", "ValidationRule", "Flow", "ApexClass", "CustomObject"...'),
              name: z.string().describe('The API name, e.g. "Policy__c.Status__c"; for a new component, the name it will have.'),
              change: z.enum(CHANGES).default("modify"),
            }),
          )
          .min(1)
          .max(MAX_CHANGES),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ context, source, changes }: { context: string; source?: string; changes: { type: string; name: string; change: Change }[] }) => {
      const stored = storedScope(kit.contexts, context);
      const snap = source ? pick(index, source) : (readySources(index).find((s) => s.source === stored?.source) ?? pick(index, undefined));
      const pieces = new Pieces(kit.masker, context);
      const scope = scopeIds(kit, context, snap);
      const blind = index.blindSpots(snap.id);
      const sections: string[] = [`Impact in ${snap.source}${scope ? ", against the scope the user confirmed" : " (no confirmed scope in this source, so nothing is flagged as outside it)"}.`];

      for (const ch of changes) {
        const real = pieces.real(ch.name);
        const c = index.component(snap.id, ch.type as ComponentType, real);
        const title = c ? (await line(pieces, c)).slice(2) : `${ch.type} ${await pieces.name(ch.type, ch.name)}`;
        const out: string[] = [`## ${ch.change === "add" ? "Add" : ch.change === "delete" ? "Delete" : "Change"} ${title}`];
        const flags: string[] = [];
        const object = objectOf(ch.type, real, c);

        if (!c && ch.change !== "add") {
          const word = (real.split(".").pop() ?? real).replace(/__c$/i, "");
          const near = index.search(snap.id, word || real, { types: [ch.type], limit: 5 });
          out.push(`Not in the index.${near.length ? ` Close matches:\n${(await Promise.all(near.map((n) => line(pieces, n)))).join("\n")}` : ""}`);
          sections.push(out.join("\n"));
          continue;
        }
        if (c && ch.change === "add") flags.push("It already exists: this is a change, not an addition.");
        if (c && scope && !scope.has(c.id)) flags.push("It is outside the scope the user confirmed.");
        if (c?.missing) flags.push("It is only referenced (a standard component not in the source): its own settings are not in the index.");

        // What depends on it: links coming in, one or two away. An object's own fields are its
        // parts; what depends on them is counted with the object.
        let dependents: Related[] = [];
        const grantedBy = new Map<string, number>();
        if (c) {
          if (c.type === "CustomObject") {
            const s = index.scope(snap.id, [c.name], { hops: 2, neighbours: false });
            dependents = s.members.map((m) => ({ component: m.component, kind: m.kinds[0]!, kinds: m.kinds, direction: "in" as const, depth: m.hop }));
            for (const [t, n] of Object.entries(s.grantedBy)) grantedBy.set(t, n);
            if (s.children.length) out.push(`It holds ${s.children.length} fields, rules and record types${ch.change === "delete" ? ", deleted with it" : ""}.`);
          } else dependents = index.related(c.id, { depth: 2 }).filter((r) => r.direction === "in" && r.kind !== "part_of");
        }
        const grants = dependents.filter((d) => d.kinds.length === 1 && d.kinds[0] === "grants");
        for (const g of grants) grantedBy.set(g.component.type, (grantedBy.get(g.component.type) ?? 0) + 1);
        const rest = dependents.filter((d) => !grants.includes(d));
        if (rest.length) {
          const shown = rest.slice(0, MAX_DEPENDENTS);
          const lines = await Promise.all(
            shown.map(async (d) => {
              const via = d.depth > 1 ? " (through one of the above)" : ` (${d.kinds.map((k) => VERB_IN[k] ?? k).join(", ")})`;
              const marks = [inactive(d.component) ? `inactive: ${String(d.component.attrs.status)}` : "", scope && !scope.has(d.component.id) ? "outside the scope" : ""].filter(Boolean);
              return `${await line(pieces, d.component)}${via}${marks.length ? ` [${marks.join("; ")}]` : ""}`;
            }),
          );
          out.push(`Depends on it (${rest.length}${rest.length > shown.length ? `, first ${shown.length}` : ""}):\n${lines.join("\n")}${rest.length > shown.length ? "\n- and more: narrow with metadata_component" : ""}`);
        } else if (c) out.push("Nothing in the index depends on it.");
        if (grantedBy.size) {
          out.push(`Access to it is given by ${[...grantedBy].map(([t, n]) => `${n} ${t}`).join(", ")}${ch.change === "add" ? "" : ": check that the change keeps the right people in and out"}.`);
        } else if (c && ["CustomField", "CustomObject", "ApexClass", "Flow"].includes(c.type) && ch.change !== "delete") flags.push("No permission set or profile in the index gives access to it.");

        // Weak links.
        const inactiveDeps = rest.filter((d) => inactive(d.component));
        if (inactiveDeps.length) flags.push(`${inactiveDeps.length} inactive flow(s) depend on it: they would break when activated, and are easy to forget.`);
        if (scope) {
          const outside = rest.filter((d) => !scope.has(d.component.id)).length;
          if (outside) flags.push(`${outside} dependent(s) are outside the scope the user confirmed: check them with the user, or widen the scope.`);
        }
        if (ch.change === "delete" && rest.length) flags.push(`Deleting it breaks or changes ${rest.length} component(s) above; Salesforce refuses the delete while some still reference it.`);
        if (object && (ch.change === "add" || ch.change === "modify") && ["ValidationRule", "CustomField", "CustomObject"].includes(ch.type)) {
          const writers = index.writersOf(snap.id, object).filter((w) => w.id !== c?.id);
          if (writers.length) {
            const names = await Promise.all(writers.slice(0, 20).map(async (w) => (await line(pieces, w)).slice(2)));
            flags.push(
              `${writers.length} component(s) save ${object} records, and a new or stricter rule, a required field or a changed type can make their saves fail: ${names.join("; ")}${writers.length > 20 ? "; ..." : ""}.`,
            );
          }
        }
        if (object) {
          const touching = new Set(
            index
              .scope(snap.id, [object], { hops: 1, neighbours: false })
              .members.map((m) => m.component.id),
          );
          const near = blind.filter((b) => touching.has(b.id));
          const others = blind.length - near.length;
          if (near.length)
            flags.push(
              `Apex that works on ${object} also does what the index cannot follow, so it may use this unseen: ${(await Promise.all(near.slice(0, MAX_BLIND).map(async (b) => `${(await line(pieces, b)).slice(2)} (${blindWhy(b)})`))).join("; ")}.`,
            );
          if (others) flags.push(`${others} other Apex class(es) or trigger(s) in the source build queries from strings, name classes at run time or were too large to read: search the code for ${object} before relying on this list.`);
        } else if (blind.length) flags.push(`${blind.length} Apex class(es) or trigger(s) in the source do what the index cannot follow: they may use it unseen.`);
        if (flags.length) out.push(`Weak links:\n${flags.map((f) => `- ${f}`).join("\n")}`);
        sections.push(out.join("\n\n"));
      }
      sections.push("The index does not see dynamic Apex, SOQL built from strings, long formula chains, reports and list views on fields, or anything outside Salesforce (integrations, ETL): say so where a conclusion depends on them.");
      return text(sections.join("\n\n"));
    }),
  );
}

function blindWhy(c: IndexedComponent): string {
  if (c.attrs.tooLarge) return "too large to read";
  return Array.isArray(c.attrs.dynamic) ? c.attrs.dynamic.join(", ") : "dynamic code";
}
