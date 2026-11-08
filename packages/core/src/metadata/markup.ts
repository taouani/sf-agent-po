// Visualforce pages and components, and email templates: what their merge fields and tags
// point at. Their text is not kept: pages and templates hold people's words.

import type { ComponentType, ParsedComponent, Ref } from "./model.js";
import { isCustomName, isStandardObject } from "./objects.js";

/** The files holding the markup of each type: Foo.page, Foo.component, Folder/Foo.email. */
export const MARKUP_SUFFIX: Readonly<Record<string, string>> = { ApexPage: ".page", ApexComponent: ".component", EmailTemplate: ".email" };

/** Larger markup is indexed by name only. */
export const MAX_MARKUP_LENGTH = 2_000_000;

const CUSTOM_FIELD = /^[A-Za-z_]\w*__(?:c|pc)$/i;
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(2).find((v) => v !== undefined)?.trim();

/**
 * A page, component or email template from its markup. Merge fields ({!Account.Foo__c},
 * {{{Recipient.Foo__c}}}) read the fields they name: on the page's standard controller, the
 * template's related and recipient types, or the object they start with. A field reached
 * through a controller's variable ({!wrapper.acc.Foo__c}) is linked by its name alone. The
 * controller, extensions, custom components and $ObjectType, $Label and $Setup names are
 * linked too.
 */
export function readMarkup(type: ComponentType, name: string, source: string, file: string): ParsedComponent {
  const attrs: Record<string, unknown> = {};
  if (source.length > MAX_MARKUP_LENGTH) return { type, name, file, attrs: { tooLarge: true }, text: "" };
  const refs: Ref[] = [];
  const seen = new Set<string>();
  const add = (ref: Ref) => {
    const id = JSON.stringify(ref).toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      refs.push(ref);
    }
  };
  const markup = source.replace(/<!--[\s\S]*?-->/g, " ");

  // The variables merge fields start with, and the objects they stand for.
  const context = new Map<string, string>();
  const head = /<(apex:page|apex:component|messaging:emailtemplate)\b[^>]*>/i.exec(markup)?.[0];
  if (head) {
    const standard = attr(head, "standardController");
    if (standard) {
      attrs.standardController = standard;
      context.set(standard.toLowerCase(), standard);
      add({ kind: "reads", object: standard });
    }
    const controller = attr(head, "controller");
    if (controller) attrs.controller = controller;
    for (const c of [controller, ...(attr(head, "extensions")?.split(",") ?? [])]) if (c?.trim()) add({ kind: "calls", type: "ApexClass", name: c.trim(), known: true });
    for (const [variable, typeAttr] of [["relatedto", "relatedToType"], ["recipient", "recipientType"]] as const) {
      const object = attr(head, typeAttr);
      if (object) {
        context.set(variable, object);
        add({ kind: "reads", object });
      }
    }
  }
  // Lightning email templates: Sender is the user sending, Organization the org.
  if (type === "EmailTemplate") {
    if (!context.has("sender")) context.set("sender", "User");
    if (!context.has("organization")) context.set("organization", "Organization");
  }

  for (const m of markup.matchAll(/<c:([A-Za-z_]\w*)\b/g)) add({ kind: "calls", type: "ApexComponent", name: m[1]!, known: true });
  for (const m of markup.matchAll(/<apex:include\b[^>]*>/gi)) {
    const page = attr(m[0], "pageName");
    if (page && /^[A-Za-z_]\w*$/.test(page)) add({ kind: "calls", type: "ApexPage", name: page, known: true });
  }

  const expressions = [...markup.matchAll(/\{!([^}]{1,4000})\}/g), ...markup.matchAll(/\{\{\{([^}]{1,1000})\}\}\}/g)].map((m) => m[1]!);
  for (const expression of expressions) {
    for (const m of expression.matchAll(/(?<![\w.$])(\$?[A-Za-z_]\w*)((?:\s*\.\s*[A-Za-z_]\w*)+)/g)) {
      const start = m[1]!;
      const segments = m[2]!.replace(/\s/g, "").slice(1).split(".");
      const lower = start.toLowerCase();
      if (lower === "$objecttype") {
        const [object, kind, member] = segments;
        if (/^fieldsets$/i.test(kind ?? "") && member) add({ kind: "reads", type: "FieldSet", name: `${object}.${member}` });
        else if (/^fields$/i.test(kind ?? "") && member) add({ kind: "reads", object: object!, path: member });
        else add({ kind: "reads", object: object! });
      } else if (lower === "$label") {
        add({ kind: "reads", type: "CustomLabel", name: segments[0]! });
      } else if (lower === "$setup") {
        add({ kind: "reads", object: segments[0]!, ...(segments[1] ? { path: segments[1] } : {}) });
      } else if (lower === "$user" || lower === "$organization") {
        add({ kind: "reads", object: lower === "$user" ? "User" : "Organization", path: segments.join(".") });
      } else if (lower.startsWith("$")) {
        continue;
      } else if (context.has(lower) || isCustomName(start) || isStandardObject(start)) {
        add({ kind: "reads", object: context.get(lower) ?? start, path: segments.join(".") });
      } else {
        for (const s of segments) if (CUSTOM_FIELD.test(s)) add({ kind: "reads", field: s });
      }
    }
  }
  return { type, name, file, attrs, refs, text: "" };
}
