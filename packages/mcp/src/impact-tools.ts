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
import { impactKey } from "./design/checks.js";

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
  may_read: "may read it: a query built in strings",
};

/** The object a component belongs to: itself for an object, its parent for a field or rule, or the object of "Object.Name". */
function objectOf(type: string, name: string, c?: IndexedComponent): string | undefined {
  if (type === "CustomObject") return c?.name ?? name;
  if (c?.parent && (c.parentType === undefined || c.parentType === "CustomObject")) return c.parent;
  if (["CustomField", "ValidationRule", "RecordType"].includes(type) && name.includes(".")) return name.split(".")[0];
  return undefined;
}

/** Types whose change is about who sees what. */
const ACCESS_TYPES = new Set(["PermissionSet", "Profile", "PermissionSetGroup", "MutingPermissionSet"]);

/** Reports, dashboards and report types: often many on one field, so counted apart and listed briefly. */
const ANALYTICS = new Set(["Report", "Dashboard", "ReportType"]);
/** Reports and dashboards named for one change. */
const MAX_ANALYTICS = 10;

/** The change event object of an object, which change data capture publishes: AccountChangeEvent, Policy__ChangeEvent. */
export function changeEventOf(object: string): string {
  return /__c$/i.test(object) ? `${object.slice(0, -3)}__ChangeEvent` : `${object}ChangeEvent`;
}

const inactive = (c: IndexedComponent) => c.type === "Flow" && typeof c.attrs.status === "string" && c.attrs.status !== "Active";

/** The scope's components (objects, children and members), by id, or undefined without a confirmed scope in this source. */
function scopeIds(kit: ImpactKit, context: string, snap: SnapshotInfo): Set<number> | undefined {
  const stored = storedScope(kit.contexts, context);
  if (!stored || stored.source !== snap.source) return undefined;
  const s = kit.index.scope(snap.id, stored.objects, { hops: 2, neighbours: false });
  // Every part of a scope object counts, standard fields only referenced included.
  const parts = s.objects.flatMap((o) => kit.index.children(snap.id, o.name));
  return new Set([...s.objects, ...parts, ...s.members.map((m) => m.component)].map((c) => c.id));
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
        "dependents outside the confirmed scope, the automation that saves records a new rule or required field can stop, the reports and dashboards that use it, " +
        "and the outside systems that receive it (outbound messages, change data capture). Use it for the design's impact section and before a backlog.",
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
      // What is the same for every change on one object is worked out and printed once.
      const perObject = new Map<string, { writers: IndexedComponent[]; touching: Set<number>; printed: { writers?: boolean; blind?: boolean } }>();
      const objectFacts = (object: string) => {
        let f = perObject.get(object.toLowerCase());
        if (!f) {
          f = {
            writers: index.writersOf(snap.id, object),
            touching: new Set(index.scope(snap.id, [object], { hops: 1, neighbours: false }).members.map((m) => m.component.id)),
            printed: {},
          };
          perObject.set(object.toLowerCase(), f);
        }
        return f;
      };

      const cdcPrinted = new Set<string>();
      for (const ch of changes) {
        const real = pieces.real(ch.name);
        const c = index.component(snap.id, ch.type as ComponentType, real);
        const title = c ? (await line(pieces, c)).slice(2) : `${ch.type} ${await pieces.name(ch.type, ch.name)}`;
        const out: string[] = [`## ${ch.change === "add" ? "Add" : ch.change === "delete" ? "Delete" : "Change"} ${title}`];
        const flags: string[] = [];
        // The object, to look things up (real) and to print (as the index names it, or masked as the model wrote it).
        const object = objectOf(ch.type, real, c);
        const objectShown = c ? object : await pieces.mask(objectOf(ch.type, ch.name) ?? "");

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

        // What depends on it: links coming in, one or two away. An object's parts come with it,
        // and what depends on them depends on the object.
        let dependents: Related[] = [];
        if (c) {
          const parts = c.type === "CustomObject" ? index.children(snap.id, c.name) : [];
          if (c.type === "CustomObject") {
            const n = (t: string) => parts.filter((p) => p.type === t && !p.missing).length;
            const other = parts.filter((p) => !p.missing && !["CustomField", "ValidationRule", "RecordType"].includes(p.type)).length;
            out.push(
              `It holds ${n("CustomField")} field(s), ${n("ValidationRule")} validation rule(s), ${n("RecordType")} record type(s)${other ? ` and ${other} other part(s) (layouts, list views, buttons...)` : ""}${ch.change === "delete" ? ", deleted with it" : ""}.`,
            );
          }
          dependents = index.dependents([c.id, ...parts.map((p) => p.id)]);
        }
        const isGrant = (d: Related) => d.depth === 1 && d.kinds.every((k) => k === "grants" || k === "includes");
        const grantedBy = new Map<string, number>();
        for (const g of dependents.filter(isGrant)) grantedBy.set(g.component.type, (grantedBy.get(g.component.type) ?? 0) + 1);
        const analytics = dependents.filter((d) => !isGrant(d) && ANALYTICS.has(d.component.type));
        const rest = dependents.filter((d) => !isGrant(d) && !ANALYTICS.has(d.component.type));
        if (rest.length) {
          const shown = rest.slice(0, MAX_DEPENDENTS);
          const lines = await Promise.all(
            shown.map(async (d) => {
              const via = d.depth > 1 ? " (through one of the above)" : ` (${d.kinds.map((k) => (k === "may_read" && d.component.type === "CustomObject" ? "its records name it: code that reads them may use it" : (VERB_IN[k] ?? k))).join(", ")})`;
              const marks = [inactive(d.component) ? `inactive: ${String(d.component.attrs.status)}` : "", scope && !scope.has(d.component.id) ? "outside the scope" : ""].filter(Boolean);
              return `${await line(pieces, d.component)}${via}${marks.length ? ` [${marks.join("; ")}]` : ""}`;
            }),
          );
          out.push(`Depends on it (${rest.length}${rest.length > shown.length ? `, first ${shown.length}` : ""}):\n${lines.join("\n")}${rest.length > shown.length ? "\n- and more: narrow with metadata_component" : ""}`);
        } else if (c && !analytics.length) out.push("Nothing in the index depends on it.");
        if (analytics.length) {
          const counts = (of: Related[]) => {
            const n = (t: string) => of.filter((a) => a.component.type === t).length;
            return [["Report", "report(s)"], ["Dashboard", "dashboard(s)"], ["ReportType", "report type(s)"]].filter(([t]) => n(t!)).map(([t, w]) => `${n(t!)} ${w}`).join(", ");
          };
          // Only the first link uses it: a report two links away is built on a report type that
          // offers it, or shows a field that reads it; a dashboard shows a report that uses it.
          const direct = analytics.filter((a) => a.depth === 1);
          const further = analytics.filter((a) => a.depth > 1);
          if (direct.length) {
            const named = await Promise.all(direct.slice(0, MAX_ANALYTICS).map(async (a) => (await line(pieces, a.component)).slice(2)));
            out.push(
              `Reports and report types that show, group, filter on or offer it (${counts(direct)})${ch.change === "delete" ? ": they lose the column or filter, and a report filtered on it can show more rows than before" : ": check their columns and filters still make sense"}. ` +
                `${direct.length > named.length ? `First ${named.length}` : "They are"}: ${named.join("; ")}${direct.length > named.length ? "; ..." : ""}.`,
            );
          }
          if (further.length) {
            out.push(
              `Two links away (${counts(further)}): dashboards that show those reports, reports built on those report types, and reports on fields that read it. They change only if what they show changes: narrow with metadata_component.`,
            );
          }
        }
        if (grantedBy.size) {
          out.push(`Access to it is given by ${[...grantedBy].map(([t, n]) => `${n} ${t}`).join(", ")}${ch.change === "add" ? "" : ": check that the change keeps the right people in and out"}.`);
        } else if (c && ["CustomField", "CustomObject", "ApexClass", "Flow"].includes(c.type) && ch.change !== "delete") flags.push("No permission set or profile in the index gives access to it.");
        // A permission set, profile or group: its impact is what it grants.
        if (c && ACCESS_TYPES.has(c.type)) {
          const given = index.related(c.id, { depth: 1, kinds: ["grants", "includes"] }).filter((r) => r.direction === "out");
          const byType = new Map<string, number>();
          for (const g of given) byType.set(g.component.type, (byType.get(g.component.type) ?? 0) + 1);
          out.push(given.length ? `It gives access to ${[...byType].map(([t, n]) => `${n} ${t}`).join(", ")}: whoever has it gains or loses that.` : "It gives access to nothing the index holds.");
        }

        // Weak links.
        // Outside systems that receive it: an outbound message sends the field, change data
        // capture or a platform event channel publishes the object's changes.
        const sent = rest.filter((d) => d.depth === 1 && d.component.type === "WorkflowOutboundMessage");
        if (sent.length && ch.change !== "add") {
          const names = await Promise.all(sent.slice(0, 10).map(async (d) => `${d.component.name}${typeof d.component.attrs.host === "string" ? ` to ${await pieces.mask(d.component.attrs.host)}` : ""}`));
          flags.push(`An outside system receives it through ${sent.length} outbound message(s) (${names.join("; ")}): the system on the other end must accept the change.`);
        }
        // Change events carry field values: a field or object change reaches subscribers (a new
        // field too), a rule or layout does not. Said once per object.
        const carried = ch.type === "CustomField" || (ch.type === "CustomObject" && ch.change !== "add");
        if (object && carried && !cdcPrinted.has(object.toLowerCase())) {
          cdcPrinted.add(object.toLowerCase());
          const event = index.component(snap.id, "CustomObject", changeEventOf(object));
          const channels = event ? index.related(event.id, { kinds: ["reads"] }).filter((r) => r.direction === "in" && r.component.type === "PlatformEventChannelMember") : [];
          if (channels.length) {
            const names = [...new Set(channels.map((r) => (typeof r.component.attrs.channel === "string" ? r.component.attrs.channel : r.component.name)))];
            flags.push(`Change data capture publishes ${objectShown} changes (channel ${names.join(", ")}): subscribers outside Salesforce receive this change and may need to handle it.`);
          }
        }
        // An active remote site setting: the Apex that calls its host with a URL written in the
        // code, which it allows (named credentials allow only callout:Name, so they are not here).
        if (c?.type === "RemoteSiteSetting" && c.attrs.active !== false && typeof c.attrs.host === "string" && ch.change !== "add") {
          const host = c.attrs.host;
          const sameHost = index.withHost(snap.id, host, 1_000);
          const otherSite = sameHost.some((h) => h.type === "RemoteSiteSetting" && h.id !== c.id && h.attrs.active !== false);
          const callers = sameHost.filter((h) => (h.type === "ApexClass" || h.type === "ApexTrigger") && Array.isArray(h.attrs.calloutHosts));
          if (callers.length && !otherSite) {
            const names = await Promise.all(callers.slice(0, 20).map(async (a) => (await line(pieces, a)).slice(2)));
            const what = ch.change === "delete" ? "their callouts fail once it is deleted" : "a changed URL, protocol or active flag can stop their callouts";
            flags.push(`${callers.length} Apex class(es) or trigger(s) call ${await pieces.mask(host)} with an endpoint written in the code, which this setting allows: ${what}. ${names.join("; ")}${callers.length > 20 ? "; ..." : ""}.`);
          }
        }
        const inactiveDeps = rest.filter((d) => inactive(d.component));
        if (inactiveDeps.length) flags.push(`${inactiveDeps.length} inactive flow(s) depend on it: they would break when activated, and are easy to forget.`);
        if (scope) {
          const outside = rest.filter((d) => !scope.has(d.component.id)).length;
          if (outside) flags.push(`${outside} dependent(s) are outside the scope the user confirmed: check them with the user, or widen the scope.`);
        }
        if (ch.change === "delete") {
          // A query built in strings does not stop the delete: the class fails when it runs.
          const weak = rest.filter((d) => d.depth === 1 && d.kinds.every((k) => k === "may_read"));
          const mappings = weak.filter((d) => d.component.type === "CustomObject").length;
          const code = weak.length - mappings;
          // Salesforce refuses the delete only for what references it directly and for sure.
          const blocking = rest.filter((d) => d.depth === 1 && !weak.includes(d)).length;
          if (blocking) flags.push(`Deleting it breaks or changes ${rest.length - weak.length} component(s) above; Salesforce refuses the delete while some still reference it.`);
          if (code) flags.push(`${code} class(es) may read it in a query built in strings: Salesforce does not stop the delete, and the query fails when it runs. Check their code with metadata_code.`);
          if (mappings) flags.push(`${mappings} custom metadata type(s) name it in their records: the code that reads them may fail once it is gone. Update or remove those records.`);
        }
        const facts = object ? objectFacts(object) : undefined;
        if (facts && (ch.change === "add" || ch.change === "modify") && ["ValidationRule", "CustomField", "CustomObject"].includes(ch.type)) {
          const writers = facts.writers.filter((w) => w.id !== c?.id);
          if (writers.length && facts.printed.writers) flags.push(`The ${writers.length} component(s) that save ${objectShown} records (listed above) can fail on it.`);
          else if (writers.length) {
            facts.printed.writers = true;
            const names = await Promise.all(writers.slice(0, 20).map(async (w) => (await line(pieces, w)).slice(2)));
            flags.push(
              `${writers.length} component(s) save ${objectShown} records, and a new or stricter rule, a required field or a changed type can make their saves fail: ${names.join("; ")}${writers.length > 20 ? "; ..." : ""}.`,
            );
          }
        }
        if (c && ACCESS_TYPES.has(c.type)) {
          // What it grants is listed above; code does not use a permission set by name.
        } else if (facts) {
          const near = blind.filter((b) => facts.touching.has(b.id));
          const others = blind.length - near.length;
          if (facts.printed.blind) {
            if (near.length || others) flags.push(`The Apex the index cannot follow (listed above for ${objectShown}) may use it unseen.`);
          } else {
            facts.printed.blind = true;
            if (near.length)
              flags.push(
                `Apex that works on ${objectShown} also does what the index cannot follow, so it may use this unseen: ${(await Promise.all(near.slice(0, MAX_BLIND).map(async (b) => `${(await line(pieces, b)).slice(2)} (${blindWhy(b)})`))).join("; ")}${near.length > MAX_BLIND ? "; ..." : ""}. Read their code with metadata_code (find the field or object name) to check.`,
              );
            if (others) flags.push(`${others} other Apex class(es) or trigger(s) in the source build queries from strings, name classes at run time or were too large to read: search the code for ${objectShown} before relying on this list.`);
          }
        } else if (blind.length) flags.push(`${blind.length} Apex class(es) or trigger(s) in the source do what the index cannot follow: they may use it unseen.`);
        if (flags.length) out.push(`Weak links:\n${flags.map((f) => `- ${f}`).join("\n")}`);
        sections.push(out.join("\n\n"));
      }
      await recordChecked(kit, context, changes);
      sections.push(
        "The index does not fully see dynamic Apex (a query built in strings is read as far as its strings show it, as \"may read\"), long formula chains, list views on fields, reports in private folders, endpoints built at run time, or what outside systems do with what they receive (middleware, ETL, API clients of connected apps). Read the code of a class it flags with metadata_code; say so where a conclusion still depends on what cannot be seen.",
      );
      return text(sections.join("\n\n"));
    }),
  );
}

/** Components metadata_impact remembers having looked at, per context: the newest ones. */
const MAX_CHECKED = 500;

/**
 * Remembers which components were looked at, and when, by a hash of type and real name: the design's
 * impact step sends back a change nobody ran metadata_impact on during the run.
 */
async function recordChecked(kit: ImpactKit, context: string, changes: readonly { type: string; name: string }[]): Promise<void> {
  const now = new Date().toISOString();
  const keys = changes.map((c) => impactKey(c.type, kit.masker.unmask(context, c.name).text));
  // Read and written in one transaction: another server on the same workspace may record too.
  kit.contexts.updateSettings(context, (current) => {
    const merged = { ...((current.impactChecked ?? {}) as Record<string, string>), ...Object.fromEntries(keys.map((k) => [k, now])) };
    const kept = Object.entries(merged)
      .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
      .slice(0, MAX_CHECKED);
    return { impactChecked: Object.fromEntries(kept) };
  });
}

function blindWhy(c: IndexedComponent): string {
  if (c.attrs.tooLarge) return "too large to read";
  return Array.isArray(c.attrs.dynamic) ? c.attrs.dynamic.join(", ") : "dynamic code";
}
