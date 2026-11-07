// The same NER model as ner.ts, run with the WebAssembly build of ONNX Runtime
// (onnxruntime-web) and the pure-JS tokenizer, without @huggingface/transformers.
// That drops onnxruntime-node: no native binaries, no install script, no CUDA download.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tokenizer } from '@huggingface/tokenizers';
import type * as Ort from 'onnxruntime-web';
import type { Span } from '../lib/spans.ts';
import { decodeSpans, type NerModel } from './decode.ts';

/** transformers.js names quantised ONNX files by suffix; the spike uses the same files. */
const DTYPE_SUFFIX: Record<string, string> = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', bnb4: '_bnb4' };

export interface WasmOptions {
  /** Where the model files are, laid out as transformers.js caches them (`<cacheDir>/<id>/...`). Missing files are downloaded. */
  cacheDir: string;
  /** WebAssembly threads; 1 runs on the main thread only. */
  threads: number;
  /** The runtime's entry module: the npm package, or a path to a vendored copy of ort.node.min.mjs. */
  runtime?: string;
}

/** A model file from the cache, downloaded first when missing (written to a temporary name, so a cut download is never taken as complete). */
export async function modelFile(cacheDir: string, id: string, file: string): Promise<string> {
  const path = join(cacheDir, id, file);
  if (existsSync(path)) return path;
  const url = `https://huggingface.co/${id}/resolve/main/${file}`;
  const res = await fetch(url, { headers: { 'user-agent': 'sf-agent-po-spike' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, Buffer.from(await res.arrayBuffer()));
  await rename(partial, path);
  return path;
}

const json = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;

/** The files a token-classification model needs, as transformers.js lays them out. */
export function modelFiles(dtype: string): string[] {
  const suffix = DTYPE_SUFFIX[dtype];
  if (suffix === undefined) throw new Error(`unknown dtype ${dtype}`);
  return ['config.json', 'tokenizer.json', 'tokenizer_config.json', `onnx/model${suffix}.onnx`];
}

export async function loadNerWasm(id: string, dtype: string, opts: WasmOptions): Promise<NerModel> {
  const files = modelFiles(dtype);
  const ort = (await import(opts.runtime ? pathToFileURL(opts.runtime).href : 'onnxruntime-web')) as typeof Ort;
  ort.env.wasm.numThreads = opts.threads;
  const [config, tokenizerJson, tokenizerConfig, onnx] = await Promise.all([
    modelFile(opts.cacheDir, id, files[0]!).then(json),
    modelFile(opts.cacheDir, id, files[1]!).then(json),
    modelFile(opts.cacheDir, id, files[2]!).then(json),
    modelFile(opts.cacheDir, id, files[3]!),
  ]);
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  const session = await ort.InferenceSession.create(new Uint8Array(await readFile(onnx)), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const id2label: Record<string, string> = config.id2label ?? {};
  const stats = { tokens: 0, unaligned: 0 };
  return {
    id,
    dtype,
    labels: Object.values(id2label),
    stats,
    async detect(text: string): Promise<Span[]> {
      const enc = tokenizer.encode(text, { return_token_type_ids: true });
      const n = enc.ids.length;
      if (n > 512) throw new Error(`text too long for one window: ${n} tokens`);
      const tensor = (values: number[]) => new ort.Tensor('int64', BigInt64Array.from(values, (v) => BigInt(v)), [1, n]);
      const feeds: Record<string, Ort.Tensor> = {};
      for (const name of session.inputNames) {
        if (name === 'input_ids') feeds[name] = tensor(enc.ids);
        else if (name === 'attention_mask') feeds[name] = tensor(enc.attention_mask);
        else if (name === 'token_type_ids') feeds[name] = tensor(enc.token_type_ids ?? new Array<number>(n).fill(0));
        else throw new Error(`unexpected model input ${name}`);
      }
      const out = await session.run(feeds);
      const logits = out.logits ?? out[session.outputNames[0]!]!;
      const [, seqLen, numLabels] = logits.dims as number[];
      return decodeSpans(text, enc.tokens, logits.data as Float32Array, seqLen!, numLabels!, id2label, stats);
    },
  };
}
