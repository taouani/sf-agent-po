// Visualforce pages and components, and email templates: what their merge fields and tags
// point at. Their text is not kept: pages and templates hold people's words.

import type { ComponentType, ParsedComponent, Ref } from "./model.js";
import { formulaCode, isCustomName, isStandardObject } from "./objects.js";

/** The files holding the markup of each type: Foo.page, Foo.component, Folder/Foo.email. */
export const MARKUP_SUFFIX: Readonly<Record<string, string>> = { ApexPage: ".page", ApexComponent: ".component", EmailTemplate: ".email" };

/** Larger markup is indexed by name only. */
export const MAX_MARKUP_LENGTH = 2_000_000;

const CUSTOM_FIELD = /^[A-Za-z_]\w*__(?:c|pc)$/i;
/** Who a Lightning email template's Recipient can be. */
const RECIPIENTS = ["Contact", "Lead", "User"];

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(2).find((v) => v !== undefined)?.trim();

/** The text between each `open` and the next `close`, found with indexOf so that unclosed ones cost linear time. */
function between(text: string, open: string, close: string, max: number): string[] {
  const out: string[] = [];
  for (let i = text.indexOf(open); i >= 0; ) {
    const end = text.indexOf(close, i + open.length);
    if (end < 0) break;
    if (end - i - open.length <= max) out.push(text.slice(i + open.length, end));
    i = text.indexOf(open, end + close.length);
  }
  return out;
}

/** The markup without its <!-- comments -->, in one pass. */
function withoutComments(text: string): string {
  const parts: string[] = [];
  let from = 0;
  for (let i = text.indexOf("<!--"); i >= 0; i = text.indexOf("<!--", from)) {
    parts.push(text.slice(from, i), " ");
    const end = text.indexOf("-->", i + 4);
    if (end < 0) return parts.join("");
    from = end + 3;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/** Each opening tag with one of these names, case ignored: its text up to the next ">". */
function tags(markup: string, lower: string, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    for (let i = lower.indexOf(`<${name}`); i >= 0; ) {
      const after = lower[i + name.length + 1];
      const end = markup.indexOf(">", i);
      if (end < 0) break;
      if (after === undefined || !/[\w:-]/.test(after)) out.push(markup.slice(i, end + 1));
      i = lower.indexOf(`<${name}`, end);
    }
  }
  return out;
}

/**
 * A page, component or email template from its markup (and, for a template, its subject and
 * plain text). Merge fields ({!Account.Foo__c}, {{{Recipient.Foo__c}}}) read the custom
 * fields they name: on the page's standard controller, the template's related and recipient
 * types, or the object they start with. A field reached through a controller's variable
 * ({!wrapper.rows[0].Foo__c}) is linked by its name alone. The controller, extensions, custom
 * components, pages, $ObjectType, $Label, $Setup, $Resource, $Permission and $CustomMetadata
 * names are linked too.
 */
export function readMarkup(type: ComponentType, name: string, source: string, file: string, extra = ""): ParsedComponent {
  const attrs: Record<string, unknown> = {};
  if (source.length + extra.length > MAX_MARKUP_LENGTH) return { type, name, file, attrs: { tooLarge: true }, text: "" };
  const refs: Ref[] = [];
  const seen = new Set<string>();
  const add = (ref: Ref) => {
    const id = JSON.stringify(ref).toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      refs.push(ref);
    }
  };
  const markup = withoutComments(source);
  const lower = markup.toLowerCase();

  // The variables merge fields start with, and the objects they stand for.
  const context = new Map<string, string>();
  const head = tags(markup, lower, ["apex:page", "apex:component", "messaging:emailtemplate"])[0];
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

  for (const m of markup.matchAll(/<c:([A-Za-z_]\w*)/g)) add({ kind: "calls", type: "ApexComponent", name: m[1]!, known: true });
  for (const tag of tags(markup, lower, ["apex:include", "apex:composition"])) {
    const page = attr(tag, "pageName") ?? attr(tag, "template");
    if (page && /^[A-Za-z_]\w*$/.test(page)) add({ kind: "calls", type: "ApexPage", name: page, known: true });
  }

  const all = `${markup}\n${extra}`;
  const expressions = [...between(all, "{!", "}", 4000), ...between(all, "{{{", "}}}", 1000)];
  for (const raw of expressions) {
    // Strings in an expression are people's words, not names.
    const expression = formulaCode(raw);
    for (const m of expression.matchAll(/(?<![\w.$\]])(\$?[A-Za-z_]\w*)((?:\s*\.\s*[A-Za-z_]\w*)+)/g)) {
      const start = m[1]!;
      const segments = m[2]!.replace(/\s/g, "").slice(1).split(".");
      const lowerStart = start.toLowerCase();
      /** A path's custom field at its end; a relationship (Claims__r) or a standard name only reads the object. */
      const path = (object: string, s: string[]) => {
        while (s.length && /__r$/i.test(s.at(-1)!)) s = s.slice(0, -1);
        add(s.length && CUSTOM_FIELD.test(s.at(-1)!) ? { kind: "reads", object, path: s.join(".") } : { kind: "reads", object });
      };
      if (lowerStart === "$objecttype") {
        const [object, kind, member] = segments;
        if (/^fieldsets$/i.test(kind ?? "") && member) add({ kind: "reads", type: "FieldSet", name: `${object}.${member}` });
        else if (/^fields$/i.test(kind ?? "") && member) add({ kind: "reads", object: object!, path: member });
        else add({ kind: "reads", object: object! });
      } else if (lowerStart === "$label") {
        add({ kind: "reads", type: "CustomLabel", name: segments[0]! });
      } else if (lowerStart === "$setup") {
        path(segments[0]!, segments.slice(1));
      } else if (lowerStart === "$custommetadata") {
        path(segments[0]!, segments.slice(2));
      } else if (lowerStart === "$user" || lowerStart === "$organization") {
        // $User.UITheme and the like are not fields.
        if (CUSTOM_FIELD.test(segments.at(-1)!)) path(lowerStart === "$user" ? "User" : "Organization", segments);
      } else if (lowerStart === "$page") {
        add({ kind: "calls", type: "ApexPage", name: segments[0]!, known: true });
      } else if (lowerStart === "$resource") {
        add({ kind: "reads", type: "StaticResource", name: segments[0]!, known: true });
      } else if (lowerStart === "$permission") {
        add({ kind: "reads", type: "CustomPermission", name: segments[0]!, known: true });
      } else if (lowerStart.startsWith("$")) {
        continue;
      } else if (context.has(lowerStart) || isCustomName(start) || isStandardObject(start)) {
        path(context.get(lowerStart) ?? start, segments);
      } else if (type === "EmailTemplate" && lowerStart === "recipient") {
        for (const s of segments) if (CUSTOM_FIELD.test(s)) add({ kind: "reads", field: s, among: RECIPIENTS });
      } else {
        for (const s of segments) if (CUSTOM_FIELD.test(s)) add({ kind: "reads", field: s });
      }
    }
    // rows[0].Foo__c, byKey[id].Foo__c: after an index, linked by name.
    for (const m of expression.matchAll(/\]\s*\.\s*([A-Za-z_]\w*__(?:c|pc))\b/gi)) add({ kind: "reads", field: m[1]! });
  }
  return { type, name, file, attrs, refs, text: "" };
}
