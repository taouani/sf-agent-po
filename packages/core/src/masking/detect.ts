import { detectWithDictionary, type DictionaryEntry } from "./dictionary.js";
import { detectWithRules } from "./rules.js";
import { MASKED_TYPES, mergeSpans, type Span } from "./spans.js";

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
  /** The detection model, when it is available. */
  model?: EntityDetector;
  /** Terms the model must never mask; defaults to DOMAIN_ALLOWLIST. */
  allowlist?: readonly string[];
}

const MASKED = new Set<string>(MASKED_TYPES);

/**
 * Keeps what masking hides (MA1): the model's places and organisations are dropped
 * (an address that contains them is found by the rules), and so are allowlisted terms
 * the model tagged.
 */
export function applyPolicy(text: string, spans: readonly Span[], allowlist: readonly string[] = DOMAIN_ALLOWLIST): Span[] {
  const allowed = new Set(allowlist.map((a) => a.toLowerCase()));
  return spans.filter((s) => MASKED.has(s.type) && !(s.source === "ner" && allowed.has(text.slice(s.start, s.end).trim().toLowerCase())));
}

/** Everything to mask in `text`: rules, then the dictionary, then the model if given; merged. */
export async function detect(text: string, opts: DetectOptions = {}): Promise<Span[]> {
  const found = [...detectWithRules(text), ...detectWithDictionary(text, opts.dictionary ?? []), ...(opts.model ? await opts.model(text) : [])];
  return mergeSpans(applyPolicy(text, found, opts.allowlist));
}
