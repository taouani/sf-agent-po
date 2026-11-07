import type { Span } from "./spans.js";

/**
 * The rule layer: structured personal data and secrets (emails, phone numbers, bank and
 * card numbers, national ids, secrets, IP addresses, street addresses). Each rule is a
 * global pattern; a named group "value" limits the mask to that group (for example the
 * password after "password:"), and a validator rejects matches that only look right.
 */
interface Rule {
  type: string;
  pattern: RegExp;
  validate?: (match: string) => boolean;
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Card numbers: the Luhn check digit. */
export function luhnValid(s: string): boolean {
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

/** IBAN: the ISO 13616 mod-97 check. */
export function ibanValid(s: string): boolean {
  const iban = s.replace(/\s/g, "").toUpperCase();
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
  const raw = s.replace(/\s/g, "").toUpperCase();
  if (raw.length !== 15) return false;
  const body = raw.slice(0, 13).replace("2A", "19").replace("2B", "18");
  if (!/^\d{13}$/.test(body)) return false;
  return 97 - Number(BigInt(body) % 97n) === Number(raw.slice(13));
}

/** Chinese resident id: 18 characters with an ISO 7064 MOD 11-2 check. */
export function cnIdValid(s: string): boolean {
  const id = s.toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) return false;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(id[i]) * w[i]!;
  return "10X98765432"[sum % 11] === id[17];
}

// Chinese addresses start with a province or a city by name, so the pattern cannot start
// mid-sentence ("住在广州市..." masks from 广州, not from 在).
const CN_PROVINCES =
  "北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门";
const CN_CITIES =
  "广州|深圳|成都|杭州|南京|武汉|西安|苏州|天津|长沙|郑州|东莞|青岛|沈阳|宁波|昆明|大连|厦门|合肥|佛山|福州|哈尔滨|济南|温州|长春|石家庄|常州|泉州|南宁|贵阳|南昌|南通|金华|徐州|太原|嘉兴|烟台|惠州|保定|台州|中山|绍兴|乌鲁木齐|潍坊|兰州|珠海|无锡|海口|三亚";
const CN_ADDRESS = new RegExp(
  // a province (or municipality) and/or a city by name, then an optional district or county,
  // a road or street with a number, and optional building parts
  `(?:(?:${CN_PROVINCES})(?:省|市|自治区|特别行政区)?(?:(?:${CN_CITIES})市?)?|(?:${CN_CITIES})市?)` +
    `(?:[\\u4e00-\\u9fff]{1,4}?(?:区|县))?[\\u4e00-\\u9fff\\d]{1,12}?(?:大道|路|街|道|巷|弄)\\d+号(?:\\d+(?:栋|幢|单元|楼|层|室))*`,
  "gu",
);

const RULES: Rule[] = [
  // Secrets first, so a token is not half claimed by another rule.
  { type: "SECRET", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { type: "SECRET", pattern: /\bATATT[A-Za-z0-9_\-=]{20,}/g }, // Atlassian API token
  { type: "SECRET", pattern: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]{19,}[A-Za-z0-9]/g }, // Salesforce session id
  { type: "SECRET", pattern: /\bAKIA[0-9A-Z]{16}\b/g }, // AWS access key id
  { type: "SECRET", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g }, // GitHub token
  { type: "SECRET", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g }, // GitLab token
  { type: "SECRET", pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g }, // Slack token
  { type: "SECRET", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g }, // model provider API keys
  { type: "SECRET", pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g }, // JWT
  {
    type: "SECRET",
    // A keyword as a whole word (ASCII boundaries only, since Chinese has no spaces), a
    // separator, then a value with a digit or an inner symbol, so "the token is valid" or
    // "the secretary is Marie" are not secrets. Known gap: a letters-only password is missed.
    pattern:
      /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|client[_ ]secret|api[_ -]?key|token|mot de passe|密码|口令)(?![A-Za-z0-9])[^:=：\n]{0,40}?\s*(?:\bis\b|\best\b|=|:|：)\s*(?<value>(?=[^\s,;，。]*(?:\p{N}|[\p{P}\p{S}](?=[^\s,;，。])))[^\s,;，。]{3,}[^\s,;，。.])/giu,
  },
  { type: "SECRET", pattern: /\bhttps?:\/\/[^\s:/@]+:(?<value>[^\s@/]+)@/g }, // password in a URL
  // Not the "user:password@host" of a URL, which the rule above masks as a secret.
  { type: "EMAIL", pattern: /(?<!\/\/[^\s/@:]*:[^\s@]*)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { type: "IBAN", pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, validate: ibanValid },
  { type: "NATIONAL_ID", pattern: /\b[12] ?\d{2} ?(?:0[1-9]|1[0-2]|[2-9]\d) ?(?:\d{2}|2A|2B) ?\d{3} ?\d{3} ?\d{2}\b/g, validate: nirValid },
  { type: "NATIONAL_ID", pattern: /(?<![0-9Xx])\d{17}[\dXx](?![0-9Xx])/g, validate: cnIdValid },
  { type: "NATIONAL_ID", pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g }, // US SSN
  { type: "CARD", pattern: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, validate: luhnValid },
  { type: "PHONE", pattern: /(?<![\w+])(?:\+|00)[1-9]\d{0,2}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?!\d)/g, validate: (m) => digits(m).length >= 8 },
  { type: "PHONE", pattern: /(?<!\d)0[1-9](?:[ .-]?\d{2}){4}(?!\d)/g }, // French national format
  { type: "PHONE", pattern: /(?<!\d)\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g }, // North American
  { type: "PHONE", pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g }, // Chinese mobile
  { type: "IP", pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  {
    // French street address, with the postcode and town when they follow.
    type: "ADDRESS",
    pattern:
      /(?<![\p{L}\p{N}])\d{1,4}(?:\s?(?:bis|ter))?,?\s+(?:[Rr]ue|[Aa]venue|[Aa]v\.|[Bb]oulevard|[Bb]d|[Pp]lace|[Aa]llée|[Cc]hemin|[Ii]mpasse|[Qq]uai|[Rr]oute|[Cc]ours|[Ss]quare)\s+[^,\n.;()]{2,60}?(?:,\s*\d{5}\s+\p{Lu}[\p{L}'-]*(?:[ -]\p{Lu}[\p{L}'-]*)*(?![\p{L}\p{N}])|(?=[,.;()\n]|$))/gu,
  },
  {
    // English street address, with the town and a UK or US postcode when they follow.
    type: "ADDRESS",
    pattern:
      /(?<![\p{L}\p{N}])\d{1,5}\s+(?:\p{Lu}[\p{L}'.-]*\s+){1,4}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Boulevard|Blvd|Drive|Dr|Way|Place|Pl|Court|Ct|Square|Sq|Terrace|Crescent|Close)\b\.?(?:,\s*\p{Lu}[\p{L}'-]+(?![\p{L}\p{N}])(?:[ -]\p{Lu}[\p{L}'-]+(?![\p{L}\p{N}]))*(?:,?\s+(?:[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}|[A-Z]{2}\s+\d{5}(?:-\d{4})?|\d{5}(?:-\d{4})?))?)?/gu,
  },
  { type: "ADDRESS", pattern: CN_ADDRESS },
];

/** Finds structured personal data and secrets. Spans may overlap; merge them before masking. */
export function detectWithRules(text: string): Span[] {
  const spans: Span[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      let value = m[0];
      if (!value) continue;
      if (rule.validate && !rule.validate(value)) {
        // A greedy pattern may have swallowed a trailing group ("4111 1111 1111 1111 12/27"):
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
      const start = m.index;
      const group = m.groups?.value;
      if (group !== undefined) {
        const offset = m[0].lastIndexOf(group);
        spans.push({ start: start + offset, end: start + offset + group.length, type: rule.type, source: "rule" });
      } else {
        spans.push({ start, end: start + value.length, type: rule.type, source: "rule" });
      }
    }
  }
  return spans;
}
