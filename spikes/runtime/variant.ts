// One runtime variant in its own process (WebAssembly thread settings are per process).
// Usage: node runtime/variant.ts <native|wasm|vendored> <threads> <model id@dtype> <cacheDir> [vendored entry]
// Prints one JSON line with timings, what it detected, and which native libraries the process loaded.

import { KNOWN_NAMES, SAMPLES } from '../pii/dataset.ts';
import type { NerModel } from '../pii/decode.ts';
import { detectWithDictionary, detectWithRules, dropAllowlisted } from '../lib/rules.ts';
import { maskText, mergeSpans, type Span } from '../lib/spans.ts';

const [kind, threadsArg, spec, cacheDir, entry] = process.argv.slice(2);
const [id, dtype = 'q8'] = spec!.split('@');
const threads = Number(threadsArg);

// The loader is imported inside the timed window, so both sides pay for loading their runtime,
// and a WebAssembly process never imports transformers.js or onnxruntime-node.
const t0 = performance.now();
let model: NerModel;
if (kind === 'native') model = await (await import('../pii/ner.ts')).loadNer(id!, dtype, cacheDir, threads);
else model = await (await import('../pii/ner-wasm.ts')).loadNerWasm(id!, dtype, { cacheDir: cacheDir!, threads, runtime: kind === 'vendored' ? entry : undefined });
const loadMs = performance.now() - t0;

const t1 = performance.now();
await model.detect(SAMPLES[0]!.text);
const firstMs = performance.now() - t1;

// Three passes over every sample; the spans come from the first.
type Bare = Pick<Span, 'start' | 'end' | 'type'>;
const spans: Bare[][] = [];
const pipeline: Bare[][] = [];
const masked: string[] = [];
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

// A long text, close to one full window: the samples joined until about 1,400 characters.
let long = '';
for (const s of SAMPLES) if (long.length + s.text.length < 1400) long += `${s.text}\n`;
const t3 = performance.now();
for (let i = 0; i < 3; i++) await model.detect(long);
const msLong = (performance.now() - t3) / 3;

const report = process.report.getReport() as unknown as { sharedObjects?: string[] };
const nativeLibs = (report.sharedObjects ?? []).filter((f) => /onnxruntime|sharp|vips/i.test(f)).map((f) => f.split(/[\\/]/).pop());

console.log(JSON.stringify({ loadMs, firstMs, msPerSample, longChars: long.length, msLong, maxRssMb: process.resourceUsage().maxRSS / 1024, nativeLibs, spans, pipeline, masked }));
// WebAssembly worker threads would otherwise keep the process alive.
process.exit(0);
