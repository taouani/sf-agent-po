// Spike 1 and 5: how well can local detection find personal data and secrets in
// English, French and Chinese, and may we ship the model?
//
// Usage: node pii/run.ts   (models from PII_MODELS as "id@dtype,id@dtype"; empty means the defaults)
// Needs network access to huggingface.co the first time a model is downloaded.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_NAMES, REQUIRED_TYPES, SAMPLES, type Sample } from './dataset.ts';
import { loadNer, type NerModel } from './ner.ts';
import { detectWithDictionary, detectWithRules, dropAllowlisted } from '../lib/rules.ts';
import { coverage, maskText, mergeSpans, type Span } from '../lib/spans.ts';
import { OUT_DIR, pct, platform, table, writeReport } from '../lib/report.ts';

const DEFAULT_MODELS = [
  'Xenova/bert-base-multilingual-cased-ner-hrl@q8',
  'Xenova/bert-base-multilingual-cased-ner-hrl@fp32',
  'Xenova/distilbert-base-multilingual-cased-ner-hrl@q8',
  'Xenova/distilbert-base-multilingual-cased-ner-hrl@fp32',
];
const requested = (process.env.PII_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const configs = (requested.length ? requested : DEFAULT_MODELS).map((s) => {
  const [id, dtype = 'q8'] = s.split('@');
  return { id: id!, dtype };
});
const CACHE = join(OUT_DIR, 'hf-cache');

type Detector = (s: Sample) => Promise<Span[]>;

interface Score {
  label: string;
  required: { full: number; partial: number; total: number };
  byLang: Record<string, { full: number; total: number }>;
  byType: Record<string, { full: number; total: number }>;
  person: Record<string, { full: number; total: number }>;
  maskedChars: number; // non-space characters masked
  maskedOutside: number; // of which outside every gold entity (over-masking)
  falsePositives: string[];
  domainMasks: string[];
  msPerSample: number;
  masked: string[];
}

async function evaluate(label: string, detect: Detector): Promise<Score> {
  const score: Score = {
    label,
    required: { full: 0, partial: 0, total: 0 },
    byLang: {},
    byType: {},
    person: {},
    maskedChars: 0,
    maskedOutside: 0,
    falsePositives: [],
    domainMasks: [],
    msPerSample: 0,
    masked: [],
  };
  const t0 = performance.now();
  for (const s of SAMPLES) {
    const spans = mergeSpans(await detect(s));
    score.masked.push(`[${s.lang}] ${maskText(s.text, spans)}`);
    for (const g of s.gold) {
      const c = coverage(s.text, g.start, g.end, spans);
      const bt = (score.byType[g.type] ??= { full: 0, total: 0 });
      bt.total++;
      if (c === 1) bt.full++;
      if (!REQUIRED_TYPES.includes(g.type)) continue;
      score.required.total++;
      if (c === 1) score.required.full++;
      if (c >= 0.5) score.required.partial++;
      const bl = (score.byLang[s.lang] ??= { full: 0, total: 0 });
      bl.total++;
      if (c === 1) bl.full++;
      if (g.type === 'PERSON') {
        const bp = (score.person[s.lang] ??= { full: 0, total: 0 });
        bp.total++;
        if (c === 1) bp.full++;
      }
    }
    // Over-masking: masked characters that belong to no gold entity, even inside a span that
    // also covers one ("Mme Hélène Garnier au" counts "Mme" and "au").
    for (const sp of spans)
      for (let i = sp.start; i < sp.end; i++) {
        if (/\s/.test(s.text[i]!)) continue;
        score.maskedChars++;
        if (!s.gold.some((g) => g.start <= i && i < g.end)) score.maskedOutside++;
      }
    for (const sp of spans) {
      if (s.gold.some((g) => sp.start < g.end && g.start < sp.end)) continue;
      const entry = `${sp.type} "${s.text.slice(sp.start, sp.end)}" (${s.lang})`;
      if (s.gold.length === 0) score.domainMasks.push(entry);
      else score.falsePositives.push(entry);
    }
  }
  score.msPerSample = (performance.now() - t0) / SAMPLES.length;
  return score;
}

function dirSize(path: string): number {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    return readdirSync(path).reduce((n, f) => n + dirSize(join(path, f)), 0);
  } catch {
    return 0;
  }
}

async function hfJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'user-agent': 'sf-agent-po-spike' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function licences(ids: string[]): Promise<string> {
  const rows: string[][] = [];
  for (const id of ids) {
    try {
      const m = await hfJson(`https://huggingface.co/api/models/${id}`);
      const lic = m.cardData?.license ?? m.tags?.find((t: string) => t.startsWith('license:'))?.slice(8) ?? 'none stated';
      const base = m.cardData?.base_model ?? m.tags?.find((t: string) => t.startsWith('base_model:') && !t.includes(':finetune:') && !t.includes(':quantized:'))?.slice(11);
      let baseLic = '';
      if (base) {
        const b = await hfJson(`https://huggingface.co/api/models/${Array.isArray(base) ? base[0] : base}`).catch(() => null);
        baseLic = b ? `${Array.isArray(base) ? base[0] : base}: ${b.cardData?.license ?? 'none stated'}` : `${base}: lookup failed`;
      }
      rows.push([id, lic, baseLic || 'n/a', (m.cardData?.language ?? []).length ? String(m.cardData.language.length) + ' langs' : 'not listed']);
    } catch (e) {
      rows.push([id, `lookup failed: ${(e as Error).message}`, '', '']);
    }
  }
  return table(['Model', 'Licence', 'Base model licence', 'Languages'], rows);
}

async function discover(): Promise<string> {
  try {
    const list: any[] = await hfJson(
      'https://huggingface.co/api/models?pipeline_tag=token-classification&library=transformers.js&sort=downloads&direction=-1&limit=60&full=true',
    );
    const rows = list
      .map((m) => {
        const tags: string[] = m.tags ?? [];
        const langs = tags.filter((t) => /^[a-z]{2,3}$/.test(t));
        const lic = tags.find((t) => t.startsWith('license:'))?.slice(8) ?? '?';
        return { id: m.id as string, downloads: m.downloads as number, langs, lic, multi: tags.includes('multilingual') || langs.length >= 3 };
      })
      .filter((m) => m.multi || /pii|privacy|anonym|deid|redact/i.test(m.id));
    return table(
      ['Candidate (transformers.js, token classification)', 'Downloads', 'Licence', 'Languages'],
      rows.map((m) => [m.id, m.downloads, m.lic, m.langs.join(' ') || 'multilingual tag']),
    );
  } catch (e) {
    return `Discovery failed: ${(e as Error).message}`;
  }
}

const rulesAndDict = (s: Sample) => [...detectWithRules(s.text), ...detectWithDictionary(s.text, KNOWN_NAMES)];

const results: Score[] = [];
results.push(await evaluate('rules + dictionary (no model)', async (s) => rulesAndDict(s)));
const loadInfo: string[][] = [];
for (const c of configs) {
  let model: NerModel;
  const t0 = performance.now();
  try {
    model = await loadNer(c.id, c.dtype, CACHE);
  } catch (e) {
    loadInfo.push([`${c.id}@${c.dtype}`, 'failed to load', (e as Error).message.slice(0, 160), '', '']);
    process.exitCode = 1; // never let CI look green with rules-only results
    continue;
  }
  const loadMs = Math.round(performance.now() - t0);
  loadInfo.push([`${c.id}@${c.dtype}`, `${loadMs} ms`, model.labels.join(' '), `${(dirSize(join(CACHE, c.id)) / 1e6).toFixed(0)} MB cached (all dtypes so far)`]);
  results.push(await evaluate(`${c.id}@${c.dtype}: model only`, (s) => model.detect(s.text)));
  results.push(
    await evaluate(`${c.id}@${c.dtype}: rules + dictionary + model`, async (s) =>
      dropAllowlisted(s.text, [...rulesAndDict(s), ...(await model.detect(s.text))]),
    ),
  );
  loadInfo[loadInfo.length - 1]!.push(pct(model.stats.unaligned, model.stats.tokens));
}

const types = [...new Set(SAMPLES.flatMap((s) => s.gold.map((g) => g.type)))];
let md = `## Spike 1: PII detection (${platform()})\n\n`;
md += `${SAMPLES.length} sentences (${SAMPLES.filter((s) => s.gold.length === 0).length} with no personal data). "Full" means every character of the entity is masked.\n\n`;
md += table(
  ['Detector', 'Required types, full', 'Required, at least half', 'EN', 'FR', 'ZH', 'Persons EN / FR / ZH', 'False positives', 'Domain terms masked', 'Masked chars outside entities', 'ms per sentence'],
  results.map((r) => [
    r.label,
    pct(r.required.full, r.required.total),
    pct(r.required.partial, r.required.total),
    pct(r.byLang.en?.full ?? 0, r.byLang.en?.total ?? 0),
    pct(r.byLang.fr?.full ?? 0, r.byLang.fr?.total ?? 0),
    pct(r.byLang.zh?.full ?? 0, r.byLang.zh?.total ?? 0),
    ['en', 'fr', 'zh'].map((l) => `${r.person[l]?.full ?? 0}/${r.person[l]?.total ?? 0}`).join(' · '),
    r.falsePositives.length,
    r.domainMasks.length,
    pct(r.maskedOutside, r.maskedChars),
    r.msPerSample.toFixed(1),
  ]),
);
md += '\n\n### Full-coverage recall by type\n\n';
md += table(['Detector', ...types], results.map((r) => [r.label, ...types.map((t) => `${r.byType[t]?.full ?? 0}/${r.byType[t]?.total ?? 0}`)]));
md += '\n\n### Model loading\n\n' + table(['Model', 'Load time', 'Labels', 'Size', 'Tokens not mapped to text'], loadInfo);
md += '\n\n### Licences (spike 5)\n\n' + (await licences([...new Set(configs.map((c) => c.id))]));
md += '\n\n### Other candidates on the Hub\n\n' + (await discover());
let details = md + '\n\n## Details\n';
for (const r of results) {
  details += `\n### ${r.label}\n\nFalse positives: ${r.falsePositives.join('; ') || 'none'}\n\nDomain terms masked: ${r.domainMasks.join('; ') || 'none'}\n\n`;
  details += r.masked.map((m) => `- ${m}`).join('\n') + '\n';
}
writeReport('pii', md, results);
writeReport('pii-details', details, undefined, { summary: false });
