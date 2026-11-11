// The scope step (decision SC): the agent proposes the objects a piece of work touches, the
// user confirms them on the approval page, and the server adds what is linked to them, one or
// two hops away. The confirmed objects are kept with the context; what comes with them is
// computed from the index each time, so a new index is taken into account.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextRepository, EdgeKind, IndexedComponent, Masker, MetadataIndex, MetadataScope, SnapshotInfo } from "@sf-agent-po/core";
import { z } from "zod";
import type { ScopeChoice } from "./approval/server.js";
import type { Reviewer } from "./inputs.js";
import { line, pick, Pieces, readySources, sourceArg } from "./metadata-tools.js";
import type { CallContext } from "./review.js";

type Text = { content: { type: "text"; text: string }[] };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });

export interface ScopeKit {
  index: MetadataIndex;
  contexts: ContextRepository;
  masker: Masker;
  reviewerFor: (call: CallContext) => Reviewer;
  guard: <A extends { context?: string }>(fn: (args: A, call: CallContext) => Promise<Text>) => (args: A, call: CallContext) => Promise<Text & { isError?: boolean }>;
  contextName: z.ZodDefault<z.ZodString>;
}

/** What a context keeps: the objects the user confirmed, in which source. */
export interface StoredScope {
  source: string;
  objects: string[];
  confirmedAt: string;
}

/** Objects one proposal can hold. */
const MAX_OBJECTS = 30;
/** Objects suggested on the page. */
const MAX_SUGGESTED = 15;
/** Lines listed in each part of a scope. */
const MAX_LISTED = 300;
/** Fields, rules and record types listed for each object: metadata_component lists them all. */
const MAX_CHILDREN_EACH = 60;

const WORDS: Partial<Record<EdgeKind, string>> = {
  writes: "writes",
  reads: "reads",
  triggers_on: "runs on",
  calls: "calls or is called by",
  references: "references",
  shows: "shows",
  may_read: "may read, in a query built in strings",
};
const words = (kinds: readonly EdgeKind[]) => kinds.map((k) => WORDS[k] ?? k).join(", ");

export function storedScope(contexts: ContextRepository, context: string): StoredScope | undefined {
  const s = contexts.get(context)?.settings.scope as Partial<StoredScope> | undefined;
  return s && typeof s.source === "string" && Array.isArray(s.objects) && typeof s.confirmedAt === "string" ? (s as StoredScope) : undefined;
}

/** "14 fields, 2 rules, 3 flows, 1 Apex trigger": what comes with an object, counted. */
function counts(parts: readonly IndexedComponent[]): string {
  const n = new Map<string, number>();
  for (const c of parts) n.set(c.type, (n.get(c.type) ?? 0) + 1);
  const label: Record<string, [string, string]> = {
    CustomField: ["field", "fields"],
    ValidationRule: ["validation rule", "validation rules"],
    RecordType: ["record type", "record types"],
    Flow: ["flow", "flows"],
    ApexTrigger: ["Apex trigger", "Apex triggers"],
    ApexClass: ["Apex class", "Apex classes"],
    Layout: ["layout", "layouts"],
  };
  const rank = (type: string) => (type in label ? Object.keys(label).indexOf(type) : 99);
  const out = [...n]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([type, k]) => `${k} ${(label[type] ?? [type, `${type} components`])[k === 1 ? 0 : 1]}`);
  return out.length ? out.join(", ") : "nothing linked in the index";
}

/** What the page shows for one proposed object: its own scope, counted. */
function proposedChoice(index: MetadataIndex, snapshot: number, object: IndexedComponent): ScopeChoice {
  const own = index.scope(snapshot, [object.name], { hops: 1, neighbours: false });
  const elsewhere = own.members.filter((m) => m.component.parent && m.component.parent !== object.name).length;
  const linked = own.members.filter((m) => !(m.component.parent && m.component.parent !== object.name)).map((m) => m.component);
  const detail = counts([...own.children, ...linked]);
  return { name: object.name, ...(object.label ? { label: object.label } : {}), detail: elsewhere ? `${detail}; ${elsewhere} field(s) of other objects use it` : detail };
}

function suggestedChoice(n: MetadataScope["neighbours"][number]): ScopeChoice {
  const via = n.via.map((v) => `${v.component.type} ${v.component.name} (${words(v.kinds)})`).join("; ");
  return { name: n.object.name, ...(n.object.label ? { label: n.object.label } : {}), detail: `${n.links} link${n.links === 1 ? "" : "s"}: ${via}${n.links > n.via.length ? "; ..." : ""}` };
}

/** A scope as the model reads it, with labels, text-like names and reasons masked. */
async function describeScope(pieces: Pieces, snap: SnapshotInfo, scope: MetadataScope, header: string): Promise<string> {
  const capped = async <T>(items: readonly T[], each: (item: T) => Promise<string>) => {
    const shown = items.slice(0, MAX_LISTED);
    const lines = await Promise.all(shown.map(each));
    return `${lines.join("\n")}${items.length > shown.length ? `\n- and ${items.length - shown.length} more` : ""}`;
  };
  const out = [header, `Source: ${snap.source}`];
  out.push(`Objects (${scope.objects.length}):\n${await capped(scope.objects, (o) => line(pieces, o))}`);
  for (const o of scope.objects) {
    const own = scope.children.filter((c) => c.parent === o.name);
    if (!own.length) continue;
    const shown = own.slice(0, MAX_CHILDREN_EACH);
    const more = own.length > shown.length ? `\n- and ${own.length - shown.length} more: metadata_component lists them all` : "";
    out.push(`Fields, rules and record types of ${o.name} (${own.length}):\n${(await Promise.all(shown.map((c) => line(pieces, c)))).join("\n")}${more}`);
  }
  const near = scope.members.filter((m) => m.hop === 1);
  const far = scope.members.filter((m) => m.hop === 2);
  if (near.length) out.push(`Linked to them (${near.length}):\n${await capped(near, async (m) => `${await line(pieces, m.component)} (${words(m.kinds)})`)}`);
  if (far.length) out.push(`Called by or calling that automation (${far.length}):\n${await capped(far, async (m) => `${await line(pieces, m.component)} (${words(m.kinds)})`)}`);
  const grants = Object.entries(scope.grantedBy);
  if (grants.length) out.push(`Access is given by ${grants.map(([t, n]) => `${n} ${t}`).join(", ")}: open one with metadata_component to see how much.`);
  if (scope.neighbours.length)
    out.push(
      `Objects outside the scope that it touches (${scope.neighbours.length}); propose a new scope with them if the work needs them:\n${await capped(scope.neighbours, async (n) => {
        const via = await Promise.all(n.via.map(async (v) => `${(await line(pieces, v.component)).slice(2)} (${words(v.kinds)})`));
        return `${await line(pieces, n.object)}: ${n.links} link(s), such as ${via.join("; ")}`;
      })}`,
    );
  if (scope.unknown.length) out.push(`Not in the index: ${(await Promise.all(scope.unknown.map((u) => pieces.mask(u)))).join(", ")}.`);
  out.push("The index does not follow dynamic Apex, SOQL built from strings or long formula chains: read the code of such a class with metadata_code, and check with the user when a conclusion still depends on them.");
  return out.join("\n\n");
}

/** The source was indexed again or removed while the user decided: the user's choice could not be kept. */
export class SourceGoneError extends Error {
  constructor(source: string) {
    super(`${source} is not indexed any more, so the scope could not be kept. Index it again with metadata_index.`);
  }
}

/** What a scope proposal came to: `confirmed` when the user kept objects and the scope was stored. */
export interface ScopeOutcome {
  status: "confirmed" | "rejected" | "expired" | "empty";
  /** For the model, masked. */
  text: string;
  stored?: StoredScope;
}

/**
 * Asks the user to confirm the objects a piece of work touches, and keeps what they confirm
 * with the context (scope_propose, and the scope step of a workflow).
 */
export async function confirmScope(
  kit: Pick<ScopeKit, "index" | "contexts" | "masker" | "reviewerFor">,
  call: CallContext,
  context: string,
  { source, objects, reason }: { source?: string; objects: readonly string[]; reason?: string },
): Promise<ScopeOutcome> {
  const { index, contexts } = kit;
  const snap = pick(index, source);
  const proposal = index.scope(snap.id, objects, { hops: 2 });
  if (!proposal.objects.length) {
    const near = proposal.unknown.flatMap((u) => index.search(snap.id, u, { types: ["CustomObject"], limit: 3 }).map((c) => c.name));
    throw new Error(`None of these objects is in ${snap.source}: ${proposal.unknown.join(", ")}.${near.length ? ` Close matches: ${[...new Set(near)].join(", ")}.` : ""}`);
  }
  const decision = await kit.reviewerFor(call).review({
    kind: "scope",
    title: context,
    source: snap.source,
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
    proposed: proposal.objects.map((o) => proposedChoice(index, snap.id, o)),
    suggested: proposal.neighbours.slice(0, MAX_SUGGESTED).map(suggestedChoice),
  });
  const pieces = new Pieces(kit.masker, context);
  const comment = decision.comment ? `\nThe user's comment: ${await pieces.mask(decision.comment)}` : "";
  if (decision.status !== "approved") {
    const why = decision.status === "rejected" ? "The user rejected this scope" : "The user did not confirm the scope in time, or closed the page";
    return { status: decision.status === "rejected" ? "rejected" : "expired", text: `${why}; the context keeps ${storedScope(contexts, context) ? "its previous scope" : "no scope"}.${comment}` };
  }
  // The source may have been indexed again while the user decided: use its newest snapshot.
  const now = readySources(index).find((x) => x.source === snap.source);
  if (!now) throw new SourceGoneError(snap.source);
  const chosen = [...(decision.selected ?? []), ...(decision.added ?? [])];
  const confirmed = index.scope(now.id, chosen, { hops: 2 });
  const typedUnknown = (decision.added ?? []).filter((a) => confirmed.unknown.includes(a)).length;
  if (!confirmed.objects.length) {
    const typed = typedUnknown ? ` (the ${typedUnknown} object name(s) they typed are not in the index)` : "";
    return { status: "empty", text: `The user kept no object${typed}, so the context keeps ${storedScope(contexts, context) ? "its previous scope" : "no scope"}.${comment}` };
  }
  const stored: StoredScope = { source: now.source, objects: confirmed.objects.map((o) => o.name), confirmedAt: new Date().toISOString() };
  contexts.updateSettings(context, { scope: stored });
  const added = confirmed.objects.filter((o) => !proposal.objects.some((p) => p.id === o.id) && !decision.selected?.some((x) => x.toLowerCase() === o.name.toLowerCase())).map((o) => o.name);
  const ticked = confirmed.objects.filter((o) => !proposal.objects.some((p) => p.name === o.name) && decision.selected?.includes(o.name)).map((o) => o.name);
  const changed = [
    ...(ticked.length ? [`The user added linked objects: ${ticked.join(", ")}.`] : []),
    ...(added.length ? [`The user added: ${added.join(", ")}.`] : []),
    ...(typedUnknown ? [`${typedUnknown} object name(s) the user typed are not in the index.`] : []),
    ...proposal.objects.filter((o) => !decision.selected?.includes(o.name)).map((o) => `The user removed ${o.name}.`),
  ].join(" ");
  return { status: "confirmed", stored, text: await describeScope(pieces, now, { ...confirmed, unknown: [] }, `The user confirmed the scope of "${context}".${changed ? ` ${changed}` : ""}${comment}`) };
}

export function registerScopeTools(server: McpServer, kit: ScopeKit): void {
  const { index, contexts, guard, contextName } = kit;

  server.registerTool(
    "scope_propose",
    {
      title: "Propose the scope of the work",
      description:
        "Before a design or a backlog, proposes the objects the work touches (API names, from metadata_summary and metadata_search). " +
        "The user confirms them in their browser, can untick some and add others; the server then adds their fields, rules and record types, and the flows, triggers, code and layouts linked to them. " +
        "The confirmed scope is kept with the context: read it with scope_show. Call it again to change the scope.",
      inputSchema: {
        context: contextName,
        source: sourceArg,
        objects: z.array(z.string().min(1)).min(1).max(MAX_OBJECTS).describe('Object API names, e.g. ["Account", "Policy__c"].'),
        reason: z.string().max(2_000).optional().describe("Why these objects, in a sentence or two, shown to the user. Keep pseudonyms as they are."),
      },
      annotations: { readOnlyHint: false },
    },
    guard(async ({ context, source, objects, reason }: { context: string; source?: string; objects: string[]; reason?: string }, call) =>
      text((await confirmScope(kit, call, context, { source, objects, ...(reason !== undefined ? { reason } : {}) })).text),
    ),
  );

  server.registerTool(
    "scope_show",
    {
      title: "Show the scope of the work",
      description:
        "Shows the scope the user confirmed for a context: its objects, their fields, rules and record types, the flows, triggers, code and layouts linked to them (two hops), " +
        "who gives access, and the objects outside the scope that it touches. Labels are masked like any input.",
      inputSchema: { context: contextName },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ context }: { context: string }) => {
      const stored = storedScope(contexts, context);
      if (!stored) return text(`No scope is confirmed for "${context}" yet. Propose the objects the work touches with scope_propose.`);
      const snap = readySources(index).find((s) => s.source === stored.source);
      if (!snap) throw new Error(`The scope of "${context}" is in ${stored.source}, which is not indexed any more. Index it again with metadata_index, or propose a scope in another source.`);
      const scope = index.scope(snap.id, stored.objects, { hops: 2 });
      return text(await describeScope(new Pieces(kit.masker, context), snap, scope, `Scope of "${context}", confirmed by the user ${stored.confirmedAt}.`));
    }),
  );
}
