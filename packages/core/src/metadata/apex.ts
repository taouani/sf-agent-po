// Apex classes and triggers: the objects and fields they query and write, and the classes,
// flows and labels they use. Read from the source with a scanner, not a full parser: enough to
// find dependencies, and linear in the size of the file.

import type { ParsedComponent, Ref } from "./model.js";
import { isCustomName, isStandardObject } from "./objects.js";
import { hostOf } from "./integrations.js";

/** Larger sources are not read for references (generated code): the class is still indexed. */
export const MAX_APEX_LENGTH = 1_000_000;

/** Apex words that can stand where a type or a variable would. */
const KEYWORDS = new Set(
  (
    "abstract after and as before break catch class continue default delete do else enum extends false final finally for get global if implements " +
    "insert instanceof interface merge new null on or override private protected public return set static super switch testmethod this throw transient " +
    "trigger true try undelete update upsert virtual void webservice when while with without inherited sharing"
  ).split(" "),
);

const SOQL_WORDS = new Set(
  (
    "select from where and or not in like includes excludes order by group having limit offset asc desc nulls first last null true false with " +
    "security_enforced user_mode system_mode for update view reference all rows using scope typeof when then else end rollup cube above below at " +
    "data category tracking viewstat yesterday today tomorrow mine everything team delegated my_territory my_team_territory " +
    "mine_and_my_groups standard custom"
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

/**
 * What replaces a secret written in code: a constant's name, which the masking rules take for
 * a reference rather than a value, so it is shown as it is.
 */
export const HIDDEN_SECRET = "HIDDEN_SECRET";
/** Names of what holds a secret: a variable, a constant, a header, a parameter, a JSON or XML key. */
const SECRET_WORDS =
  String.raw`pass(?:word|wd|phrase)?|pwd|pw\b|secret|token|credentials?|signature|authorization|auth\b|auth[_-]?(?:header|key|token)|cookie|sid\b|session[_-]?id|` +
  String.raw`(?:api|private|access|secret|crypto|encryption|hmac|signing|subscription|aes|master|consumer|app|auth)[_-]?key`;
/** A string just after such a name: `apiKey = '`, `setHeader('Authorization', '`, `put('password', '`, `cryptoKey = EncodingUtil.base64Decode('`. */
const AFTER_SECRET_NAME = new RegExp(String.raw`(?:${SECRET_WORDS})[\w-]*'?\s*(?:=>?|,|:)\s*(?:[\w.]+\(\s*)*$`, "i");
/** Inside a string: a URL or form parameter (`?apikey=...`), a JSON value (`"password":"..."`), an XML element. */
const SECRET_PARAM = new RegExp(String.raw`((?:^|[?&;\s])[\w.-]*(?:${SECRET_WORDS}|key|sig)=)[^&#\s;]+`, "gi");
const SECRET_JSON = new RegExp(String.raw`("[\w.-]*(?:${SECRET_WORDS})[\w.-]*"\s*:\s*")[^"]+`, "gi");
const SECRET_XML = new RegExp(String.raw`(<([\w:.-]*(?:${SECRET_WORDS})[\w.-]*)>)[^<]+(?=</\2>)`, "gi");
/** A credential after an auth scheme, anywhere in a string: "Bearer ...", "Authorization: Basic ...". */
const SCHEME_TOKEN = /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/-]{8,}=*/g;
/** API names and other values that only name something: kept, they are what dynamic Apex needs. */
const NAMES_SOMETHING = /(?:__(?:c|mdt|e|r|x|b|kav|share|history)$|^(?:callout|https?):|^\s*(?:Bearer|Basic|OAuth|Token)\s*$)/i;
const NAMES_A_SECRET = new RegExp(SECRET_WORDS, "i");

/** A string's value with what looks like a secret in it hidden, given the code just before it. */
function hideInString(value: string, before: string): string {
  if (value.length < 4) return value;
  let hidden = value.replace(SECRET_PARAM, `$1${HIDDEN_SECRET}`).replace(SECRET_JSON, `$1${HIDDEN_SECRET}`).replace(SECRET_XML, `$1${HIDDEN_SECRET}`).replace(SCHEME_TOKEN, `$1${HIDDEN_SECRET}`);
  // A parameter's name ("client_secret=") is kept; base64 padding ("...Q=") is not a name.
  if (hidden !== value || NAMES_SOMETHING.test(value) || (/^(?:[a-z]+(?:[_-][a-z]+)*|[A-Z]+(?:[_-][A-Z]+)*)[=:]$/.test(value) && NAMES_A_SECRET.test(value))) return hidden;
  const context = before.replace(/\s+/g, " ");
  // A message about a secret ("Enter your password") is not one.
  const message = /\s/.test(value.trim()) && NAMES_A_SECRET.test(value);
  if (!message && AFTER_SECRET_NAME.test(context)) hidden = HIDDEN_SECRET;
  // The password of "user:password", or the part after `':' +`, for Basic credentials built in code.
  else if (/Blob\.valueOf\(\s*$/.test(context) && /^[^\s:]+:\S+$/.test(value)) hidden = value.replace(/:.*$/, `:${HIDDEN_SECRET}`);
  else if (/':'\s*\+\s*$/.test(context)) hidden = HIDDEN_SECRET;
  return hidden;
}

/** The strings of some text (code, or the text of a comment) with their secrets hidden. */
function hideInStrings(text: string, code: boolean): string {
  const out: string[] = [];
  let i = 0;
  let from = 0;
  while (i < text.length) {
    const c = text[i];
    if (code && c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      // Commented-out code holds secrets too: the strings of a comment are read the same way.
      const end = text[i + 1] === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : text[i + 1] === "/" ? end : end + 2;
      out.push(text.slice(from, i), hideInStrings(text.slice(i, stop), false));
      i = from = stop;
    } else if (c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== "'" && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      const stop = Math.min(j, text.length);
      // The code before the string, a line or two back (a header name on the line above).
      out.push(text.slice(from, i + 1), hideInString(text.slice(i + 1, stop), text.slice(Math.max(0, i - 160), i)));
      from = stop;
      i = stop + 1;
    } else i++;
  }
  out.push(text.slice(from));
  return out.join("");
}

/**
 * Apex code with the secrets written in its strings hidden, before it is kept: a string just
 * after something named like a secret (`String apiKey = '...'`, `setHeader('Authorization', '...')`),
 * a secret parameter, JSON value or XML element inside a string, the credential after "Bearer" or
 * "Basic", and the password of Basic credentials built in code. The strings of comments are read
 * the same way. The rest stays, to be masked like any input when a tool returns it. This finds the
 * usual forms, not every one: the masking rules look for known token formats on the way out.
 */
export function hideCodeSecrets(src: string): string {
  const hidden = hideInStrings(src, true);
  return hidden === src ? src : hidden;
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

/** The end of the parenthesised group opening at `open`, or -1; looks no further than `limit`. */
function closing(text: string, open: number, limit = text.length): number {
  const stop = Math.min(text.length, limit);
  for (let i = open, d = 0; i < stop; i++) {
    if (text[i] === "(") d++;
    else if (text[i] === ")" && --d === 0) return i;
  }
  return -1;
}

/**
 * Bind expressions blanked: ":acc.Id", ":String.escapeSingleQuotes(term)", ": ids[0]" are Apex,
 * not fields. Date literals (LAST_N_DAYS:7) keep their number.
 */
function withoutBinds(query: string): string {
  const out: string[] = [];
  let at = 0;
  for (let i = query.indexOf(":"); i >= 0; i = query.indexOf(":", i + 1)) {
    let j = i + 1;
    while (query[j] === " ") j++;
    if (/\d/.test(query[j] ?? "")) continue;
    for (let d = 0; j < query.length; j++) {
      const c = query[j]!;
      if (c === "(" || c === "[") d++;
      else if ((c === ")" || c === "]") && d > 0) d--;
      else if (d === 0 && !/[\w.]/.test(c)) break;
    }
    out.push(query.slice(at, i), " ");
    at = j;
    i = j - 1;
  }
  out.push(query.slice(at));
  return out.join("");
}

export interface SoqlReads {
  object?: string;
  fields: string[];
  /** Semi-joins and anti-joins (WHERE Id IN (SELECT AccountId FROM Opportunity)): other objects read. */
  joins: { object: string; fields: string[] }[];
}

/**
 * A query's object and the fields it names (selected, filtered, sorted). Subqueries in the
 * select list name child relationships and are left out; those after FROM are semi-joins, read
 * as queries of their own. TYPEOF clauses, bind expressions, functions, aliases and date
 * literals are not fields. A query built in a string (Database.query) is not read.
 */
export function soqlFields(query: string, depth = 0): SoqlReads {
  const text = withoutBinds(query.replace(/\s+/g, " ")).replace(/\btypeof\b.{0,2000}?\bend\b/gi, " ");
  const parts: string[] = [];
  const joins: SoqlReads["joins"] = [];
  const sub = /\( ?select\b/gi;
  let at = 0;
  let afterFrom = false;
  let m: RegExpExecArray | null;
  while ((m = sub.exec(text))) {
    const before = text.slice(at, m.index);
    afterFrom ||= /\bfrom\b/i.test(before);
    const end = closing(text, m.index);
    const stop = end < 0 ? text.length : end;
    if (afterFrom && depth < 2) {
      const inner = soqlFields(text.slice(m.index + 1, stop), depth + 1);
      if (inner.object) joins.push({ object: inner.object, fields: inner.fields }, ...inner.joins);
    }
    parts.push(before, " ");
    at = sub.lastIndex = stop + 1;
  }
  parts.push(text.slice(at));
  const flat = parts.join("");
  const from = /\bfrom ([A-Za-z_][A-Za-z0-9_]*)/i.exec(flat);
  const fields = new Set<string>();
  // Identifiers and paths, not functions, literals or keywords.
  const token = /(?<![\w.'])([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?![\w(])(?! ?\()(?!:\d)/g;
  for (const part of [flat.slice(0, from?.index ?? flat.length), from ? flat.slice(from.index + from[0].length) : ""]) {
    for (const t of part.matchAll(token)) {
      const word = t[1]!;
      if (SOQL_WORDS.has(word.toLowerCase()) || DATE_LITERAL.test(word)) continue;
      // An alias after an aggregate: COUNT(Id) total.
      let k = t.index - 1;
      if (part[k] === " ") k--;
      if (part[k] === ")") continue;
      fields.add(word);
    }
  }
  return { ...(from ? { object: from[1] } : {}), fields: [...fields], joins };
}

/** A sort of Apex variables: what each name was declared as, and where. */
class Declarations {
  private byName = new Map<string, { at: number; type: string }[]>();
  add(name: string, at: number, type: string) {
    const key = name.toLowerCase();
    const list = this.byName.get(key);
    if (list) list.push({ at, type });
    else this.byName.set(key, [{ at, type }]);
  }
  /** The type of the nearest declaration before `at`, or of the first after (a class member). */
  typeOf(name: string, at: number): string | undefined {
    const list = this.byName.get(name.toLowerCase());
    if (!list) return undefined;
    let best: { at: number; type: string } | undefined;
    for (const d of list) if (d.at <= at && (!best || d.at > best.at)) best = d;
    return (best ?? list[0])?.type;
  }
  types(): string[] {
    return [...this.byName.values()].flat().map((d) => d.type);
  }
}

/** How much of a query built in strings is read: the rest is most likely not the query. */
const MAX_BUILT_QUERY = 20_000;
const MODIFIERS = /^(?:(?:final|static|private|public|protected|global|transient|override|virtual)\s+)*/i;

/**
 * The SOQL queries a class builds in strings, as far as its strings and string variables show
 * them: `'SELECT Id, ' + fieldList + ' FROM ' + OBJECT_NAME + ' WHERE ...'`, a constant
 * (`static final String OBJECT_NAME = 'Account'`), a variable built over several statements
 * (`q += ' WHERE ...'`). What the strings do not show (a list of fields joined at run time) is
 * left out. `blanked` is the code with comments and strings blanked; `literals` holds the text
 * of each string by where its opening quote is.
 */
function builtQueries(blanked: string, literals: ReadonlyMap<number, string>): string[] {
  if (!literals.size) return [];
  const values = new Map<string, string>();
  const texts: string[] = [];
  const pieces = (from: number, text: string) => {
    const out: string[] = [];
    for (const m of text.matchAll(/'( *)'|(?<![\w.])([A-Za-z_]\w*)(?![\w(])/g)) {
      if (m[1] !== undefined) out.push(literals.get(from + m.index) ?? "");
      else {
        const value = values.get(m[2]!.toLowerCase());
        if (value !== undefined) out.push(value);
      }
    }
    return out.join(" ").slice(0, MAX_BUILT_QUERY);
  };
  let at = 0;
  for (const statement of blanked.split(/[;{}]/)) {
    const start = at;
    at += statement.length + 1;
    if (!statement.includes("'") && !values.size) continue;
    const lead = statement.length - statement.trimStart().length;
    const body = statement.slice(lead).replace(MODIFIERS, "");
    const offset = start + statement.length - body.length;
    const assign = /^(?:String\s+)?([A-Za-z_]\w*)\s*(\+?=)(?!=)/i.exec(body);
    if (assign) {
      const name = assign[1]!.toLowerCase();
      const value = pieces(offset + assign[0].length, body.slice(assign[0].length));
      const previous = values.get(name);
      if (assign[2] === "=" && previous !== undefined) texts.push(previous);
      values.set(name, assign[2] === "+=" && previous !== undefined ? `${previous} ${value}`.slice(0, MAX_BUILT_QUERY) : value);
    } else if (statement.includes("'")) texts.push(pieces(start, statement));
  }
  texts.push(...values.values());
  const queries = new Set<string>();
  for (const t of texts) {
    const m = /\bselect\s[\s\S]*?\bfrom\s+[A-Za-z_]\w*/i.exec(t);
    if (m) queries.add(t.slice(m.index).replace(/\s+/g, " ").trim());
  }
  return [...queries];
}

/** Apex the index cannot follow, by what it does. */
const DYNAMIC: readonly (readonly [string, RegExp])[] = [
  ["query built from a string", /\bdatabase ?\. ?(?:query|querywithbinds|countquery|countquerywithbinds|getquerylocator|getquerylocatorwithbinds|getcursor|getcursorwithbinds) ?\((?! ?\[)/i],
  ["search built from a string", /\bsearch ?\. ?query ?\((?! ?\[)/i],
  ["class named at run time", /\btype ?\. ?forname ?\(/i],
  // Not .getDescribe(): most of it is a field or object check on a name the code spells out.
  ["describe calls", /\bschema ?\. ?(?:getglobaldescribe|describesobjects|describetabs) ?\(/i],
];

/**
 * An Apex class or trigger from its source. Queries read their object and fields; DML writes
 * the object of the record or list it is given; `record.Field = x` writes a field and
 * `record.Field` reads it, for records whose type the code declares (the nearest declaration of
 * that name before the use); classes, flows and custom labels it names are linked. Comments are
 * not read for links. The code itself is kept as `body`, with its secrets hidden, for an agent to
 * read what the links cannot show (a query built from strings); it is masked whenever a tool returns it.
 */
export function readApex(type: "ApexClass" | "ApexTrigger", name: string, source: string, file: string): ParsedComponent {
  const refs: Ref[] = [];
  const attrs: Record<string, unknown> = { lines: source.split("\n").length };
  if (source.length > MAX_APEX_LENGTH) return { type, name, file, attrs: { ...attrs, tooLarge: true }, text: "" };
  // Secrets in strings are hidden before the code is kept.
  const body = hideCodeSecrets(source);
  // One space for every run of whitespace (blanked comments included): the patterns below
  // then never meet a long run, where backtracking would cost quadratic time.
  const blanked = apexCode(source);
  let code = blanked.replace(/\s+/g, " ");
  const seen = new Set<string>();
  const add = (ref: Ref) => {
    const id = ("field" in ref ? `${ref.kind}|||${ref.field}` : "type" in ref ? `${ref.kind}|${String(ref.type)}|${ref.name}` : `${ref.kind}||${ref.object}|${ref.path ?? ""}`).toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      refs.push(ref);
    }
  };
  /** An object reference: certain for a custom or standard object name, else only if the project has it. */
  const objectRef = (kind: Ref["kind"], object: string, path?: string) =>
    add({ kind, object, ...(path ? { path } : {}), ...(isCustomName(object) || isStandardObject(object) ? {} : { known: true }) });

  if (type === "ApexTrigger") {
    const head = /\btrigger [A-Za-z_]\w* ?on ?([A-Za-z_]\w*) ?\(([^)]{0,500})\)/i.exec(code);
    if (head) {
      objectRef("triggers_on", head[1]!);
      attrs.object = head[1];
      attrs.events = head[2]!.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    }
  } else {
    const head = /\b(class|interface|enum) [A-Za-z_]\w*/i.exec(code);
    if (head) attrs.kind = head[1]!.toLowerCase();
    const sharing = /\b(with|without|inherited) sharing\b/i.exec(code);
    if (sharing) attrs.sharing = sharing[1]!.toLowerCase();
    if (/@ ?istest\b/i.test(code)) attrs.isTest = true;
  }

  // What the index cannot follow: queries built from strings, classes named at run time,
  // describes (fields read by name through a map look the same as any map, so they are not flagged). Impact analysis flags such code as a blind spot.
  const dynamic = DYNAMIC.filter(([, re]) => re.test(code)).map(([what]) => what);
  if (dynamic.length) attrs.dynamic = dynamic;

  // Queries: their object and fields are read; then they are taken out, so that their words
  // are not taken for variables.
  let queries = 0;
  let dml = 0;
  const blocks = soqlBlocks(code);
  for (const b of blocks) {
    queries++;
    const { object, fields, joins } = soqlFields(b.query);
    for (const j of joins) {
      objectRef("reads", j.object);
      for (const f of j.fields) objectRef("reads", j.object, f);
    }
    if (!object) continue;
    objectRef("reads", object);
    // delete [SELECT ...], Database.update([SELECT ...]): the records queried are written.
    if (/(?:\b(?:insert|update|upsert|delete|undelete) (?:as (?:user|system) )?|\bdatabase ?\. ?(?:insert|update|upsert|delete|undelete)\w* ?\( ?)$/i.test(code.slice(Math.max(0, b.start - 40), b.start))) {
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
      parts.push(code.slice(at, b.start), " ''");
      at = b.end + 1;
    }
    parts.push(code.slice(at));
    code = parts.join("");
  }
  // this.acc is acc.
  code = code.replace(/\bthis ?\. ?/gi, "");

  // Declared types of variables, parameters, properties and loop variables: Account a,
  // List<Case> cs, Map<Id, Account> m (its values), Policy__c[] ps, for (Contact c : contacts),
  // when Account a {.
  const declarations = new Declarations();
  const declaration = /(?<![\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)(?: ?(?:<(?: ?[\w.]+ ?,)? ?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?) ?>|\[ ?\]))? ([A-Za-z_]\w*) ?(?=[=;,):{])/g;
  for (const m of code.matchAll(declaration)) {
    const declared = (m[2] ?? m[1]!).replace(/^schema\./i, "");
    if (KEYWORDS.has(declared.toLowerCase()) || KEYWORDS.has(m[3]!.toLowerCase())) continue;
    declarations.add(m[3]!, m.index, declared);
  }
  const typeOf = (variable: string, at: number) => declarations.typeOf(variable, at);
  const sobject = (t: string | undefined): t is string => !!t && !/^(?:s?object|string|id|integer|long|decimal|double|boolean|date|datetime|time|blob)$/i.test(t);

  // DML: insert acc; update as user cases; Database.upsert(new List<Account>{...}).
  const statement = /\b(insert|update|upsert|delete|undelete|merge) (?:as (?:user|system) )?(?:new (?:list ?< ?([\w.]+) ?>|([\w.]+))|([A-Za-z_]\w*))/gi;
  const method = /\bdatabase ?\. ?(insert|update|upsert|delete|undelete|merge)\w* ?\( ?(?:new (?:list ?< ?([\w.]+) ?>|([\w.]+))|([A-Za-z_]\w*))/gi;
  for (const re of [statement, method]) {
    for (const m of code.matchAll(re)) {
      // "update" after a dot is a method, not DML.
      if (/\. ?$/.test(code.slice(Math.max(0, m.index - 2), m.index))) continue;
      const object = m[2] ?? m[3] ?? typeOf(m[4]!, m.index);
      if (!sobject(object) || KEYWORDS.has(object.toLowerCase())) continue;
      dml++;
      objectRef("writes", object.replace(/^schema\./i, ""));
    }
  }
  if (dml) attrs.dml = dml;

  // new Account(Name = 'x', OwnerId = UserInfo.getUserId()): the fields are set.
  for (const m of code.matchAll(/\bnew ([A-Za-z_][\w.]*) ?\(/g)) {
    const object = m[1]!.replace(/^schema\./i, "");
    if (!isCustomName(object) && !isStandardObject(object)) continue;
    const open = m.index + m[0].length - 1;
    const end = closing(code, open, open + 5_000);
    if (end < 0) continue;
    // Only the constructor's own arguments: what nested calls hold is blanked.
    let args = "";
    for (let i = open + 1, d = 0; i < end; i++) {
      const c = code[i]!;
      if (c === "(") d++;
      if (d === 0) args += c;
      if (c === ")") d--;
    }
    for (const f of args.matchAll(/(?<![\w.])([A-Za-z_]\w*) ?=(?![=>])/g)) objectRef("writes", object, f[1]!);
  }

  // record.Field, record.Lookup__r.Field = x, record.Amount += 1: through a variable of a
  // declared record type. Method calls end the path.
  const access = /(?<![\w.])([A-Za-z_]\w*)((?: ?\. ?[A-Za-z_]\w*(?!\w| ?\())+)( ?(?:[-+*/]?=(?![=>])|\+\+|--))?/g;
  for (const m of code.matchAll(access)) {
    const head = m[1]!;
    const path = m[2]!.replace(/ /g, "").slice(1);
    const lower = head.toLowerCase();
    const declared = typeOf(head, m.index);
    if (lower === "schema" || (lower === "sobjecttype" && !declared)) {
      // Schema.SObjectType.Policy__c.fields.Status__c, Schema.Policy__c.Status__c,
      // SObjectType.Account.FieldSets.Card; not describe properties
      // (Schema.SObjectType.Account.keyPrefix).
      const full = lower === "schema" ? path : `sobjecttype.${path}`;
      const set = /^(?:sobjecttype\.)?([A-Za-z_]\w*)\.fieldsets\.([A-Za-z_]\w*)/i.exec(full);
      if (set) {
        add({ kind: "reads", type: "FieldSet", name: `${set[1]}.${set[2]}` });
        continue;
      }
      const s = /^sobjecttype\./i.test(full) ? /^sobjecttype\.([A-Za-z_]\w*)(?:\.fields\.([A-Za-z_]\w*))?/i.exec(full) : /^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?/.exec(full);
      if (s) objectRef("reads", s[1]!, s[2] && !/^sobjecttype$/i.test(s[2]) ? s[2] : undefined);
      continue;
    }
    if (!declared && (lower === "label" || (lower === "system" && /^label\./i.test(path)))) {
      const label = path.replace(/^label\./i, "").split(".")[0]!;
      add({ kind: "reads", type: "CustomLabel", name: label });
      continue;
    }
    if (lower === "flow" && /^interview\.[A-Za-z_]/i.test(path)) {
      add({ kind: "calls", type: "Flow", name: path.split(".")[1]! });
      continue;
    }
    if (sobject(declared) && !KEYWORDS.has(lower)) {
      objectRef(m[3] ? "writes" : "reads", declared.replace(/^schema\./i, ""), path);
    } else if (!declared && (isCustomName(head) || isStandardObject(head))) {
      // Static field tokens: Policy__c.Status__c.getDescribe(), Account.Fields.Ext_Id__c (an
      // upsert's key), Account.SObjectType; Settings__c.getInstance() below.
      const segments = path.split(".");
      const field = /^(?:fields|sobjectfield)$/i.test(segments[0]!) ? segments[1] : segments[0];
      objectRef("reads", head, field && !/^sobjecttype$/i.test(field) ? field : undefined);
    }
  }
  // Fields reached through what the code does not type (a method's result, a map's value,
  // an untyped variable) or named in strings (record.get('Foo__c'), queries built from
  // strings): linked by name when one object alone has the field. A name after FROM is an
  // object.
  for (const m of code.matchAll(/\. ?([A-Za-z_]\w*__(?:c|pc))\b(?! ?\()/gi)) add({ kind: "reads", field: m[1]! });
  // The strings are where the blanked code has quotes around spaces; comments are not.
  for (const m of blanked.matchAll(/'( {1,5000})'/g)) {
    const text = source.slice(m.index + 1, m.index + 1 + m[1]!.length);
    for (const w of text.matchAll(/(?<!\w)(?<!\bfrom\s+)([A-Za-z_]\w*__(?:c|pc))\b/gi)) add({ kind: "reads", field: w[1]! });
  }
  // Custom settings and metadata read by method: Settings__c.getInstance().
  for (const m of code.matchAll(/(?<![\w.])([A-Za-z_]\w*__(?:c|mdt)) ?\. ?get\w* ?\(/gi)) objectRef("reads", m[1]!);

  // Callouts: through a named credential ('callout:Name/path'), or to a literal URL, of which
  // only the host is kept. String literals are blanked in `blanked`, so their text is read from
  // the source at the same place, by where its opening quote is, with its escapes undone.
  const literals = new Map<number, string>();
  for (const m of blanked.matchAll(/'( *)'/g)) literals.set(m.index!, source.slice(m.index! + 1, m.index! + 1 + m[1]!.length).replace(/\\(.)/g, "$1"));
  const hosts = new Set<string>();
  for (const text of literals.values()) {
    const named = /^callout:([A-Za-z]\w*)/i.exec(text);
    if (named) add({ kind: "calls", type: "NamedCredential", name: named[1]! });
  }
  for (const m of blanked.matchAll(/\.\s*setEndpoint\s*\(\s*'/gi)) {
    const literal = literals.get(m.index! + m[0].length - 1);
    const host = literal !== undefined && !/^callout:/i.test(literal) ? hostOf(literal) : undefined;
    if (host) hosts.add(host);
  }
  if (hosts.size) attrs.calloutHosts = [...hosts].sort();

  // Queries built in strings: what they probably read, as weaker links (may_read).
  const built = builtQueries(blanked, literals);
  for (const query of built) {
    const { object, fields, joins } = soqlFields(query);
    for (const j of joins) {
      objectRef("may_read", j.object);
      for (const f of j.fields) objectRef("may_read", j.object, f);
    }
    if (!object) continue;
    objectRef("may_read", object);
    for (const f of fields) objectRef("may_read", object, f);
  }
  if (built.length) attrs.builtQueries = built.length;
  // Platform events it publishes: EventBus.publish of a new Foo__e. Events are most often built
  // into a list and published later, so every Foo__e the class creates counts once it publishes.
  if (/\bEventBus ?\. ?publish ?\(/i.test(code)) {
    for (const m of code.matchAll(/\bnew ([A-Za-z]\w*__e) ?\(/gi)) objectRef("writes", m[1]!);
  }

  // Classes it names: Foo.bar(), new Foo(), Foo x, extends Foo. Only those the project has.
  const self = name.toLowerCase();
  const classes = new Set<string>();
  for (const re of [/(?<![\w.])([A-Za-z_]\w*) ?\./g, /\bnew ([A-Za-z_]\w*)/gi, /\b(?:extends|implements) ([A-Za-z_]\w*)/gi]) {
    for (const m of code.matchAll(re)) classes.add(m[1]!);
  }
  for (const t of declarations.types()) classes.add(t.split(".")[0]!);
  for (const c of classes) {
    const lower = c.toLowerCase();
    if (lower === self || KEYWORDS.has(lower) || isCustomName(c)) continue;
    add({ kind: "calls", type: "ApexClass", name: c, known: true });
  }

  return { type, name, file, attrs, refs, text: "", body };
}
