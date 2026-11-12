// Record access: sharing rules, roles, public groups and queues. Who can see a record beyond
// its owner comes from these (with the org-wide defaults on each object). People are never
// kept: a queue's user members are taken out when it is retrieved, and the index keeps only
// the roles and groups it holds.

import type { ParsedComponent, Ref } from "./model.js";
import { list, obj, str } from "./xml.js";

/** What a rule shares to, or a queue holds: the element, and the type of what it names. */
const TARGETS: Record<string, string | undefined> = {
  group: "Group",
  role: "Role",
  roleAndSubordinates: "Role",
  roleAndSubordinatesInternal: "Role",
  portalRole: "Role",
  portalRoleAndSubordinates: "Role",
  queue: "Queue",
  publicGroup: "Group",
  roleAndSubordinate: "Role",
  roleAndSubordinateInternal: "Role",
  territory: undefined,
  territoryAndSubordinates: undefined,
  allInternalUsers: undefined,
  allCustomerPortalUsers: undefined,
  allPartnerUsers: undefined,
  guestUser: undefined,
  channelProgramGroup: undefined,
};

/** Words for each target element, as an architect says them. */
const WORDS: Record<string, string> = {
  group: "group",
  role: "role",
  roleAndSubordinates: "role and subordinates",
  roleAndSubordinatesInternal: "role and internal subordinates",
  portalRole: "portal role",
  portalRoleAndSubordinates: "portal role and subordinates",
  queue: "queue",
  territory: "territory",
  territoryAndSubordinates: "territory and subordinates",
  allInternalUsers: "all internal users",
  allCustomerPortalUsers: "all customer portal users",
  allPartnerUsers: "all partner users",
  guestUser: "the site guest user",
  channelProgramGroup: "channel program group",
  publicGroup: "group",
  roleAndSubordinate: "role and subordinates",
  roleAndSubordinateInternal: "role and internal subordinates",
};

/** "group Care_EU, role CEO" from a sharedTo or sharedFrom element, with refs to what it names. */
function targets(el: unknown, refs: Ref[]): string {
  const parts: string[] = [];
  for (const [key, v] of Object.entries(obj(el))) {
    const type = TARGETS[key];
    const names = list(v).map(str).filter((n): n is string => !!n);
    // An element with no name ("<allInternalUsers/>") stands for everyone it says. The site
    // guest user is named by its username: not kept.
    if (!names.length || key === "guestUser") {
      parts.push(WORDS[key] ?? key);
      continue;
    }
    for (const n of names) {
      parts.push(`${WORDS[key] ?? key} ${n}`);
      if (type) refs.push({ kind: "references", type, name: n });
    }
  }
  return parts.join(", ") || "(nobody)";
}

/** A literal in a rule, quoted as in the flow outline. */
const quote = (s: string) => `'${s.replace(/'/g, "\\'")}'`;

/**
 * The sharing rules of one object (sharingRules/Case.sharingRules): criteria rules read the
 * fields in their criteria, every rule grants access to the object's records, and names the
 * groups, roles and queues it shares to or from. The rules are kept in `attrs.rules`, and as
 * text in `body`, for an agent to read; their values are masked when a tool returns them.
 */
export function readSharingRules(object: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const refs: Ref[] = [{ kind: "grants", object }];
  const rules: Record<string, unknown>[] = [];
  const lines: string[] = [`SHARING RULES on ${object}`];
  const kinds: [string, string][] = [
    ["sharingCriteriaRules", "criteria"],
    ["sharingOwnerRules", "owner"],
    ["sharingGuestRules", "guest"],
    ["sharingTerritoryRules", "territory"],
  ];
  for (const [key, kind] of kinds) {
    for (const r of list(root[key]).map(obj)) {
      const name = str(r.fullName) ?? "?";
      const access = str(r.accessLevel);
      const related = obj(r.accountSettings);
      const also = (["caseAccessLevel", "contactAccessLevel", "opportunityAccessLevel"] as const)
        .map((k) => (str(related[k]) ? `${k.replace("AccessLevel", "")} ${str(related[k])}` : undefined))
        .filter(Boolean);
      const items = list(r.criteriaItems).map(obj);
      for (const c of items) {
        const field = str(c.field);
        if (field) refs.push({ kind: "reads", object, path: field });
        // Compared with another field of the record; "$User.Department" is the user's, not read here.
        const other = str(c.valueField);
        if (other && !other.startsWith("$")) refs.push({ kind: "reads", object, path: other });
      }
      const parts = items.map((c) => `${str(c.field) ?? "?"} ${str(c.operation) ?? "?"}${str(c.valueField) ? ` ${str(c.valueField)}` : str(c.value) !== undefined ? ` ${quote(str(c.value)!)}` : ""}`);
      const filter = str(r.booleanFilter);
      const criteria = parts.length ? (filter ? `${filter} where ${parts.map((p, i) => `${i + 1}: ${p}`).join("; ")}` : parts.join(" AND ")) : undefined;
      const to = targets(r.sharedTo, refs);
      const from = r.sharedFrom === undefined ? undefined : targets(r.sharedFrom, refs);
      rules.push(
        Object.fromEntries(
          Object.entries({ name, kind, label: str(r.label), access, alsoGives: also.length ? also.join(", ") : undefined, to, from, criteria }).filter(([, v]) => v !== undefined),
        ),
      );
      lines.push("", `${kind.toUpperCase()} RULE ${name}${str(r.label) && str(r.label) !== name ? ` "${str(r.label)}"` : ""}`);
      if (from) lines.push(`  records owned by ${from}`);
      if (criteria) lines.push(`  records where ${criteria}`);
      if (str(r.includeRecordsOwnedByAll) === "true") lines.push("  including records owned by high-volume users");
      lines.push(`  shared with ${to}: ${access ?? "?"}${also.length ? ` (and ${also.join(", ")})` : ""}`);
    }
  }
  return {
    type: "SharingRules",
    name: object,
    file,
    attrs: { object, rules, counts: Object.fromEntries(kinds.map(([k, kind]) => [kind, list(root[k]).length]).filter(([, n]) => n)) },
    refs,
    text: "",
    body: lines.join("\n"),
  };
}

/** A role: its parent in the hierarchy, and the access it gives to records its users' subordinates own. */
export function readRole(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const parent = str(root.parentRole);
  const refs: Ref[] = parent ? [{ kind: "references", type: "Role", name: parent }] : [];
  const attrs = Object.fromEntries(
    Object.entries({
      parentRole: parent,
      caseAccessLevel: str(root.caseAccessLevel),
      contactAccessLevel: str(root.contactAccessLevel),
      opportunityAccessLevel: str(root.opportunityAccessLevel),
      mayForecastManagerShare: str(root.mayForecastManagerShare),
    }).filter(([, v]) => v !== undefined),
  );
  return { type: "Role", name, label: str(root.name), file, attrs, refs, text: str(root.description) ?? "" };
}

/** A public group. Its members are data, not metadata: they are not retrieved. */
export function readGroup(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const attrs = Object.fromEntries(Object.entries({ doesIncludeBosses: str(root.doesIncludeBosses) }).filter(([, v]) => v !== undefined));
  return { type: "Group", name, label: str(root.name), file, attrs, refs: [], text: str(root.description) ?? "" };
}

/**
 * A queue: the objects whose records it can own, and the roles and groups among its members.
 * User members and the queue's email are taken out when it is retrieved.
 */
export function readQueue(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const refs: Ref[] = [];
  const objects = list(root.queueSobject)
    .map((q) => str(obj(q).sobjectType))
    .filter((o): o is string => !!o);
  for (const o of objects) refs.push({ kind: "references", object: o });
  const members: Record<string, string[]> = {};
  for (const [key, v] of Object.entries(obj(root.queueMembers))) {
    if (key === "users") continue;
    // <roles><role>CEO</role></roles>, <publicGroups><publicGroup>Care_EU</publicGroup></publicGroups>
    for (const inner of list(v).map(obj)) {
      for (const [k, names] of Object.entries(inner)) {
        const type = TARGETS[k];
        for (const n of list(names).map(str).filter((x): x is string => !!x)) {
          (members[WORDS[k] ?? k] ??= []).push(n);
          if (type) refs.push({ kind: "references", type, name: n });
        }
      }
    }
  }
  const attrs = Object.fromEntries(Object.entries({ objects, members: Object.keys(members).length ? members : undefined }).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
  return { type: "Queue", name, label: str(root.name), file, attrs, refs, text: str(root.description) ?? "" };
}
