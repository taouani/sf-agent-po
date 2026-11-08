// The output language of a context (English by default, or French) and the word lists the
// quality checks use in it, read from the content folder (content/checks/<language>.md).

import { ContentLibrary, type CheckWords, type ContextRepository } from "@sf-agent-po/core";
import type { Finding } from "./backlog.js";

export const OUTPUT_LANGUAGES = ["en", "fr"] as const;
export type OutputLanguage = (typeof OUTPUT_LANGUAGES)[number];
export const LANGUAGE_NAMES: Record<OutputLanguage, string> = { en: "English", fr: "French" };

export interface CheckRules {
  language: OutputLanguage;
  name: string;
  /** A word an acceptance criterion or a non-functional requirement cannot be tested with. */
  vague: RegExp;
  /** Whether a persona names nobody in particular ("the user", "un client"). */
  genericPersona(persona: string): boolean;
  /** A security or compliance term, in any language: inputs need not be in the output language. */
  sensitive: RegExp;
  /** Words that often join two needs in one statement. */
  joining: RegExp;
}

let library: ContentLibrary | undefined;
const content = () => (library ??= new ContentLibrary());

/** Reads every word list now, so a broken content file stops the server at start, not a check later. */
export function loadCheckRules(): void {
  for (const l of OUTPUT_LANGUAGES) checkRules(l);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Typographic apostrophes (’ from Word, macOS and models) read as the plain one. */
export const plainApostrophes = (text: string) => text.replace(/[\u2019\u02BC]/g, "'");

/**
 * One entry as a pattern: spaces match any spacing, an apostrophe any apostrophe, and a final
 * "*" the rest of the word, API names included ("audit*" matches Audit_Log__c).
 */
function pattern(entry: string): string {
  const prefix = entry.endsWith("*");
  const body = escape(prefix ? entry.slice(0, -1) : entry)
    .replace(/\s+/g, "\\s+")
    .replace(/'/g, "['\u2019\u02BC]");
  return prefix ? `${body}[\\p{L}\\p{N}_]*` : body;
}

/** Any of the words, as whole words, in any case: letters with accents count as letters. */
export function wordsPattern(words: readonly string[]): RegExp {
  const sorted = [...words].sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${sorted.map(pattern).join("|")})(?![\\p{L}\\p{N}_])`, "iu");
}

const cache = new Map<OutputLanguage, CheckRules>();

export function checkRules(language: OutputLanguage = "en"): CheckRules {
  const hit = cache.get(language);
  if (hit) return hit;
  const words: CheckWords = content().checks(language);
  const personas = new Set(words.personas);
  const articles = [...words.articles].sort((a, b) => b.length - a.length);
  const rules: CheckRules = {
    language,
    name: words.name,
    vague: wordsPattern(words.vague),
    genericPersona(persona) {
      let p = plainApostrophes(persona).trim().toLowerCase().replace(/\s+/g, " ");
      // "the user", "l'utilisateur": the article goes, with the space after it unless it ends in an apostrophe.
      for (const a of articles) {
        if (a.endsWith("'") ? p.startsWith(a) : p.startsWith(`${a} `)) {
          p = p.slice(a.length).trim();
          break;
        }
      }
      return personas.has(p);
    },
    sensitive: wordsPattern(OUTPUT_LANGUAGES.flatMap((l) => content().checks(l).compliance)),
    joining: wordsPattern(words.joining),
  };
  cache.set(language, rules);
  return rules;
}

/** The context's output language: English unless set. */
export function contextLanguage(contexts: ContextRepository, context: string): OutputLanguage {
  const value = contexts.get(context)?.settings.language;
  return OUTPUT_LANGUAGES.includes(value as OutputLanguage) ? (value as OutputLanguage) : "en";
}

/** The language a text reads as, by its common words, or undefined when it is too short to tell. */
export function detectLanguage(text: string): OutputLanguage | undefined {
  // An elided article or pronoun is a word of its own: "l'utilisateur" is "l'" and "utilisateur".
  const tokens = plainApostrophes(text).toLowerCase().match(/\p{L}+'|\p{L}+/gu) ?? [];
  if (tokens.length < 12) return undefined;
  const scores = OUTPUT_LANGUAGES.map((l) => {
    const common = new Set(content().checks(l).common);
    return { l, n: tokens.filter((t) => common.has(t)).length };
  }).sort((a, b) => b.n - a.n);
  const [best, next] = scores;
  // Clearly one language: a few common words, and well ahead of the other.
  return best!.n >= 3 && best!.n >= 2 * next!.n ? best!.l : undefined;
}

/** A warning when the texts read as another language than the context's. */
export function languageFinding(texts: readonly string[], language: OutputLanguage, where: string): Finding | undefined {
  const found = detectLanguage(texts.join("\n"));
  if (!found || found === language) return undefined;
  return { level: "warning", where, message: `This reads as ${LANGUAGE_NAMES[found]}, but the context's output language is ${LANGUAGE_NAMES[language]}: write it in ${LANGUAGE_NAMES[language]}.` };
}
