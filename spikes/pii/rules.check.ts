// Quick check of the rule layer alone: prints recall per type with no model involved.
import { SAMPLES } from './dataset.ts';
import { detectWithRules } from '../lib/rules.ts';
import { coverage, mergeSpans } from '../lib/spans.ts';

for (const s of SAMPLES) {
  const spans = mergeSpans(detectWithRules(s.text));
  for (const g of s.gold) {
    const c = coverage(s.text, g.start, g.end, spans);
    if (['EMAIL', 'PHONE', 'IBAN', 'CARD', 'NATIONAL_ID', 'SECRET', 'IP'].includes(g.type) && c < 1) {
      console.log(`MISS ${g.type} ${(c * 100).toFixed(0)}% "${g.value}" in: ${s.text}`);
    }
  }
  for (const sp of spans) {
    if (!s.gold.some((g) => sp.start < g.end && g.start < sp.end)) {
      console.log(`FALSE POSITIVE ${sp.type} "${s.text.slice(sp.start, sp.end)}" in: ${s.text}`);
    }
  }
}
console.log('rule check done');
