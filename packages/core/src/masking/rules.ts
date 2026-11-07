import type { Span } from "./spans.js";

/**
 * The rule layer: structured personal data and secrets (emails, phone numbers, bank and
 * card numbers, national ids, secrets, IP addresses, street addresses).
 *
 * Every pattern is bounded (no unbounded repeat next to an overlapping one), so a long
 * run of text without spaces, such as minified JSON, is scanned in linear time.
 */
interface Rule {
  type: string;
  pattern: RegExp;
  /** Rejects matches that only look right. */
  validate?: (match: string) => boolean;
  /**
   * When the match fails validation, retry shorter prefixes that end before a separator:
   * a greedy pattern may have swallowed a trailing group ("BE68 5390 0754 7034 2024").
   */
  retryShorter?: boolean;
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

/** IBAN lengths by country (SWIFT IBAN registry). */
const IBAN_LENGTHS: Record<string, number> = Object.fromEntries(
  (
    "AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DJ27 DK18 DO28 EE20 EG29 ES24 " +
    "FI18 FK18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HN28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 " +
    "LI21 LT20 LU20 LV21 LY25 MC27 MD24 ME22 MK19 MN20 MR27 MT31 MU30 NI28 NL18 NO15 OM23 PK24 PL28 PS29 PT25 QA29 RO24 " +
    "RS22 RU33 SA24 SC31 SD18 SE24 SI19 SK24 SM27 SO23 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20 YE30"
  )
    .split(" ")
    .map((e) => [e.slice(0, 2), Number(e.slice(2))]),
);

/** IBAN: the country's length and the ISO 13616 mod-97 check. */
export function ibanValid(s: string): boolean {
  const iban = s.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const length = IBAN_LENGTHS[iban.slice(0, 2)];
  if (length ? iban.length !== length : iban.length < 15 || iban.length > 34) return false;
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
  const raw = s.replace(/[\s-]/g, "").toUpperCase();
  if (raw.length !== 15) return false;
  const body = raw.slice(0, 13).replace("2A", "19").replace("2B", "18");
  if (!/^\d{13}$/.test(body) || !/^\d{2}$/.test(raw.slice(13))) return false;
  return 97 - Number(BigInt(body) % 97n) === Number(raw.slice(13));
}

/** Chinese resident id: 18 characters with an ISO 7064 MOD 11-2 check. */
export function cnIdValid(s: string): boolean {
  const id = s.replace(/\s/g, "").toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) return false;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(id[i]) * w[i]!;
  return "10X98765432"[sum % 11] === id[17];
}

/** "rue" → "[Rr]ue|RUE", so a street type matches capitalised or in capitals, but a name never starts in lowercase. */
const cased = (words: string[]) =>
  words.map((w) => `[${w[0]!.toUpperCase()}${w[0]}]${w.slice(1).replace(/\./g, "\\.")}|${w.toUpperCase().replace(/\./g, "\\.")}`).join("|");

const FR_STREET_TYPES = cased([
  "rue", "r.", "avenue", "av.", "av", "boulevard", "bd", "place", "allée", "allee", "chemin", "impasse", "quai", "route",
  "cours", "square", "passage", "faubourg", "fbg", "chaussée", "promenade", "parvis", "rond-point", "sentier", "cité",
  "villa", "résidence", "hameau", "lieu-dit", "voie", "esplanade",
]);
// After the street type: an optional article, then a capital or a number ("rue du 8 Mai 1945"),
// so "2 cours de formation" or "3 place pour" are not addresses.
const FR_ARTICLE = "(?:(?:de la|de l['’]|des|du|de|d['’]|DE LA|DE L['’]|DES|DU|DE|D['’])\\s*)?";
// The name runs to a comma or a line end; a dot only ends it after a word that is not an abbreviation ("du Mal. Foch").
const FR_ABBREVIATION = "(?<![\\p{L}])(?:St|Ste|Mal|Gal|Gén|Mar|Dr|Pr|Pdt|Mgr|Cdt|Lt|Col)";
const FR_NAME = `[\\p{Lu}\\p{N}](?:[^,\\n;().]|(?<=${FR_ABBREVIATION})\\.){0,60}?`;
const FR_UNIT = "(?:,?\\s*(?:apt|appt|appartement|bât\\.?|bâtiment|bat\\.?|étage|esc\\.?|escalier|porte|BP|CS)\\s*[\\p{L}\\p{N}]{1,6})*";
const FR_TOWN = "(?:\\d{5}|\\d{2}\\s\\d{3})\\s+\\p{Lu}[\\p{L}'’-]*(?:\\s\\p{Lu}[\\p{L}'’-]*){0,3}(?![\\p{L}\\p{N}])(?:\\s+CEDEX(?:\\s?\\d{1,2})?)?";
const FR_ADDRESS = new RegExp(
  `(?<![\\p{L}\\p{N}])\\d{1,4}(?:\\s?(?:bis|ter|quater|BIS|TER)|\\s?[A-D]|[a-d])?(?![\\p{L}\\p{N}]),?\\s+(?:${FR_STREET_TYPES})(?![\\p{L}\\p{N}])\\s*` +
    `${FR_ARTICLE}${FR_NAME}${FR_UNIT}(?:,?\\s*${FR_TOWN}|(?=[,;()\\n]|$|\\.(?<!${FR_ABBREVIATION}\\.)))`,
  "gu",
);

const EN_STREET_TYPES =
  "Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Boulevard|Blvd|Drive|Dr|Way|Place|Pl|Court|Ct|Square|Sq|Terrace|Crescent|Close|" +
  "Parkway|Pkwy|Loop|Highway|Hwy|Circle|Cir|Row|Mews|Gardens|Grove|Plaza|Trail|Alley";
const EN_TOWN = "\\p{Lu}[\\p{L}'-]+(?![\\p{L}\\p{N}])(?:[ -]\\p{Lu}[\\p{L}'-]+(?![\\p{L}\\p{N}])){0,3}";
const EN_POSTCODE = "(?:[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2}|(?:[A-Z]{2}\\s+)?\\d{5}(?:-\\d{4})?)(?![\\p{L}\\p{N}])";
const EN_ADDRESS = new RegExp(
  // a house number ("221B", "12-14"), one to four capitalised words or an ordinal ("5th"), a street type,
  // an optional unit, then the town and a UK or US postcode when they follow
  `(?<![\\p{L}\\p{N}])\\d{1,5}[A-Za-z]?(?:-\\d{1,5}[A-Za-z]?)?\\s+(?:(?:\\p{Lu}[\\p{L}'.-]*|\\d{1,3}(?:st|nd|rd|th))\\s+){1,4}` +
    `(?:${EN_STREET_TYPES})(?![\\p{L}\\p{N}])\\.?` +
    `(?:,?\\s+(?:Apt|Apartment|Suite|Ste|Unit|Flat|Floor|Fl|#)\\.?\\s*#?[A-Za-z0-9-]{1,6}(?![\\p{L}\\p{N}]))?` +
    `(?:,\\s*${EN_TOWN}(?:,?\\s+${EN_POSTCODE})?|\\s+${EN_TOWN},?\\s+${EN_POSTCODE}|,?\\s+${EN_POSTCODE})?`,
  "gu",
);

// Chinese addresses start with a province or a city by name, or with any 2-3 character place
// ending in 省/市/区/县 after a non-Han character or a word such as 在 or 到 ("住在昆山市..."),
// so the pattern does not start in the middle of a sentence.
const CN_PROVINCES =
  "北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门";
const CN_CITIES =
  "广州|深圳|成都|杭州|南京|武汉|西安|苏州|天津|长沙|郑州|东莞|青岛|沈阳|宁波|昆明|大连|厦门|合肥|佛山|福州|哈尔滨|济南|温州|长春|石家庄|常州|泉州|南宁|贵阳|南昌|南通|金华|徐州|太原|嘉兴|烟台|惠州|保定|台州|中山|绍兴|乌鲁木齐|潍坊|兰州|珠海|无锡|海口|三亚";
const HAN = "\\u4e00-\\u9fff";
const CN_NUMBER = "(?:[\\d０-９]{1,6}|[一二三四五六七八九十百零〇]{1,6})";
const CN_ADDRESS = new RegExp(
  `(?:(?:${CN_PROVINCES})(?:省|市|自治区|特别行政区)?(?:(?:${CN_CITIES})市?)?|(?:${CN_CITIES})市?|(?<=^|[^${HAN}]|[在于到往至址])[${HAN}]{2,3}(?:省|市|区|县))` +
    `(?:[${HAN}]{1,5}?(?:市|区|县|镇|乡|街道)){0,3}` +
    `[${HAN}\\d]{1,12}?(?:大道|路|街|道|巷|弄|胡同)(?:[东南西北中]|[一二三四五六七八九十]段)?\\s?${CN_NUMBER}号院?` +
    `(?:\\s?(?:${CN_NUMBER}|[A-Za-z])(?:号院|号楼|院|楼|座|栋|幢|单元|层|室))*`,
  "gu",
);

const RULES: Rule[] = [
  // Secrets first, so a token is not half claimed by another rule.
  // A private key, also when truncated: base64 lines and "Proc-Type:" headers after the BEGIN line.
  {
    type: "SECRET",
    pattern: /-----BEGIN [A-Z ]{0,30}PRIVATE KEY[A-Z ]{0,30}-----(?:\s+(?:[A-Za-z0-9+/=]{2,}|[A-Za-z-]{1,30}:[^\n]*))*(?:\s*-----END [A-Z ]{0,30}PRIVATE KEY[A-Z ]{0,30}-----)?/g,
  },
  { type: "SECRET", pattern: /\bATATT[A-Za-z0-9_\-=]{20,}/g }, // Atlassian API token
  { type: "SECRET", pattern: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]{19,}[A-Za-z0-9]/g }, // Salesforce session id
  { type: "SECRET", pattern: /\b5Aep861[A-Za-z0-9._]{20,}/g }, // Salesforce refresh token
  { type: "SECRET", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g }, // AWS access key id
  { type: "SECRET", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g }, // GitHub token
  { type: "SECRET", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g }, // GitHub fine-grained token
  { type: "SECRET", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g }, // GitLab token
  { type: "SECRET", pattern: /\bxox[abprse]-[A-Za-z0-9-]{10,}/g }, // Slack token
  { type: "SECRET", pattern: /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g }, // Slack webhook
  { type: "SECRET", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g }, // model provider API keys
  { type: "SECRET", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g }, // Stripe keys
  { type: "SECRET", pattern: /\bAIza[0-9A-Za-z_-]{35}/g }, // Google API key
  { type: "SECRET", pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g }, // JWT
  // The password in a URL, for any scheme: "https://user:pass@", "redis://:pass@", "force://id::token@".
  { type: "SECRET", pattern: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{0,256}::?(?<value>[^\s@/]{1,512})@/gi },
  {
    type: "EMAIL",
    // Latin letters only, so the Chinese text written right before an address is not taken as its local part.
    pattern: /(?<![\w\u00c0-\u024f.%+-])[\w\u00c0-\u024f%+-][\w\u00c0-\u024f.%+'-]{0,63}@[a-z0-9\u00c0-\u024f-]{1,63}(?:\.[a-z0-9\u00c0-\u024f-]{1,63}){0,8}\.[a-z\u00c0-\u024f]{2,24}(?![\w\u00c0-\u024f-])/giu,
  },
  {
    type: "IBAN",
    pattern: /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]{4}){2,7}(?:[ -]?[A-Za-z0-9]{1,4})?(?![A-Za-z0-9])/g,
    validate: ibanValid,
    retryShorter: true,
  },
  {
    type: "NATIONAL_ID",
    pattern: /(?<![\p{L}\p{N}])[12][ -]?\d{2}[ -]?(?:0[1-9]|1[0-2]|[2-9]\d)[ -]?(?:\d{2}|2A|2B)[ -]?\d{3}[ -]?\d{3}[ -]?\d{2}(?![\p{L}\p{N}])/gu,
    validate: nirValid,
  },
  { type: "NATIONAL_ID", pattern: /(?<![0-9Xx])\d{6} ?\d{8} ?\d{3}[\dXx](?![0-9Xx])/g, validate: cnIdValid },
  { type: "NATIONAL_ID", pattern: /(?<![\d-])(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?![\d-])/g }, // US SSN
  {
    // Grouped 4-4-4-4(-3), contiguous 13-19 digits, or 4-6-5 / 4-6-4 (Amex, Diners).
    type: "CARD",
    pattern: /(?<![A-Za-z0-9]|\d[ .-])(?:\d{4}([ .-]?)\d{4}\1\d{4}\1\d{4}(?:\1\d{3})?|\d{4}([ -]?)\d{6}\2\d{4,5}|\d{13,19})(?![A-Za-z0-9]|[ .-]\d{4})/g,
    validate: luhnValid,
  },
  {
    // International: "+" or "00" and a country code; with "00", a separator must follow the country code,
    // so a case or order number such as 00123456 is not a phone.
    type: "PHONE",
    pattern:
      /(?<![\w+])(?:\+[1-9]\d{0,2}(?:\d{6,14}|(?:[ .-]?\(\d{1,4}\))?[ .-]?\d{1,8}(?:[ .-]\d{1,8}){0,6})|00[1-9]\d{0,2}(?:[ .-]?\(\d{1,4}\))?[ .-]\d{1,8}(?:[ .-]\d{1,8}){0,6})(?!\d)/g,
    validate: (m) => digits(m).length >= 8 && digits(m).length <= 15,
    retryShorter: true,
  },
  { type: "PHONE", pattern: /(?<![\d+]|\d[ .-])0[1-9](?:[ .-]?\d{2}){4}(?!\d)/g }, // French national format
  { type: "PHONE", pattern: /(?<![\d+]|\d[ .-])(?:1[ .-])?(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4}(?!\d)/g }, // North American
  { type: "PHONE", pattern: /(?<![\d+])1[3-9]\d(?:[ -]?\d{4}){2}(?!\d)/g }, // Chinese mobile
  { type: "PHONE", pattern: /(?<![\d+])(?:0\d{2,3}-|\(0\d{2,3}\)\s?)(?:\d{7,8}|\d{3,4}[ -]\d{4})(?!\d)/g }, // Chinese landline
  {
    // Other national formats: a trunk 0, an area code and groups split by one kind of separator
    // ("020 7946 0958", "030-12345678"); 9 to 12 digits, and not a date.
    type: "PHONE",
    pattern: /(?<![\w+.-]|\d[ .-])0[1-9]\d{0,3}([ .-])\d{2,8}(?:\1\d{2,8}){0,3}(?!\d|[.-]\d)/g,
    validate: (m) => digits(m).length >= 9 && digits(m).length <= 12 && !/^\d{1,2}([./-])\d{1,2}\1\d{2,4}/.test(m),
  },
  {
    // Not a version number: "version 10.0.0.1", "v1.2.3.4" or a fifth part.
    type: "IP",
    pattern:
      /(?<!(?:\b(?:[Vv]ersion|[Rr]elease|[Vv]er|[Bb]uild|[Vv])\.?\s*:?\s*)|\d\.?)\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b(?!\.\d)/g,
  },
  { type: "ADDRESS", pattern: FR_ADDRESS },
  { type: "ADDRESS", pattern: EN_ADDRESS },
  { type: "ADDRESS", pattern: CN_ADDRESS },
];

// Keyword secrets ("password: x", "DB_PASSWORD=x", "<password>x</password>", "密码是x").

/** A key whose words, run together in lowercase, end with one of these names a secret. */
const SECRET_KEY_ENDINGS = [
  "password", "passwd", "passcode", "passphrase", "pwd", "secret", "token", "apikey", "privatekey", "sessionid",
  "accesskey", "secretkey", "motdepasse", "cléapi", "cledapi", "clédapi", "jeton",
];
/** Keys that only count on their own (not "bypass" or "compass"). */
const SECRET_KEYS_EXACT = new Set(["pass", "mdp"]);
/** One key: a phrase, an identifier (camelCase, snake_case, dotted), or a Chinese keyword anywhere. */
const KEY_PATTERN =
  /(?<![A-Za-z0-9_.-])(?:mot de passe|cl[ée] (?:d['’]|de l['’])?api|(?:api|private|secret|session|access|consumer|client) (?:key|id|secret|token)|[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9_.-]{0,63})|密码|口令|密钥|秘钥|令牌/giu;
const CN_KEY = /^(?:密码|口令|密钥|秘钥|令牌)$/u;
/** After a key: an optional closing quote, up to four plain words ("for the user"), then a separator. */
const SEPARATOR = /["']?(?:[ \t]+[\p{L}'’-]{1,20}){0,4}?\s*(?:\bis\b|\best\b|\bwas\b|=>|:=|=|:|：)\s*/uy;
const CN_SEPARATOR = /\s*(?:是|为|：|:|=)?\s*/uy;
/** An unquoted value: up to a space or a sentence mark; not Chinese text. */
const BARE_VALUE = /[^\s,;，。；、：（）<>"'`\u3000-\u303f\u3400-\u9fff\uff00-\uffef]{4,200}/uy;

/** Values that name a secret rather than hold one: calls, field types, templates and environment variable names. */
function isReference(v: string): boolean {
  return (
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(.*\);?$/u.test(v) || // getPassword(), Text(255)
    (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+;?$/u.test(v) && !/\d/.test(v)) || // process.env.DB_PASSWORD
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(v) || // DB_PASSWORD
    /^(?:\{!.*\}|\$\{.*\}|\{\{.*\}\}|%[\w.]+%|\$[A-Za-z_]\w*|<[^>]*>)$/u.test(v) // {!$Credential.Password}, ${PWD}, {{token}}
  );
}

/** A value with a digit or an inner symbol, so "the token is valid" is not a secret. Known gap: a letters-only password. */
const looksSecret = (v: string) => v.length >= 4 && (/\p{N}/u.test(v) || /[\p{P}\p{S}](?=.)/u.test(v)) && !isReference(v);

function isSecretKey(key: string): boolean {
  if (CN_KEY.test(key)) return true;
  const k = key.toLowerCase().replace(/[\s_.'’-]/g, "");
  return SECRET_KEYS_EXACT.has(k) || SECRET_KEY_ENDINGS.some((e) => k.endsWith(e));
}

function detectKeywordSecrets(text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(KEY_PATTERN)) {
    const key = m[0];
    if (!isSecretKey(key)) continue;
    let pos = m.index + key.length;
    if (text[m.index - 1] === "<" && text[pos] === ">") pos++; // <password>value</password>
    else {
      const sep = CN_KEY.test(key) ? CN_SEPARATOR : SEPARATOR;
      sep.lastIndex = pos;
      const s = sep.exec(text);
      if (!s || (!CN_KEY.test(key) && s[0].trim() === "")) continue;
      pos += s[0].length;
    }
    let start = pos;
    let value: string;
    const quote = text[pos];
    const close = quote === '"' ? '"' : quote === "'" ? "'" : quote === "“" ? "”" : undefined;
    if (close) {
      const end = text.indexOf(close, pos + 1);
      if (end < 0 || end - pos > 512 || text.slice(pos + 1, end).includes("\n")) continue;
      start = pos + 1;
      value = text.slice(start, end);
    } else {
      BARE_VALUE.lastIndex = pos;
      const v = BARE_VALUE.exec(text);
      if (!v) continue;
      value = v[0].replace(/\.+$/u, ""); // a sentence's full stop is not part of it
      if (value.endsWith(")") && !value.includes("(")) value = value.slice(0, -1); // "(password: x)"
    }
    if (looksSecret(value)) spans.push({ start, end: start + value.length, type: "SECRET", source: "rule" });
  }
  return spans;
}

/** Finds structured personal data and secrets. Spans may overlap; merge them before masking. */
export function detectWithRules(text: string): Span[] {
  const spans: Span[] = [...detectKeywordSecrets(text)];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      let value = m[0];
      if (!value) continue;
      if (rule.validate && !rule.validate(value)) {
        if (!rule.retryShorter) continue;
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
  // "user:pass@host.com" in a URL looks like an email; the password is already a secret.
  const secrets = spans.filter((s) => s.type === "SECRET");
  return spans.filter((s) => s.type !== "EMAIL" || !secrets.some((x) => x.start <= s.start && s.start < x.end));
}
