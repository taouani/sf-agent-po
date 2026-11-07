// Apex classes and triggers: the objects and fields they query and write, and the classes,
// flows and labels they use. Read from the source with a scanner, not a full parser: enough to
// find dependencies, and linear in the size of the file.

import type { ParsedComponent, Ref } from "./model.js";
import { isCustomName, isStandardObject } from "./objects.js";

/** Larger sources are not read for references (generated code): the class is still indexed. */
export const MAX_APEX_LENGTH = 1_000_000;

/** Apex words that can stand where a type or a variable would. */
const KEYWORDS = new Set(
  (
    "abstract after and as before break case catch class continue default delete do else enum extends false final finally for get global if implements " +
    "insert instanceof interface merge new null on or override private protected public return set static super switch testmethod this throw transient " +
    "trigger true try undelete update upsert virtual void webservice when while with without inherited sharing"
  ).split(" "),
);

const SOQL_WORDS = new Set(
  (
    "select from where and or not in like includes excludes order by group having limit offset asc desc nulls first last null true false with " +
    "security_enforced user_mode system_mode for update view reference all rows using scope typeof when then else end rollup cube above below at " +
    "data category tracking viewstat yesterday today tomorrow mine everything team delegated my_territory my_team_territory"
  ).split(" "),
);
/** SOQL date literals: LAST_WEEK, NEXT_N_DAYS:3 and the like. */
const DATE_LITERAL = /^(?:(?:last|this|next)_(?:week|month|quarter|year|fiscal_quarter|fiscal_year|90_days)|(?:last|next)_n_\w+|n_\w+_ago)$/i;

/**
 * The source with comments and string literals blanked out (same length, line breaks kept),
 * in one pass.
 */
export function apexCode(src: string): string {
  const out: string[] = [];
  let i = 0;
  let from = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      out.push(src.slice(from, i), blank(src.slice(i, stop)));
      i = from = stop;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out.push(src.slice(from, i), blank(src.slice(i, stop)));
      i = from = stop;
    } else if (c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== "'" && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, src.length);
      // The quotes stay, so that a string is still one token where it stood.
      out.push(src.slice(from, i), "'", blank(src.slice(i + 1, stop - 1)), stop - 1 > i ? "'" : "");
      i = from = stop;
    } else i++;
  }
  out.push(src.slice(from));
  return out.join("");
}

/** The inline SOQL queries in code ([SELECT ...]), with where each starts and ends. */
function soqlBlocks(code: string): { start: number; end: number; query: string }[] {
  const blocks: { start: number; end: number; query: string }[] = [];
  const open = /\[\s*select\b/gi;
  let m: RegExpExecArray | null;
  while ((m = open.exec(code))) {
    let depth = 0;
    let j = m.index;
    for (; j < code.length; j++) {
      if (code[j] === "[") depth++;
      else if (code[j] === "]" && --depth === 0) break;
    }
    blocks.push({ start: m.index, end: j, query: code.slice(m.index + 1, j) });
    open.lastIndex = j + 1;
  }
  return blocks;
}

/** A query's object and the fields it names (selected, filtered, sorted), subqueries left out. */
export function soqlFields(query: string): { object?: string; fields: string[] } {
  // Subqueries name child relationships, not fields of the object: dropped.
  const parts: string[] = [];
  const sub = /\(\s*select\b/gi;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = sub.exec(query))) {
    let i = m.index;
    for (let d = 0; i < query.length; i++) {
      if (query[i] === "(") d++;
      else if (query[i] === ")" && --d === 0) break;
    }
    parts.push(query.slice(at, m.index), " ");
    at = sub.lastIndex = i + 1;
  }
  parts.push(query.slice(at));
  const flat = parts.join("");
  const from = /\bfrom\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(flat);
  const fields = new Set<string>();
  // Identifiers and paths, not functions, bind variables (":acc.Id"), literals or keywords.
  const token = /(?<![\w.:'])([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?![\w(])(?!\s*\()(?!:\d)/g;
  for (const part of [flat.slice(0, from?.index ?? flat.length), from ? flat.slice(from.index + from[0].length) : ""]) {
    for (const t of part.matchAll(token)) {
      const word = t[1]!;
      const lower = word.toLowerCase();
      if (SOQL_WORDS.has(lower) || DATE_LITERAL.test(word)) continue;
      // An alias after an aggregate: COUNT(Id) total.
      let k = t.index - 1;
      while (k >= 0 && /\s/.test(part[k]!)) k--;
      if (part[k] === ")") continue;
      fields.add(word);
    }
  }
  return { ...(from ? { object: from[1] } : {}), fields: [...fields] };
}

/**
 * An Apex class or trigger from its source. Queries read their object and fields; DML writes
 * the object of the record or list it is given; `record.Field = x` writes a field and
 * `record.Field` reads it, for records whose type the code declares; classes, flows and
 * custom labels it names are linked. Comments are not kept: they can name people.
 */
export function readApex(type: "ApexClass" | "ApexTrigger", name: string, source: string, file: string): ParsedComponent {
  const refs: Ref[] = [];
  const attrs: Record<string, unknown> = { lines: source.split("\n").length };
  if (source.length > MAX_APEX_LENGTH) return { type, name, file, attrs: { ...attrs, tooLarge: true }, text: "" };
  let code = apexCode(source);
  const seen = new Set<string>();
  const add = (ref: Ref) => {
    const id = ("type" in ref ? `${ref.kind}|${String(ref.type)}|${ref.name}` : `${ref.kind}||${ref.object}|${ref.path ?? ""}`).toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      refs.push(ref);
    }
  };
  /** An object reference: certain for a custom or standard object name, else only if the project has it. */
  const objectRef = (kind: Ref["kind"], object: string, path?: string) =>
    add({ kind, object, ...(path ? { path } : {}), ...(isCustomName(object) || isStandardObject(object) ? {} : { known: true }) });

  if (type === "ApexTrigger") {
    const head = /\btrigger\s+[A-Za-z_]\w*\s+on\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/i.exec(code);
    if (head) {
      objectRef("triggers_on", head[1]!);
      attrs.object = head[1];
      attrs.events = head[2]!.split(",").map((e) => e.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean);
    }
  } else {
    const head = /\b(class|interface|enum)\s+[A-Za-z_]\w*/i.exec(code);
    if (head) attrs.kind = head[1]!.toLowerCase();
    const sharing = /\b(with|without|inherited)\s+sharing\b/i.exec(code);
    if (sharing) attrs.sharing = sharing[1]!.toLowerCase();
    if (/@\s*istest\b/i.test(code)) attrs.isTest = true;
  }

  // Queries: their object and fields are read; then they are blanked, so that their words
  // are not taken for variables.
  let queries = 0;
  let dml = 0;
  const blocks = soqlBlocks(code);
  for (const b of blocks) {
    queries++;
    const { object, fields } = soqlFields(b.query);
    if (!object) continue;
    objectRef("reads", object);
    // delete [SELECT ...], Database.update([SELECT ...]): the records queried are written.
    if (/(?:\b(?:insert|update|upsert|delete|undelete)\s+(?:as\s+(?:user|system)\s+)?|\bdatabase\s*\.\s*\w+\s*\(\s*)$/i.test(code.slice(Math.max(0, b.start - 40), b.start))) {
      objectRef("writes", object);
      dml++;
    }
    for (const f of fields) objectRef("reads", object, f);
  }
  if (queries) attrs.queries = queries;
  if (blocks.length) {
    const parts: string[] = [];
    let at = 0;
    for (const b of blocks) {
      parts.push(code.slice(at, b.start), " ".repeat(Math.min(b.end, code.length - 1) - b.start + 1));
      at = b.end + 1;
    }
    parts.push(code.slice(at));
    code = parts.join("");
  }

  // Declared types of variables, parameters and loop variables: Account a, List<Case> cs,
  // Policy__c[] ps, for (Contact c : contacts).
  const types = new Map<string, string>();
  const declaration = /(?<![\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*(?:<\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*>|\[\s*\])?\s+([A-Za-z_]\w*)\s*(?=[=;,):])/g;
  for (const m of code.matchAll(declaration)) {
    const declared = (m[2] ?? m[1]!).replace(/^schema\./i, "");
    if (KEYWORDS.has(declared.toLowerCase()) || KEYWORDS.has(m[3]!.toLowerCase())) continue;
    types.set(m[3]!.toLowerCase(), declared);
  }
  const typeOf = (variable: string) => types.get(variable.toLowerCase());
  const sobject = (t: string | undefined): t is string => !!t && !/^(?:s?object|string|id|integer|long|decimal|double|boolean|date|datetime|time|blob)$/i.test(t);

  // DML: insert acc; update as user cases; Database.upsert(new List<Account>{...}).
  const statement = /\b(insert|update|upsert|delete|undelete|merge)\s+(?:as\s+(?:user|system)\s+)?(?:new\s+(?:list\s*<\s*([\w.]+)\s*>|([\w.]+))|([A-Za-z_]\w*))/gi;
  const method = /\bdatabase\s*\.\s*(insert|update|upsert|delete|undelete|merge)\w*\s*\(\s*(?:new\s+(?:list\s*<\s*([\w.]+)\s*>|([\w.]+))|([A-Za-z_]\w*))/gi;
  for (const re of [statement, method]) {
    for (const m of code.matchAll(re)) {
      // "update" after a dot or in "for update" is not DML.
      if (/[.]\s*$/.test(code.slice(Math.max(0, m.index - 2), m.index))) continue;
      const object = m[2] ?? m[3] ?? typeOf(m[4]!);
      if (!sobject(object) || KEYWORDS.has(object.toLowerCase())) continue;
      dml++;
      objectRef("writes", object.replace(/^schema\./i, ""));
    }
  }
  if (dml) attrs.dml = dml;

  // new Account(Name = 'x', Industry = y): the fields are set.
  for (const m of code.matchAll(/\bnew\s+([A-Za-z_][\w.]*)\s*\(([^()]*)\)/g)) {
    const object = m[1]!.replace(/^schema\./i, "");
    if (!isCustomName(object) && !isStandardObject(object)) continue;
    for (const f of m[2]!.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*=(?!=)/g)) objectRef("writes", object, f[1]!);
  }

  // record.Field, record.Lookup__r.Field = x: through a variable of a declared record type.
  // Method calls end the path.
  const access = /(?<![\w.])([A-Za-z_]\w*)((?:\s*\.\s*[A-Za-z_]\w*(?!\w|\s*\())+)(\s*=(?!=))?/g;
  for (const m of code.matchAll(access)) {
    const head = m[1]!;
    const path = m[2]!.replace(/\s+/g, "").slice(1);
    const lower = head.toLowerCase();
    if (lower === "schema") {
      // Schema.SObjectType.Policy__c.fields.Status__c, Schema.Policy__c.Status__c.
      const s = /^(?:sobjecttype\.)?([A-Za-z_]\w*)(?:\.fields)?(?:\.([A-Za-z_]\w*))?/i.exec(path);
      if (s) objectRef("reads", s[1]!, s[2] && !/^sobjecttype$/i.test(s[2]) ? s[2] : undefined);
      continue;
    }
    if (lower === "label" || (lower === "system" && /^label\./i.test(path))) {
      const label = path.replace(/^label\./i, "").split(".")[0]!;
      add({ kind: "reads", type: "CustomLabel", name: label });
      continue;
    }
    if (lower === "flow" && /^interview\.[A-Za-z_]/i.test(path)) {
      add({ kind: "calls", type: "Flow", name: path.split(".")[1]! });
      continue;
    }
    const declared = typeOf(head);
    if (sobject(declared) && !KEYWORDS.has(lower)) {
      objectRef(m[3] ? "writes" : "reads", declared.replace(/^schema\./i, ""), path);
    } else if (isCustomName(head)) {
      // Policy__c.Status__c.getDescribe(), Settings__c.getInstance(): the object, and its field.
      const field = path.split(".")[0]!;
      objectRef("reads", head, /^sobjecttype$/i.test(field) ? undefined : field);
    }
  }
  // Custom settings and metadata read by method: Settings__c.getInstance().
  for (const m of code.matchAll(/(?<![\w.])([A-Za-z_]\w*__(?:c|mdt))\s*\.\s*get\w*\s*\(/gi)) objectRef("reads", m[1]!);

  // Classes it names: Foo.bar(), new Foo(), Foo x, extends Foo. Only those the project has.
  const self = name.toLowerCase();
  const classes = new Set<string>();
  for (const re of [/(?<![\w.])([A-Za-z_]\w*)\s*\./g, /\bnew\s+([A-Za-z_]\w*)/gi, /\b(?:extends|implements)\s+([A-Za-z_]\w*)/gi]) {
    for (const m of code.matchAll(re)) classes.add(m[1]!);
  }
  for (const t of types.values()) classes.add(t.split(".")[0]!);
  for (const c of classes) {
    const lower = c.toLowerCase();
    if (lower === self || KEYWORDS.has(lower) || isCustomName(c)) continue;
    add({ kind: "calls", type: "ApexClass", name: c, known: true });
  }

  return { type, name, file, attrs, refs, text: "" };
}
