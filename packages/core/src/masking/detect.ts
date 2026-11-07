import { detectWithDictionary, type CompiledDictionary, type DictionaryEntry } from "./dictionary.js";
import { detectWithRules } from "./rules.js";
import { mergeSpans, normaliseType, type Span } from "./spans.js";

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
];

/** A detection model: finds names (and other entities) that no rule can. */
export type EntityDetector = (text: string) => Promise<Span[]>;

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
 * Types that stay visible (MA1): places, organisations, and the model's other non-personal
 * labels. Every other type is masked, including ones this code does not know (fail closed).
 */
const VISIBLE_TYPES = new Set(["LOCATION", "ORG", "MISC", "DATE", "TIME"]);

/**
 * Keeps what masking hides (MA1): the model's places and organisations are dropped
 * (an address that contains them is found by the rules), and so are allowlisted terms
 * the model tagged.
 */
export function applyPolicy(text: string, spans: readonly Span[], allowlist: readonly string[] = DOMAIN_ALLOWLIST): Span[] {
  const allowed = new Set(allowlist.map((a) => a.toLowerCase()));
  return spans.filter(
    (s) => !VISIBLE_TYPES.has(normaliseType(s.type)) && !(s.source === "ner" && allowed.has(text.slice(s.start, s.end).trim().toLowerCase())),
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
