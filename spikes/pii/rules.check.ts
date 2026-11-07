// Checks the rule layer alone, with no model: every structured item in the dataset must be
// fully covered, nothing outside the gold entities may be flagged, plus a few edge cases.
// Exits non-zero on any problem so CI goes red.
import { SAMPLES } from './dataset.ts';
import { detectWithRules } from '../lib/rules.ts';
import { coverage, mergeSpans } from '../lib/spans.ts';

const STRUCTURED = ['EMAIL', 'PHONE', 'IBAN', 'CARD', 'NATIONAL_ID', 'SECRET', 'IP'];
let problems = 0;
const fail = (msg: string) => {
  problems++;
  console.log(msg);
};

for (const s of SAMPLES) {
  const spans = mergeSpans(detectWithRules(s.text));
  for (const g of s.gold) {
    const c = coverage(s.text, g.start, g.end, spans);
    if (STRUCTURED.includes(g.type) && c < 1) fail(`MISS ${g.type} ${(c * 100).toFixed(0)}% "${g.value}" in: ${s.text}`);
  }
  for (const sp of spans) {
    if (!s.gold.some((g) => sp.start < g.end && g.start < sp.end)) {
      fail(`FALSE POSITIVE ${sp.type} "${s.text.slice(sp.start, sp.end)}" in: ${s.text}`);
    }
  }
}

// Edge cases: [text, expected masked strings]
const CASES: [string, string[]][] = [
  ['Card 4111 1111 1111 1111 12/27 on file', ['4111 1111 1111 1111']],
  ['IBAN BE68 5390 0754 7034 2024 for the refund', ['BE68 5390 0754 7034']],
  ['The secretary is Marie Dupont', []],
  ['The token is valid until Friday', []],
  ['password: hunter2!', ['hunter2!']],
];
for (const [text, expected] of CASES) {
  const got = mergeSpans(detectWithRules(text)).map((s) => text.slice(s.start, s.end));
  if (JSON.stringify(got) !== JSON.stringify(expected)) fail(`EDGE CASE "${text}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
}

console.log(problems ? `rule check: ${problems} problem(s)` : 'rule check passed');
if (problems) process.exitCode = 1;
