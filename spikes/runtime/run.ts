// Spike 6: can the detection model run without onnxruntime-node (~550 MB per install)?
// Compares the native runtime with the WebAssembly one (as an npm package, and as the three
// files it needs copied next to our code) on install size, speed, memory and results.
// Usage: node runtime/run.ts   (RUNTIME_MODEL as id@dtype; RUNTIME_INSTALL=0 skips the install measurements)

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { modelFile, modelFiles } from '../pii/ner-wasm.ts';
import { REQUIRED_TYPES, SAMPLES } from '../pii/dataset.ts';
import { OUT_DIR, pct, platform, table, writeReport } from '../lib/report.ts';
import { coverage, type Span } from '../lib/spans.ts';

const MODEL = process.env.RUNTIME_MODEL || 'Xenova/distilbert-base-multilingual-cased-ner-hrl@q8';
const CACHE = join(OUT_DIR, 'hf-cache');
const ROOT = join(import.meta.dirname, '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function dirStats(path: string): { bytes: number; files: number } {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return { bytes: st.size, files: 1 };
    return readdirSync(path).reduce(
      (acc, f) => {
        const s = dirStats(join(path, f));
        return { bytes: acc.bytes + s.bytes, files: acc.files + s.files };
      },
      { bytes: 0, files: 0 },
    );
  } catch {
    return { bytes: 0, files: 0 };
  }
}
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

// 1. Install footprint of each option, each in an empty project with an empty npm cache,
//    so "downloaded" is what a user's first install fetches from the registry.
const WASM_FILES = ['ort.node.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
const version = (pkg: string) => (JSON.parse(readFileSync(join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')) as { version: string }).version;
const ORT_WEB = version('onnxruntime-web');
const ORT_NODE = version('onnxruntime-node');
const TRANSFORMERS = version('@huggingface/transformers');
const TOKENIZERS = version('@huggingface/tokenizers');
const wasmFile = (f: string) => readFileSync(join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', f));
// Shipped inside our package, the files travel compressed like every other tarball: count the gzip size as downloaded.
const vendoredDisk = WASM_FILES.reduce((n, f) => n + wasmFile(f).length, 0);
const vendoredGzip = WASM_FILES.reduce((n, f) => n + gzipSync(wasmFile(f)).length, 0);
const installs: (string | number)[][] = [];
if (process.env.RUNTIME_INSTALL !== '0') {
  const options: { label: string; packages: string[]; env?: Record<string, string>; disk?: number; download?: number }[] = [
    { label: `Native via transformers.js ${TRANSFORMERS} (what spike 1 used)`, packages: [`@huggingface/transformers@${TRANSFORMERS}`] },
    { label: `Native: onnxruntime-node ${ORT_NODE} + tokenizers`, packages: [`onnxruntime-node@${ORT_NODE}`, `@huggingface/tokenizers@${TOKENIZERS}`] },
    {
      label: `Native: onnxruntime-node ${ORT_NODE} + tokenizers, CUDA download skipped (ONNXRUNTIME_NODE_INSTALL=skip)`,
      packages: [`onnxruntime-node@${ORT_NODE}`, `@huggingface/tokenizers@${TOKENIZERS}`],
      env: { ONNXRUNTIME_NODE_INSTALL: 'skip' },
    },
    { label: `WebAssembly: onnxruntime-web ${ORT_WEB} + tokenizers`, packages: [`onnxruntime-web@${ORT_WEB}`, `@huggingface/tokenizers@${TOKENIZERS}`] },
    {
      label: `WebAssembly vendored: onnxruntime-common ${ORT_WEB} + tokenizers, plus ${WASM_FILES.length} runtime files shipped in our package`,
      packages: [`onnxruntime-common@${ORT_WEB}`, `@huggingface/tokenizers@${TOKENIZERS}`],
      disk: vendoredDisk,
      download: vendoredGzip,
    },
  ];
  for (const o of options) {
    const dir = mkdtempSync(join(tmpdir(), 'rt-install-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', private: true, version: '0.0.0' }));
      const t0 = performance.now();
      const r = spawnSync(NPM, ['install', '--no-audit', '--no-fund', '--cache', join(dir, 'cache'), ...o.packages], {
        cwd: dir,
        env: { ...process.env, ...o.env },
        encoding: 'utf8',
        shell: process.platform === 'win32',
        timeout: 10 * 60 * 1000,
      });
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      if (r.status !== 0) {
        installs.push([o.label, 'install failed', (r.error ? String(r.error) : (r.stderr || '').trim().split('\n').slice(-2).join(' ')).slice(0, 160), '', '']);
        process.exitCode = 1;
        continue;
      }
      const nm = dirStats(join(dir, 'node_modules'));
      const native = execFileSync(process.execPath, ['-e', `const f=require('fs'),p=require('path');let n=0;(function w(d){for(const e of f.readdirSync(d,{withFileTypes:true})){const q=p.join(d,e.name);if(e.isDirectory())w(q);else if(/\\.(node|so(\\.\\d+)*|dll|dylib)$/.test(e.name))n++}})(${JSON.stringify(join(dir, 'node_modules'))});console.log(n)`], { encoding: 'utf8' }).trim();
      installs.push([o.label, mb(nm.bytes + (o.disk ?? 0)), mb(dirStats(join(dir, 'cache')).bytes + (o.download ?? 0)), `${secs} s`, native]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// 2. The vendored copy: the three files next to each other, as they would sit in our package.
const vendorDir = join(OUT_DIR, 'vendor-ort');
mkdirSync(vendorDir, { recursive: true });
for (const f of WASM_FILES) copyFileSync(join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', f), join(vendorDir, f));

// 3. The model files, downloaded before any variant runs, so no variant's load time includes the download.
let downloadError = '';
try {
  const [id, dtype = 'q8'] = MODEL.split('@');
  for (const f of modelFiles(dtype)) await modelFile(CACHE, id!, f);
} catch (e) {
  downloadError = (e as Error).message;
  process.exitCode = 1;
}

// 4. Speed, memory and results, each variant in its own process.
type Bare = Pick<Span, 'start' | 'end' | 'type'>;
interface VariantResult {
  loadMs: number;
  firstMs: number;
  msPerSample: number;
  longChars: number;
  msLong: number;
  maxRssMb: number;
  nativeLibs: string[];
  spans: Bare[][];
  pipeline: Bare[][];
  masked: string[];
}
const cores = availableParallelism();
const many = Math.min(4, cores);
const variants: { label: string; args: string[] }[] = [
  { label: `Native (onnxruntime-node ${ORT_NODE}, CPU), ${many} threads`, args: ['native', String(many)] },
  { label: `WebAssembly (onnxruntime-web ${ORT_WEB}), 1 thread`, args: ['wasm', '1'] },
  { label: `WebAssembly (onnxruntime-web ${ORT_WEB}), ${many} threads`, args: ['wasm', String(many)] },
  { label: `WebAssembly vendored files, ${many} threads`, args: ['vendored', String(many)] },
];
const runs: { label: string; r?: VariantResult; error?: string }[] = [];
for (const v of downloadError ? [] : variants) {
  const p = spawnSync(process.execPath, [join(import.meta.dirname, 'variant.ts'), ...v.args, MODEL, CACHE, join(vendorDir, 'ort.node.min.mjs')], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  const line = p.stdout.trim().split('\n').at(-1) ?? '';
  try {
    runs.push({ label: v.label, r: JSON.parse(line) as VariantResult });
  } catch {
    const lines = `${p.stderr}\n${p.stdout}`.split('\n');
    const reason = lines.find((l) => /^\s*(\[cause\]: )?\w*Error:/.test(l)) ?? (p.error ? String(p.error) : lines.filter(Boolean).at(-1));
    runs.push({ label: v.label, error: (reason ?? 'no output').trim().slice(0, 200) });
    process.exitCode = 1;
  }
}

const base = runs[0]?.r;
const same = (a: Bare[], b: Bare[]) => a.length === b.length && a.every((s, i) => s.start === b[i]!.start && s.end === b[i]!.end && s.type === b[i]!.type);
function requiredFull(r: VariantResult): string {
  let full = 0;
  let total = 0;
  SAMPLES.forEach((s, i) => {
    for (const g of s.gold) {
      if (!REQUIRED_TYPES.includes(g.type)) continue;
      total++;
      if (coverage(s.text, g.start, g.end, r.pipeline[i]! as Span[]) === 1) full++;
    }
  });
  return pct(full, total);
}

let md = `## Spike 6: model runtime (${platform()}, ${cores} cores)\n\nModel: ${MODEL}. ${SAMPLES.length} sentences, three passes; the long text is ${runs.find((x) => x.r)?.r?.longChars ?? '?'} characters, three passes. Each variant runs once, in its own process.\n\n`;
if (installs.length) {
  md += `### Install footprint\n\nEach option installed into an empty project with an empty npm cache.\n\n`;
  md += table(['Option', 'On disk', 'Downloaded', 'Install time', 'Native binaries'], installs) + '\n\n';
  md += `"Downloaded" is the npm cache after the install. On Linux x64, onnxruntime-node's install script also fetches the CUDA provider from NuGet (about 236 MB), which is not in the npm cache but is on disk. Vendored files count at their gzip size.\n\n`;
}
md += `### Speed, memory and results\n\n`;
if (downloadError) md += `The model could not be downloaded, so no variant ran: ${downloadError}\n\n`;
md += table(
  ['Runtime', 'Load', 'First sentence', 'ms per sentence', 'ms per long text', 'Peak memory', 'Native libraries loaded', 'Model spans identical to native', 'Masked text identical to native', 'Required entities masked (whole pipeline)'],
  runs.map(({ label, r, error }) =>
    r
      ? [
          label,
          `${r.loadMs.toFixed(0)} ms`,
          `${r.firstMs.toFixed(0)} ms`,
          r.msPerSample.toFixed(1),
          r.msLong.toFixed(0),
          `${r.maxRssMb.toFixed(0)} MB`,
          r.nativeLibs.length ? r.nativeLibs.join(' ') : 'none',
          base ? `${r.spans.filter((s, i) => same(s, base.spans[i]!)).length}/${SAMPLES.length}` : 'n/a',
          base ? `${r.masked.filter((m, i) => m === base.masked[i]).length}/${SAMPLES.length}` : 'n/a',
          requiredFull(r),
        ]
      : [label, 'failed', error ?? '', '', '', '', '', '', '', ''],
  ),
);
const diffs = base
  ? runs.slice(1).flatMap(({ label, r }) => (r ? SAMPLES.flatMap((s, i) => (r.masked[i] === base.masked[i] ? [] : [`- ${label}, [${s.lang}]: native "${base.masked[i]}" vs "${r.masked[i]}"`])) : []))
  : [];
md += diffs.length ? `\n\nDifferences from native:\n\n${diffs.slice(0, 20).join('\n')}\n` : '\n';
writeReport(`runtime-${process.platform}`, md, { model: MODEL, cores, installs, runs: runs.map(({ label, r, error }) => ({ label, error, ...(r ? { loadMs: r.loadMs, firstMs: r.firstMs, msPerSample: r.msPerSample, msLong: r.msLong, maxRssMb: r.maxRssMb, nativeLibs: r.nativeLibs } : {}) })) });
