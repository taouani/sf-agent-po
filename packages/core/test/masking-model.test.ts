import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  alignTokens,
  decodeSpans,
  defaultModelDir,
  detect,
  detectorFor,
  labelType,
  loadDetectionModel,
  modelFile,
  splitText,
  VENDORED_RUNTIME,
  type ModelManifest,
  type ModelRunner,
  type Span,
} from "../src/index.js";
import { KNOWN_NAMES, SAMPLES } from "./fixtures/pii-samples.js";

const tmp = mkdtempSync(join(tmpdir(), "sf-agent-po-model-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("decoding the model's output", () => {
  const id2label = { 0: "O", 1: "B-PER", 2: "I-PER", 3: "B-LOC", 4: "I-LOC" };
  /** Logits that pick one label per token. */
  const logitsFor = (labels: number[]) => Float32Array.from(labels.flatMap((l) => [0, 1, 2, 3, 4].map((k) => (k === l ? 5 : 0))));

  it("maps labels to masking types", () => {
    expect([labelType("O"), labelType("B-PER"), labelType("I-LOC"), labelType("B-ORG"), labelType("DATE")]).toEqual([null, "PERSON", "LOCATION", "ORG", "DATE"]);
  });

  it("aligns WordPiece tokens and joins a name's pieces", () => {
    const text = "Call Kenji Watanabe in Tokyo";
    const tokens = ["[CLS]", "Call", "Ken", "##ji", "Wat", "##ana", "##be", "in", "Tokyo", "[SEP]"];
    expect(alignTokens(text, tokens).slice(2, 4)).toEqual([
      { start: 5, end: 8, continuation: false },
      { start: 8, end: 10, continuation: true },
    ]);
    const spans = decodeSpans(text, tokens, logitsFor([0, 0, 1, 0, 2, 0, 0, 0, 3, 0]), tokens.length, 5, id2label);
    expect(spans.map((s) => [text.slice(s.start, s.end), s.type])).toEqual([["Kenji Watanabe", "PERSON"], ["Tokyo", "LOCATION"]]);
  });

  it("grows a partly tagged word to the whole word", () => {
    const text = "Ask Margaux";
    const tokens = ["[CLS]", "Ask", "Mar", "##ga", "##ux", "[SEP]"];
    // Only the second piece is tagged; the span still covers the whole name.
    const spans = decodeSpans(text, tokens, logitsFor([0, 0, 0, 1, 0, 0]), tokens.length, 5, id2label);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Margaux"]);
  });
});

describe("cutting text for the model", () => {
  it("covers the text with pieces of at most the limit, cut at line and sentence ends", () => {
    const text = `${"First line about Sarah Whitfield.\n".repeat(40)}${"word ".repeat(300)}${"x".repeat(2500)}`;
    const pieces = splitText(text, 1000);
    expect(pieces[0]![0]).toBe(0);
    expect(pieces.at(-1)![1]).toBe(text.length);
    for (const [i, [start, end]] of pieces.entries()) {
      expect(end - start).toBeLessThanOrEqual(1000);
      if (i) expect(start).toBe(pieces[i - 1]![1]);
    }
    expect(text[pieces[0]![1] - 1]).toBe("\n");
  });

  it("returns one piece for short or empty text", () => {
    expect(splitText("Hi")).toEqual([[0, 2]]);
    expect(splitText("")).toEqual([[0, 0]]);
  });

  it("runs each piece and shifts its spans, halving pieces that have too many tokens", async () => {
    const runs: number[] = [];
    // One token per character, and every capitalised word is a person.
    const runner: ModelRunner = {
      id2label: { 0: "O", 1: "B-PER" },
      encode: (text) => {
        const tokens = ["[CLS]", ...text.split(/(?<=\s)|(?=\s)/u).filter((t) => t.trim()), "[SEP]"];
        const ids = Array.from({ length: Math.max(tokens.length, [...text].length + 2) }, () => 1);
        return { ids, tokens, attention_mask: ids };
      },
      run: async (enc) => {
        runs.push(enc.ids.length);
        const logits = Float32Array.from(enc.tokens.flatMap((t) => (/^\p{Lu}/u.test(t) && !t.startsWith("[") ? [0, 5] : [5, 0])));
        return { logits, seqLen: enc.tokens.length, numLabels: 2 };
      },
    };
    const text = `${"ok ".repeat(300)}Sarah met Tom today ${"ok ".repeat(300)}`;
    const spans = await detectorFor(runner)(text);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Sarah", "Tom"]);
    expect(Math.max(...runs)).toBeLessThanOrEqual(512);
    expect(runs.length).toBeGreaterThan(1);
  });
});

describe("model files", () => {
  const body = Buffer.from('{"id2label":{"0":"O"}}');
  const sha = createHash("sha256").update(body).digest("hex");
  const manifest = (sha256: string): ModelManifest => ({
    id: "test/model",
    revision: "abc123",
    files: {
      config: { path: "config.json", sha256 },
      tokenizer: { path: "tokenizer.json", sha256 },
      tokenizerConfig: { path: "tokenizer_config.json", sha256 },
      onnx: { path: "onnx/model.onnx", sha256 },
    },
  });
  const fakeFetch = (payload: Buffer, calls: string[] = []) =>
    (async (url: string) => {
      calls.push(url);
      return new Response(new Uint8Array(payload));
    }) as typeof fetch;

  it("downloads a missing file from the pinned revision, checks it and caches it", async () => {
    const dir = join(tmp, "ok");
    const calls: string[] = [];
    const m = manifest(sha);
    const path = await modelFile(dir, m, m.files.config, fakeFetch(body, calls));
    expect(calls).toEqual(["https://huggingface.co/test/model/resolve/abc123/config.json"]);
    expect(existsSync(path)).toBe(true);
    await modelFile(dir, m, m.files.config, fakeFetch(body, calls));
    expect(calls).toHaveLength(1);
  });

  it("refuses a file that does not match its checksum and saves nothing", async () => {
    const dir = join(tmp, "bad");
    const m = manifest(sha);
    await expect(modelFile(dir, m, m.files.config, fakeFetch(Buffer.from("tampered")))).rejects.toThrow(/checksum/);
    expect(existsSync(join(dir, "test/model/abc123/config.json"))).toBe(false);
  });

  it("downloads a cached file again when it was changed", async () => {
    const dir = join(tmp, "changed");
    const m = manifest(sha);
    const cached = join(dir, "test/model/abc123/config.json");
    mkdirSync(join(dir, "test/model/abc123"), { recursive: true });
    writeFileSync(cached, "changed");
    const calls: string[] = [];
    await modelFile(dir, m, m.files.config, fakeFetch(body, calls));
    expect(calls).toHaveLength(1);
    expect(readdirSync(join(dir, "test/model/abc123"))).toEqual(["config.json"]);
  });

  it("caches in the user's cache folder for each OS, or where SF_AGENT_PO_MODEL_DIR says", () => {
    expect(defaultModelDir({ SF_AGENT_PO_MODEL_DIR: "/x" }, "linux")).toBe("/x");
    expect(defaultModelDir({ XDG_CACHE_HOME: "/c" }, "linux")).toBe(join("/c", "sf-agent-po", "models"));
    expect(defaultModelDir({ LOCALAPPDATA: "C:\\L" }, "win32")).toBe(join("C:\\L", "sf-agent-po", "models"));
    expect(defaultModelDir({}, "darwin")).toMatch(/Library[\\/]Caches[\\/]sf-agent-po[\\/]models$/);
  });
});

describe("the vendored runtime", () => {
  it("loads in Node without native code", async () => {
    expect(existsSync(VENDORED_RUNTIME)).toBe(true);
    const ort = (await import(pathToFileURL(VENDORED_RUNTIME).href)) as typeof import("onnxruntime-common");
    expect(typeof ort.InferenceSession.create).toBe("function");
    const t = new ort.Tensor("int64", BigInt64Array.from([1n, 2n]), [1, 2]);
    expect(t.dims).toEqual([1, 2]);
  });

  it("starts its WebAssembly backend (a junk model fails to parse, not to load the backend)", async () => {
    const ort = (await import(pathToFileURL(VENDORED_RUNTIME).href)) as typeof import("onnxruntime-common");
    ort.env.wasm.numThreads = 1;
    await expect(ort.InferenceSession.create(new Uint8Array([1, 2, 3]))).rejects.toThrow(/protobuf parsing failed/);
  });
});

// The real model (138 MB) is downloaded from Hugging Face, so this runs only where that is
// possible and wanted: in CI's model job, or locally with SF_AGENT_PO_MODEL_TEST=1.
describe.runIf(process.env.SF_AGENT_PO_MODEL_TEST === "1")("the detection model", () => {
  it("finds every person in the samples, and masks nothing outside a labelled value", { timeout: 600_000 }, async () => {
    const model = await loadDetectionModel({ threads: 1 });
    try {
      const misses: string[] = [];
      const extra: string[] = [];
      for (const s of SAMPLES) {
        const spans: Span[] = await detect(s.text, { model: model.detect, dictionary: KNOWN_NAMES });
        for (const g of s.gold.filter((x) => x.type === "PERSON")) {
          const covered = [...s.text.slice(g.start, g.end)].every((ch, i) => /\s/.test(ch) || spans.some((sp) => sp.start <= g.start + i && g.start + i < sp.end));
          if (!covered) misses.push(`${g.value} in: ${s.text}`);
        }
        for (const sp of spans) {
          const outside = [...s.text.slice(sp.start, sp.end)].some((ch, i) => !/\s/.test(ch) && !s.gold.some((g) => g.start <= sp.start + i && sp.start + i < g.end));
          if (outside) extra.push(`${sp.type} "${s.text.slice(sp.start, sp.end)}" in: ${s.text}`);
        }
      }
      console.log(`model stats: ${JSON.stringify(model.stats)}`);
      expect(misses).toEqual([]);
      expect(extra).toEqual([]);
      // Without the dictionary, the model finds the names on its own.
      const alone = await detect("Please call Sarah Whitfield before the go-live.", { model: model.detect });
      expect(alone.map((s) => s.type)).toEqual(["PERSON"]);
    } finally {
      await model.release();
    }
  });
});
