// Who can do what, and what users see: permission sets, profiles, permission set groups and
// page layouts.

import type { ParsedComponent, Ref } from "./model.js";
import { bool, list, obj, str } from "./xml.js";

const joinText = (...parts: (string | undefined)[]) => parts.filter((p): p is string => !!p && p.trim() !== "").join("\n");

/**
 * A permission set or profile. Each object, field, class, page, flow, record type, app,
 * custom permission and layout it gives access to is `grants`; how much is in attrs:
 * `objects` ("Account": "CRED" for create, read, edit, delete, plus V and M for view all and
 * modify all), `fields` ("Account.Industry": "read" or "edit") and `userPermissions` (API
 * names, such as ModifyAllData).
 */
export function readPermissions(type: "PermissionSet" | "Profile", name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const refs: Ref[] = [];
  const grant = (r: { object: string; path?: string } | { type: string; name: string }) => refs.push({ kind: "grants", ...r });
  const object = (full: string) => full.slice(0, full.indexOf("."));
  const rest = (full: string) => full.slice(full.indexOf(".") + 1);

  const objects: Record<string, string> = {};
  for (const o of list(root.objectPermissions).map(obj)) {
    const name = str(o.object);
    if (!name) continue;
    const level = [
      ["C", o.allowCreate],
      ["R", o.allowRead],
      ["E", o.allowEdit],
      ["D", o.allowDelete],
      ["V", o.viewAllRecords],
      ["M", o.modifyAllRecords],
    ]
      .filter(([, v]) => bool(v))
      .map(([k]) => k)
      .join("");
    if (!level) continue;
    objects[name] = level;
    grant({ object: name });
  }
  const fields: Record<string, string> = {};
  for (const f of list(root.fieldPermissions).map(obj)) {
    const full = str(f.field);
    if (!full?.includes(".")) continue;
    const level = bool(f.editable) ? "edit" : bool(f.readable) ? "read" : undefined;
    if (!level) continue;
    fields[full] = level;
    grant({ object: object(full), path: rest(full) });
  }
  const enabled = (items: unknown, key: string, flag: string, target: string) => {
    for (const i of list(items).map(obj)) {
      const n = str(i[key]);
      if (n && bool(i[flag])) grant({ type: target, name: n });
    }
  };
  enabled(root.classAccesses, "apexClass", "enabled", "ApexClass");
  enabled(root.pageAccesses, "apexPage", "enabled", "ApexPage");
  enabled(root.flowAccesses, "flow", "enabled", "Flow");
  enabled(root.customPermissions, "name", "enabled", "CustomPermission");
  enabled(root.recordTypeVisibilities, "recordType", "visible", "RecordType");
  enabled(root.applicationVisibilities, "application", "visible", "CustomApplication");
  for (const items of [root.customMetadataTypeAccesses, root.customSettingAccesses]) {
    for (const i of list(items).map(obj)) {
      const n = str(i.name);
      if (n && bool(i.enabled)) grant({ object: n });
    }
  }
  // Which layout a profile's users see, by record type.
  for (const a of list(root.layoutAssignments).map(obj)) {
    const layout = str(a.layout);
    if (layout) grant({ type: "Layout", name: layout });
  }
  const userPermissions = list(root.userPermissions)
    .map(obj)
    .filter((p) => bool(p.enabled))
    .map((p) => str(p.name))
    .filter((p): p is string => !!p)
    .sort();

  return {
    type,
    name,
    label: str(root.label),
    file,
    attrs: Object.fromEntries(
      Object.entries({
        license: str(root.license) ?? str(root.userLicense),
        custom: bool(root.custom),
        activationRequired: bool(root.hasActivationRequired),
        objects,
        fields,
        userPermissions,
      }).filter(([, v]) => v !== undefined && !(typeof v === "object" && Object.keys(v).length === 0)),
    ),
    refs,
    text: joinText(str(root.description)),
  };
}

/** A permission set group: the permission sets it includes, and those it mutes. */
export function readPermissionSetGroup(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const refs: Ref[] = [];
  for (const p of list(root.permissionSets)) {
    const n = str(p);
    if (n) refs.push({ kind: "includes", type: "PermissionSet", name: n });
  }
  for (const p of list(root.mutingPermissionSets)) {
    const n = str(p);
    if (n) refs.push({ kind: "includes", type: "MutingPermissionSet", name: n });
  }
  return { type: "PermissionSetGroup", name, label: str(root.label), file, attrs: {}, refs, text: joinText(str(root.description)) };
}

/**
 * A page layout ("Account-Account Layout"): part of its object, it `shows` the fields,
 * buttons, related lists (by their lookup field), Visualforce pages and quick actions on it.
 * Required and read-only fields are listed in attrs.
 */
export function readLayout(name: string, root: Record<string, unknown>, file: string): ParsedComponent {
  const dash = name.indexOf("-");
  const object = dash > 0 ? name.slice(0, dash) : undefined;
  const refs: Ref[] = [];
  const required: string[] = [];
  const readonly: string[] = [];
  for (const section of list(root.layoutSections).map(obj)) {
    for (const column of list(section.layoutColumns).map(obj)) {
      for (const item of list(column.layoutItems).map(obj)) {
        const field = str(item.field);
        if (field && object) {
          refs.push({ kind: "shows", object, path: field });
          const behavior = str(item.behavior);
          if (behavior === "Required") required.push(field);
          else if (behavior === "Readonly") readonly.push(field);
        }
        const page = str(item.page);
        if (page) refs.push({ kind: "shows", type: "ApexPage", name: page });
        const component = str(item.component);
        if (component?.startsWith("c:")) refs.push({ kind: "shows", type: ["LightningComponentBundle", "AuraDefinitionBundle"], name: component.slice(2) });
      }
    }
  }
  // Related lists name the child's lookup ("Claim__c.Policy__c"), or a standard list by name.
  for (const r of list(root.relatedLists).map(obj)) {
    const related = str(r.relatedList);
    if (related?.includes(".")) refs.push({ kind: "shows", object: related.slice(0, related.indexOf(".")), path: related.slice(related.indexOf(".") + 1) });
  }
  if (object) {
    for (const b of list(root.customButtons)) {
      const n = str(b);
      if (n) refs.push({ kind: "shows", type: "WebLink", name: `${object}.${n}` });
    }
  }
  for (const listEl of [obj(root.quickActionList), obj(root.platformActionList)]) {
    for (const a of list(listEl.quickActionListItems ?? listEl.platformActionListItems).map(obj)) {
      const action = str(a.quickActionName) ?? (str(a.actionType) === "QuickAction" ? str(a.actionName) : undefined);
      if (action) refs.push({ kind: "shows", type: "QuickAction", name: action });
    }
  }
  return {
    type: "Layout",
    name,
    ...(object ? { parent: object } : {}),
    file,
    attrs: Object.fromEntries(Object.entries({ object, required: required.sort(), readonly: readonly.sort() }).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))),
    refs,
    text: "",
  };
}
