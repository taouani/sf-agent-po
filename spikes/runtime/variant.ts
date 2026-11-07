// One runtime variant in its own process (WebAssembly thread settings are per process).
// Usage: node runtime/variant.ts <native|wasm|vendored> <threads> <model id@dtype> <cacheDir> [vendored entry]
// Prints one JSON line with timings and what it detected.

import { KNOWN_NAMES, SAMPLES } from '../pii/dataset.ts';
import { loadNer, type NerModel } from '../pii/ner.ts';
import { loadNerWasm } from '../pii/ner-wasm.ts';
import { detectWithDictionary, detectWithRules, dropAllowlisted } from '../lib/rules.ts';
import { maskText, mergeSpans, type Span } from '../lib/spans.ts';

const [kind, threadsArg, spec, cacheDir, entry] = process.argv.slice(2);
const [id, dtype = 'q8'] = spec!.split('@');
const threads = Number(threadsArg);

const t0 = performance.now();
let model: NerModel;
if (kind === 'native') model = await loadNer(id!, dtype, cacheDir);
else model = await loadNerWasm(id!, dtype, { cacheDir: cacheDir!, threads, runtime: kind === 'vendored' ? entry : undefined });
const loadMs = performance.now() - t0;

const t1 = performance.now();
await model.detect(SAMPLES[0]!.text);
const firstMs = performance.now() - t1;

// Three passes over every sample; the spans come from the first.
type Bare = Pick<Span, 'start' | 'end' | 'type'>;
const spans: Bare[][] = [];
const masked: string[] = [];
const pipeline: Bare[][] = [];
const t2 = performance.now();
for (let pass = 0; pass < 3; pass++) {
  for (const s of SAMPLES) {
    const found = await model.detect(s.text);
    if (pass) continue;
    spans.push(found.map(({ start, end, type }) => ({ start, end, type })));
    const all = dropAllowlisted(s.text, [...detectWithRules(s.text), ...detectWithDictionary(s.text, KNOWN_NAMES), ...found]);
    const merged = mergeSpans(all);
    pipeline.push(merged.map(({ start, end, type }) => ({ start, end, type })));
    masked.push(maskText(s.text, merged));
  }
}
const msPerSample = (performance.now() - t2) / (3 * SAMPLES.length);

console.log(JSON.stringify({ loadMs, firstMs, msPerSample, maxRssMb: process.resourceUsage().maxRSS / 1024, spans, pipeline, masked }));
// WebAssembly worker threads would otherwise keep the process alive.
process.exit(0);
