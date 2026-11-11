import { detectWithDictionary, type CompiledDictionary, type DictionaryEntry } from "./dictionary.js";
import { detectWithRules } from "./rules.js";
import { mergeSpans, normaliseType, VISIBLE_TYPES, type Span } from "./spans.js";

/**
 * Salesforce and tooling vocabulary that is never masked, even when the model tags it
 * as a person or an organisation.
 */
export const DOMAIN_ALLOWLIST: readonly string[] = [
  "Salesforce", "Sales Cloud", "Service Cloud", "Experience Cloud", "Marketing Cloud", "Commerce Cloud",
  "Data Cloud", "Data 360", "Agentforce", "Einstein", "Lightning", "Apex", "Visualforce", "Flow", "OmniStudio",
  "MuleSoft", "Tableau", "Slack", "Jira", "Confluence", "Atlassian", "GitHub", "GitLab", "Azure DevOps",
  "Account", "Contact", "Lead", "Opportunity", "Case", "Order", "Product", "Pricebook", "Campaign",
  "Knowledge", "Omni-Channel", "CPQ", "Revenue Cloud", "Field Service", "Shield", "Platform Events",
  "Person Account", "Record Type", "Validation Rule", "Permission Set", "Field Set",
  // Field types: the server writes them in its briefs and checks, and the model names them.
  "AutoNumber", "Checkbox", "Currency", "Date", "DateTime", "Email", "EncryptedText", "ExternalLookup", "Formula",
  "Geolocation", "Html", "IndirectLookup", "Location", "LongTextArea", "Lookup", "MasterDetail", "MetadataRelationship",
  "MultiselectPicklist", "Number", "Percent", "Phone", "Picklist", "Summary", "Text", "TextArea", "Time", "Url",
  "Hierarchy", "Address", "Id", "Name",
  // The same types as Setup and people write them.
  "Auto Number", "Date/Time", "Text Area", "Long Text Area", "Rich Text Area", "Encrypted Text", "Roll-Up Summary",
  "Master-Detail", "Master-Detail Relationship", "Lookup Relationship", "Multi-Select Picklist", "External Lookup",
  "Indirect Lookup",
];

/**
 * How a term is compared with the allowlist: case, spaces and punctuation left out, so that
 * "Roll-Up Summary", "rollup summary" and a tagged "Currency," all match.
 */
export const allowKey = (term: string) => term.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** A detection model: finds names (and other entities) that no rule can. */
export type EntityDetector = (text: string) => Promise<Span[]>;

/** How many short texts the model's answers are kept for, and how long a text may be to be kept. */
export const MODEL_CACHE_ENTRIES = 5_000;
export const MODEL_CACHE_LENGTH = 200;

/**
 * The model with its answers kept for short texts, the most recently used first: metadata
 * keys, labels and Jira fields come back again and again, and the model gives the same text
 * the same answer, so a kept answer changes nothing but the time. A failed run is not kept.
 * Up to that many short texts stay in this process's memory, across contexts, until it exits;
 * they are never written anywhere.
 */
export function cachedDetector(model: EntityDetector, entries = MODEL_CACHE_ENTRIES, length = MODEL_CACHE_LENGTH): EntityDetector {
  const kept = new Map<string, Promise<Span[]>>();
  return async (text) => {
    if (text.length > length) return model(text);
    let answer = kept.get(text);
    if (answer) kept.delete(text);
    else {
      const run = model(text);
      answer = run;
      run.catch(() => {
        if (kept.get(text) === run) kept.delete(text);
      });
    }
    kept.set(text, answer);
    if (kept.size > entries) kept.delete(kept.keys().next().value!);
    return (await answer).map((s) => ({ ...s }));
  };
}

export interface DetectOptions {
  /** Values the context already knows, for example the org's users. */
  dictionary?: readonly DictionaryEntry[];
  /** Known values already compiled (see compileDictionary), for long lists used again and again. */
  compiled?: readonly CompiledDictionary[];
  /** The detection model, when it is available. */
  model?: EntityDetector;
  /** Terms the model must never mask; defaults to DOMAIN_ALLOWLIST. */
  allowlist?: readonly string[];
}

/**
 * Keeps what masking hides (MA1): the model's places and organisations are dropped
 * (an address that contains them is found by the rules), and so are allowlisted terms
 * the model tagged.
 */
export function applyPolicy(text: string, spans: readonly Span[], allowlist: readonly string[] = DOMAIN_ALLOWLIST): Span[] {
  const allowed = new Set(allowlist.map(allowKey));
  return spans.filter(
    (s) => !VISIBLE_TYPES.has(normaliseType(s.type)) && !(s.source === "ner" && allowed.has(allowKey(text.slice(s.start, s.end)))),
  );
}

/**
 * Checks a model's span against the text: offsets are rounded outwards and clamped to the
 * text, so a sloppy span masks a little more rather than less; one with no valid offsets is dropped.
 */
function checkModelSpan(s: Span, length: number): Span | undefined {
  if (typeof s?.start !== "number" || typeof s.end !== "number" || Number.isNaN(s.start) || Number.isNaN(s.end)) return undefined;
  const start = Math.max(0, Math.floor(s.start));
  const end = Math.min(length, Math.ceil(s.end));
  if (end <= start) return undefined;
  return { ...s, start, end, type: normaliseType(String(s.type ?? "")), source: "ner" };
}

/** Everything to mask in `text`: rules, then the dictionary, then the model if given; merged. */
export async function detect(text: string, opts: DetectOptions = {}): Promise<Span[]> {
  const fromModel = opts.model ? (await opts.model(text)).flatMap((s) => checkModelSpan(s, text.length) ?? []) : [];
  const found = [
    ...detectWithRules(text),
    ...detectWithDictionary(text, opts.dictionary ?? []),
    ...(opts.compiled ?? []).flatMap((d) => d.find(text)),
    ...fromModel,
  ];
  return mergeSpans(applyPolicy(text, found, opts.allowlist));
}
