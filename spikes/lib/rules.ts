// Rule and dictionary layer of PII and secret detection.
// Rules catch structured data (emails, phones, IDs, card numbers, secrets);
// the dictionary catches names the user already knows (for example, org users).

import type { Span } from './spans.ts';

interface Rule {
  type: string;
  pattern: RegExp; // must be global; if it has a group named "value", only that group is masked
  validate?: (match: string) => boolean;
}

const digits = (s: string) => s.replace(/\D/g, '');

function luhn(s: string): boolean {
  const d = digits(s);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

function ibanValid(s: string): boolean {
  const iban = s.replace(/\s/g, '').toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rem = (rem * 10 + Number(c)) % 97;
  }
  return rem === 1;
}

/** French social security number (NIR) with its 2-digit key. */
export function nirValid(s: string): boolean {
  const raw = s.replace(/\s/g, '').toUpperCase();
  if (raw.length !== 15) return false;
  const body = raw.slice(0, 13).replace('2A', '19').replace('2B', '18');
  const key = Number(raw.slice(13));
  return 97 - Number(BigInt(body) % 97n) === key;
}

/** Chinese resident ID (18 characters, ISO 7064 MOD 11-2 check). */
export function cnIdValid(s: string): boolean {
  const id = s.toUpperCase();
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(id[i]) * w[i]!;
  return codes[sum % 11] === id[17];
}

const RULES: Rule[] = [
  // Secrets first so a token is not half-claimed by another rule.
  { type: 'SECRET', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { type: 'SECRET', pattern: /\bATATT[A-Za-z0-9_\-=]{20,}/g }, // Atlassian API token
  { type: 'SECRET', pattern: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]{19,}[A-Za-z0-9]/g }, // Salesforce session id
  { type: 'SECRET', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'SECRET', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: 'SECRET', pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { type: 'SECRET', pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g }, // JWT
  {
    type: 'SECRET',
    pattern:
      // Keyword as a whole word (ASCII boundaries only, since Chinese has no spaces), a separator,
      // then a value with a digit or an inner symbol, so "the token is valid" or "the secretary
      // is Marie" are not secrets. Known gap: a letters-only password is missed.
      /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|client[_ ]secret|api[_ -]?key|token|mot de passe|密码|口令)(?![A-Za-z0-9])[^:=：\n]{0,40}?\s*(?:\bis\b|\best\b|=|:|：)\s*(?<value>(?=[^\s,;，。]*(?:\p{N}|[\p{P}\p{S}](?=[^\s,;，。])))[^\s,;，。]{3,}[^\s,;，。.])/giu,
  },
  { type: 'SECRET', pattern: /\bhttps?:\/\/[^\s:/@]+:(?<value>[^\s@/]+)@/g }, // password in URL
  { type: 'EMAIL', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { type: 'IBAN', pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, validate: ibanValid },
  { type: 'NATIONAL_ID', pattern: /\b[12] ?\d{2} ?(?:0[1-9]|1[0-2]|[2-9]\d) ?(?:\d{2}|2A|2B) ?\d{3} ?\d{3} ?\d{2}\b/g, validate: nirValid },
  { type: 'NATIONAL_ID', pattern: /(?<![0-9Xx])\d{17}[\dXx](?![0-9Xx])/g, validate: cnIdValid },
  { type: 'NATIONAL_ID', pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g }, // US SSN
  { type: 'CARD', pattern: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, validate: luhn },
  { type: 'PHONE', pattern: /(?<![\w+])(?:\+|00)[1-9]\d{0,2}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?!\d)/g, validate: (m) => digits(m).length >= 8 },
  { type: 'PHONE', pattern: /(?<!\d)0[1-9](?:[ .-]?\d{2}){4}(?!\d)/g }, // French national format
  { type: 'PHONE', pattern: /(?<!\d)\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g }, // North American
  { type: 'PHONE', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g }, // Chinese mobile
  { type: 'IP', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];

export function detectWithRules(text: string): Span[] {
  const spans: Span[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const m of text.matchAll(rule.pattern)) {
      let value = m[0];
      if (rule.validate && !rule.validate(value)) {
        // The greedy pattern may have swallowed a trailing group ("4111 1111 1111 1111 12/27"):
        // retry shorter prefixes that end before a separator.
        let shorter: string | undefined;
        for (let cut = value.search(/[ .-][^ .-]*$/); cut > 0; cut = value.slice(0, cut).search(/[ .-][^ .-]*$/)) {
          if (rule.validate(value.slice(0, cut))) {
            shorter = value.slice(0, cut);
            break;
          }
        }
        if (!shorter) continue;
        value = shorter;
      }
      const start = m.index!;
      const group = m.groups?.value;
      if (group !== undefined) {
        const offset = m[0].lastIndexOf(group);
        spans.push({ start: start + offset, end: start + offset + group.length, type: rule.type, source: 'rule' });
      } else {
        spans.push({ start, end: start + value.length, type: rule.type, source: 'rule' });
      }
    }
  }
  return spans;
}

const isCjk = (s: string) => /[\u3400-\u9fff]/u.test(s);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Match known names. CJK names match as substrings; others need word boundaries. */
export function detectWithDictionary(text: string, entries: { value: string; type: string }[]): Span[] {
  const spans: Span[] = [];
  for (const e of entries) {
    const re = isCjk(e.value)
      ? new RegExp(escape(e.value), 'gu')
      : new RegExp(`(?<![\\p{L}\\p{N}])${escape(e.value)}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of text.matchAll(re)) {
      spans.push({ start: m.index!, end: m.index! + m[0].length, type: e.type, source: 'dictionary' });
    }
  }
  return spans;
}

/**
 * Salesforce and tooling vocabulary that must never be masked, even when a
 * model tags it as an organisation or a person.
 */
export const DOMAIN_ALLOWLIST = [
  'Salesforce', 'Sales Cloud', 'Service Cloud', 'Experience Cloud', 'Marketing Cloud', 'Commerce Cloud',
  'Data Cloud', 'Agentforce', 'Einstein', 'Lightning', 'Apex', 'Visualforce', 'Flow', 'OmniStudio',
  'MuleSoft', 'Tableau', 'Slack', 'Jira', 'Confluence', 'Atlassian', 'GitHub', 'GitLab', 'Azure DevOps',
  'Account', 'Contact', 'Lead', 'Opportunity', 'Case', 'Order', 'Product', 'Pricebook', 'Campaign',
  'Knowledge', 'Omni-Channel', 'CPQ', 'Revenue Cloud', 'Field Service', 'Shield', 'Platform Events',
];

export function dropAllowlisted(text: string, spans: Span[], allowlist = DOMAIN_ALLOWLIST): Span[] {
  const allowed = new Set(allowlist.map((a) => a.toLowerCase()));
  return spans.filter((s) => s.source !== 'ner' || !allowed.has(text.slice(s.start, s.end).trim().toLowerCase()));
}
