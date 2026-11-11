// The detection model (names, and places and organisations that the policy leaves visible),
// run on the WebAssembly build of ONNX Runtime that this package ships (decision RT1).

import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Ort from "onnxruntime-common";
import type { EntityDetector } from "../detect.js";
import type { Span } from "../spans.js";
import { decodeSpans, type DecodeStats } from "./decode.js";
import { DEFAULT_MODEL, defaultModelDir, modelFile, type Fetch, type ModelManifest } from "./files.js";

/** The vendored runtime entry, the same path from src/ and from dist/. */
export const VENDORED_RUNTIME = fileURLToPath(new URL("../../../vendor/onnxruntime-web/ort.node.min.mjs", import.meta.url));

export interface ModelOptions {
  /** Where model files are cached; defaults to defaultModelDir(). */
  dir?: string;
  manifest?: ModelManifest;
  /**
   * WebAssembly threads; defaults to up to 4. The runtime reads it once per process, when
   * the first model loads, so later loads keep the first value.
   */
  threads?: number;
  /** The runtime entry module; defaults to the vendored copy. */
  runtime?: string;
  fetch?: Fetch;
  /** Gives up on a download after this long; 15 minutes by default. */
  timeoutMs?: number;
}

/** A model input of at most this many tokens; the model's limit is 512, with room for its two markers. */
const MAX_TOKENS = 510;
/** Text is cut into pieces of at most this many characters before it is tokenised. */
const MAX_CHARS = 1000;

/** The part of a tokenizer and an inference session the detector uses, so tests can fake them. */
export interface Encoded {
  ids: number[];
  tokens: string[];
  attention_mask: number[];
  token_type_ids?: number[];
}
export interface ModelRunner {
  encode(text: string): Encoded;
  /** Runs the model on one encoded piece; returns logits as [seqLen × numLabels]. */
  run(enc: Encoded): Promise<{ logits: Float32Array; seqLen: number; numLabels: number }>;
  id2label: Readonly<Record<string, string>>;
}

export interface DetectionModel {
  detect: EntityDetector;
  /** Tokens seen and tokens that could not be placed in the text, in the runs made (an answer a Masker kept is not run again). */
  stats: DecodeStats;
  /** Frees the session. WebAssembly worker threads may still keep the process alive; a CLI should exit explicitly. */
  release(): Promise<void>;
}

/** Characters repeated at the start of a piece that was cut at a space, so a name across the cut is seen whole. */
const OVERLAP = 64;

/**
 * Cuts `text` into pieces of at most `max` characters, preferring line ends, then sentence
 * ends, then commas, then spaces. A piece cut at a space starts again up to OVERLAP
 * characters (whole words) before the cut, so a name is never only seen in halves; spans
 * found twice are merged later. Returns [start, end) offsets that cover the text.
 */
export function splitText(text: string, max = MAX_CHARS): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  while (text.length - start > max) {
    const window = text.slice(start, start + max);
    let cut = -1;
    let atSpace = false;
    for (const [i, re] of [/\n/gu, /[.!?。！？](?=\s)|[。！？]/gu, /[；，;,]/gu, /\s/gu].entries()) {
      let last = -1;
      for (const m of window.matchAll(re)) last = m.index;
      if (last > max / 4) {
        cut = last + 1;
        atSpace = i === 3;
        break;
      }
    }
    if (cut < 0) cut = max;
    out.push([start, start + cut]);
    let next = start + cut;
    if (atSpace) {
      // Back up to the start of a word at most OVERLAP characters before the cut.
      const back = text.slice(next - OVERLAP, next - 1);
      const space = back.search(/\s\S/u);
      if (space >= 0) next = next - OVERLAP + space + 1;
    }
    start = next;
  }
  if (start < text.length || out.length === 0) out.push([start, text.length]);
  return out;
}

/** The detector over a runner: pieces that are too long for the model are halved until they fit. */
export function detectorFor(runner: ModelRunner, stats: DecodeStats = { tokens: 0, unaligned: 0 }): EntityDetector {
  const piece = async (text: string, offset: number): Promise<Span[]> => {
    if (!text.trim()) return [];
    const enc = runner.encode(text);
    if (enc.ids.length > MAX_TOKENS + 2) {
      const [[, mid]] = splitText(text, Math.ceil(text.length / 2)) as [[number, number]];
      return [...(await piece(text.slice(0, mid), offset)), ...(await piece(text.slice(mid), offset + mid))];
    }
    const { logits, seqLen, numLabels } = await runner.run(enc);
    return decodeSpans(text, enc.tokens, logits, seqLen, numLabels, runner.id2label, stats).map((s) => ({
      ...s,
      start: s.start + offset,
      end: s.end + offset,
    }));
  };
  return async (text: string) => {
    const spans: Span[] = [];
    for (const [start, end] of splitText(text)) spans.push(...(await piece(text.slice(start, end), start)));
    return spans;
  };
}

/**
 * Runs work one piece at a time, in order; a failure goes to its caller and does not stop
 * the next piece.
 */
export function serialQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = last.then(work, work);
    last = next.catch(() => undefined);
    return next;
  };
}

/**
 * One queue per loaded runtime. The WebAssembly runtime fails ("failed to call OrtRun()")
 * when a run starts before the last one ends, as two tool calls at once would do: every run
 * uses the one WebAssembly stack, so this holds across sessions, and for releasing one too.
 */
const queues = new WeakMap<object, ReturnType<typeof serialQueue>>();
function queueFor(runtime: object): ReturnType<typeof serialQueue> {
  let queue = queues.get(runtime);
  if (!queue) queues.set(runtime, (queue = serialQueue()));
  return queue;
}

const json = (bytes: Buffer) => JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;

/**
 * Loads the detection model: downloads and checks its files on first use (about 138 MB),
 * then runs it on the WebAssembly runtime shipped in this package. No native code.
 */
export async function loadDetectionModel(opts: ModelOptions = {}): Promise<DetectionModel> {
  const manifest = opts.manifest ?? DEFAULT_MODEL;
  const dir = opts.dir ?? defaultModelDir();
  const runtime = opts.runtime ?? VENDORED_RUNTIME;
  if (!existsSync(runtime)) throw new Error(`The model runtime is missing at ${runtime}; run "npm run vendor -w @sf-agent-po/core".`);
  const ort = (await import(pathToFileURL(runtime).href)) as typeof Ort;
  ort.env.wasm.numThreads = opts.threads ?? Math.min(4, availableParallelism());
  const get = (f: ModelManifest["files"][keyof ModelManifest["files"]]) => modelFile(dir, manifest, f, { fetch: opts.fetch, timeoutMs: opts.timeoutMs });
  const [config, tokenizerJson, tokenizerConfig, onnx] = await Promise.all([
    get(manifest.files.config).then(json),
    get(manifest.files.tokenizer).then(json),
    get(manifest.files.tokenizerConfig).then(json),
    get(manifest.files.onnx),
  ]);
  // Loaded here, so importing the core package does not load the tokenizer.
  const { Tokenizer } = await import("@huggingface/tokenizers");
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  // The checked bytes go straight to the runtime: no second read, no copy.
  const session = await ort.InferenceSession.create(onnx, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  const oneAtATime = queueFor(ort);
  const runner: ModelRunner = {
    id2label: (config.id2label ?? {}) as Record<string, string>,
    encode: (text) => tokenizer.encode(text, { return_token_type_ids: true }) as Encoded,
    async run(enc) {
      const n = enc.ids.length;
      const tensor = (values: number[]) => new ort.Tensor("int64", BigInt64Array.from(values, (v) => BigInt(v)), [1, n]);
      const feeds: Record<string, Ort.Tensor> = {};
      for (const name of session.inputNames) {
        if (name === "input_ids") feeds[name] = tensor(enc.ids);
        else if (name === "attention_mask") feeds[name] = tensor(enc.attention_mask);
        else if (name === "token_type_ids") feeds[name] = tensor(enc.token_type_ids ?? new Array<number>(n).fill(0));
        else throw new Error(`Unexpected model input ${name}`);
      }
      const out = await oneAtATime(() => session.run(feeds));
      const logits = out.logits ?? out[session.outputNames[0]!]!;
      const [, seqLen, numLabels] = logits.dims as number[];
      return { logits: logits.data as Float32Array, seqLen: seqLen!, numLabels: numLabels! };
    },
  };
  const stats: DecodeStats = { tokens: 0, unaligned: 0 };
  return { detect: detectorFor(runner, stats), stats, release: () => oneAtATime(() => session.release()) };
}
