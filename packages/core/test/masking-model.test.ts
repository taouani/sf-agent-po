import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  alignTokens,
  cachedDetector,
  decodeSpans,
  defaultModelDir,
  detect,
  detectorFor,
  labelType,
  loadDetectionModel,
  modelFile,
  serialQueue,
  splitText,
  VENDORED_RUNTIME,
  type Fetch,
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

  it("keeps the label of an unknown token by placing it between its neighbours", () => {
    const text = "Thanks Sarah🙂 for the update!";
    const tokens = ["[CLS]", "Thanks", "[UNK]", "for", "the", "update", "!", "[SEP]"];
    expect(alignTokens(text, tokens)[2]).toEqual({ start: 7, end: 14, continuation: false });
    const spans = decodeSpans(text, tokens, logitsFor([0, 0, 1, 0, 0, 0, 0, 0]), tokens.length, 5, id2label);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Sarah🙂"]);
    // At the end of the text too.
    const end = "Merci Zoë🙂";
    expect(alignTokens(end, ["[CLS]", "Merci", "[UNK]", "[SEP]"])[2]).toEqual({ start: 6, end: 11, continuation: false });
  });

  it("finds a token in another case without shifting offsets", () => {
    const text = "İİ x Sarah";
    expect(alignTokens(text, ["[CLS]", "SARAH", "[SEP]"])[1]).toEqual({ start: 5, end: 10, continuation: false });
  });

  it("leaves a title before a name visible", () => {
    const text = "Appeler M. Karim Benali";
    const tokens = ["[CLS]", "Appeler", "M", ".", "Karim", "Ben", "##ali", "[SEP]"];
    const spans = decodeSpans(text, tokens, logitsFor([0, 0, 1, 2, 2, 2, 2, 0]), tokens.length, 5, id2label);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Karim Benali"]);
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
      if (i) expect(start).toBeLessThanOrEqual(pieces[i - 1]![1]);
    }
    expect(text[pieces[0]![1] - 1]).toBe("\n");
  });

  it("repeats the words before a cut made at a space, so a name is seen whole", () => {
    const text = `${"word ".repeat(195)}Sarah Whitfield ${"word ".repeat(100)}`;
    const pieces = splitText(text, 1000);
    expect(pieces).toHaveLength(2);
    const [[, firstEnd], [secondStart]] = pieces as [[number, number], [number, number]];
    expect(secondStart).toBeLessThan(firstEnd);
    expect(firstEnd - secondStart).toBeLessThanOrEqual(64);
    expect(text.slice(secondStart)).toMatch(/^\S/u);
    expect(text.slice(secondStart, secondStart + 200)).toContain("Sarah Whitfield");
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

describe("running the model one call at a time", () => {
  it("starts each piece of work after the last one ends, in order, and a failure stops nothing", async () => {
    const queue = serialQueue();
    const log: string[] = [];
    let running = 0;
    const work = (name: string, fail = false) => async () => {
      running++;
      expect(running).toBe(1);
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`end ${name}`);
      running--;
      if (fail) throw new Error(`${name} failed`);
      return name;
    };
    const results = await Promise.allSettled([queue(work("a")), queue(work("b", true)), queue(work("c"))]);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : (r.reason as Error).message))).toEqual(["a", "b failed", "c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });
});

describe("model files", () => {
  const body = Buffer.from('{"id2label":{"0":"O"}}');
  const sha = createHash("sha256").update(body).digest("hex");
  const file = (sha256 = sha, size = body.length) => ({ path: "config.json", sha256, size });
  const manifest = (f = file()): ModelManifest => ({ id: "test/model", revision: "abc123", files: { config: f, tokenizer: f, tokenizerConfig: f, onnx: f } });
  const fakeFetch = (payload: Buffer, calls: string[] = [], status = 200): Fetch =>
    async (url: string) => {
      calls.push(url);
      await new Promise((r) => setTimeout(r, 5));
      return new Response(new Uint8Array(payload), { status });
    };
  const files = (dir: string) => readdirSync(join(dir, "test/model/abc123"));

  it("downloads a missing file from the pinned revision, checks it and caches it", async () => {
    const dir = join(tmp, "ok");
    const calls: string[] = [];
    const bytes = await modelFile(dir, manifest(), file(), { fetch: fakeFetch(body, calls) });
    expect(bytes.equals(body)).toBe(true);
    expect(calls).toEqual(["https://huggingface.co/test/model/resolve/abc123/config.json"]);
    await modelFile(dir, manifest(), file(), { fetch: fakeFetch(body, calls) });
    expect(calls).toHaveLength(1);
    expect(files(dir)).toEqual(["config.json"]);
  });

  it("shares one download between calls for the same file", async () => {
    const dir = join(tmp, "together");
    const calls: string[] = [];
    const all = await Promise.all([0, 1, 2].map(() => modelFile(dir, manifest(), file(), { fetch: fakeFetch(body, calls) })));
    expect(all.every((b) => b.equals(body))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(files(dir)).toEqual(["config.json"]);
  });

  it("refuses a file that does not match its checksum and leaves nothing behind", async () => {
    const dir = join(tmp, "bad");
    await expect(modelFile(dir, manifest(), file(), { fetch: fakeFetch(Buffer.from("tampered!!!!!!!!!!!!!!")) })).rejects.toThrow(/checksum/);
    expect(files(dir)).toEqual([]);
  });

  it("stops a download that grows past the expected size", async () => {
    const dir = join(tmp, "big");
    await expect(modelFile(dir, manifest(), file(sha, 4), { fetch: fakeFetch(body) })).rejects.toThrow(/larger than expected/);
    expect(files(dir)).toEqual([]);
  });

  it("reports a failed download", async () => {
    await expect(modelFile(join(tmp, "404"), manifest(), file(), { fetch: fakeFetch(body, [], 404) })).rejects.toThrow(/404/);
    const offline: Fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(modelFile(join(tmp, "offline"), manifest(), file(), { fetch: offline })).rejects.toThrow(/fetch failed/);
  });

  it("names the network's reason behind \"fetch failed\" and the fix for it", async () => {
    const failing = (cause: unknown): Fetch =>
      async () => {
        throw new TypeError("fetch failed", { cause });
      };
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND huggingface.co"), { code: "ENOTFOUND" });
    const dir = join(tmp, "proxy");
    const err = (await modelFile(dir, manifest(), file(), { fetch: failing(dns) }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("(fetch failed: getaddrinfo ENOTFOUND huggingface.co)");
    expect(err.message).toContain("NODE_USE_ENV_PROXY=1");
    expect(err.message).toContain(`save it as ${join(dir, "test/model/abc123/config.json")}`);
    expect(err.message).toContain("https://huggingface.co/test/model/resolve/abc123/config.json");
    expect(err.cause).toBeInstanceOf(TypeError);
    // A host with two addresses fails with one error for each.
    const both = Object.assign(new AggregateError([Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" })], ""), { code: "ECONNREFUSED" });
    await expect(modelFile(join(tmp, "both"), manifest(), file(), { fetch: failing(both) })).rejects.toThrow("(fetch failed: connect ECONNREFUSED 1.2.3.4:443)");
    const cert = Object.assign(new Error("unable to get local issuer certificate"), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" });
    const certErr = (await modelFile(join(tmp, "cert"), manifest(), file(), { fetch: failing(cert) }).catch((e: Error) => e)) as Error;
    expect(certErr.message).toContain("--use-system-ca");
    expect(certErr.message).not.toContain("NODE_USE_ENV_PROXY");
  });

  it("says a download was cut, refused or replaced, with no proxy advice, and how to place the file by hand", async () => {
    const cut: Fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2]));
            c.error(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
          },
        }),
      );
    const cutErr = (await modelFile(join(tmp, "cut"), manifest(), file(), { fetch: cut }).catch((e: Error) => e)) as Error;
    expect(cutErr.message).toContain("was cut or timed out (terminated: other side closed: UND_ERR_SOCKET)");
    expect(cutErr.message).not.toContain("HTTPS_PROXY");
    expect(cutErr.message).toContain("save it as");
    expect(files(join(tmp, "cut"))).toEqual([]);
    await expect(modelFile(join(tmp, "403"), manifest(), file(), { fetch: fakeFetch(body, [], 403) })).rejects.toThrow(/403 .*save it as/);
    await expect(modelFile(join(tmp, "page"), manifest(), file(), { fetch: fakeFetch(Buffer.from("<html>blocked</html>")) })).rejects.toThrow(/checksum.*company filter.*save it as/);
  });

  it("leaves the errors of the disk as they are", async () => {
    const dir = join(tmp, "disk");
    mkdirSync(join(dir, "test/model"), { recursive: true });
    writeFileSync(join(dir, "test/model/abc123"), "a file where the folder should be");
    const err = (await modelFile(dir, manifest(), file(), { fetch: fakeFetch(body) }).catch((e: Error & { code?: string }) => e)) as Error & { code?: string };
    expect(err.code).toMatch(/^E/);
    expect(err.message).not.toContain("huggingface.co");
  });

  it("downloads a cached file again when it was changed", async () => {
    const dir = join(tmp, "changed");
    mkdirSync(join(dir, "test/model/abc123"), { recursive: true });
    writeFileSync(join(dir, "test/model/abc123/config.json"), "changed");
    const calls: string[] = [];
    const bytes = await modelFile(dir, manifest(), file(), { fetch: fakeFetch(body, calls) });
    expect(bytes.equals(body)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(files(dir)).toEqual(["config.json"]);
  });

  it("caches in the user's cache folder for each OS, or where SF_AGENT_PO_MODEL_DIR says", () => {
    const abs = resolve("/x");
    expect(defaultModelDir({ SF_AGENT_PO_MODEL_DIR: abs }, "linux")).toBe(abs);
    expect(defaultModelDir({ XDG_CACHE_HOME: resolve("/c") }, "linux")).toBe(join(resolve("/c"), "sf-agent-po", "models"));
    expect(defaultModelDir({ LOCALAPPDATA: resolve("/L") }, "win32")).toBe(join(resolve("/L"), "sf-agent-po", "models"));
    expect(defaultModelDir({}, "darwin")).toMatch(/Library[\\/]Caches[\\/]sf-agent-po[\\/]models$/);
  });

  it("ignores empty or relative cache settings, so the cache never lands in the working folder", () => {
    for (const env of [{ XDG_CACHE_HOME: "" }, { XDG_CACHE_HOME: "cache" }, { SF_AGENT_PO_MODEL_DIR: "" }]) {
      expect(isAbsolute(defaultModelDir(env, "linux"))).toBe(true);
    }
    expect(isAbsolute(defaultModelDir({ LOCALAPPDATA: "" }, "win32"))).toBe(true);
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
  it("runs calls that come at once, as two tool calls do", { timeout: 600_000 }, async () => {
    const model = await loadDetectionModel();
    try {
      const people = ["Sarah Martin", "Julien Moreau", "Amélie Dubois", "Thomas Bernard"];
      const texts = Array.from({ length: 8 }, (_, i) => `Ticket ${i}: ${people[i % 4]} called about the renewal of policy ${i}. ${"The client asked for a callback. ".repeat(40)}`);
      const alone = await model.detect(texts[0]!);
      const all = await Promise.all(texts.map((t) => model.detect(t)));
      // The same spans as a call made alone, and each text's own person.
      expect(all[0]).toEqual(alone);
      for (const [i, spans] of all.entries()) expect(spans.map((s) => texts[i]!.slice(s.start, s.end))).toContain(people[i % 4]);
    } finally {
      await model.release();
    }
  });

  it("gives the same text the same answer, so a kept answer changes nothing", { timeout: 600_000 }, async () => {
    const model = await loadDetectionModel();
    try {
      // The samples, and short strings as metadata and Jira fields are.
      const texts = [...SAMPLES.map((s) => s.text), ...SAMPLES.flatMap((s) => s.text.split(/(?<=[.!?])\s+/u)).filter((t) => t.trim())];
      const cached = cachedDetector(model.detect);
      let t0 = performance.now();
      const first: Span[][] = [];
      for (const t of texts) first.push(await cached(t));
      const run = performance.now() - t0;
      const again: Span[][] = [];
      for (const t of texts) again.push(await model.detect(t));
      t0 = performance.now();
      const kept: Span[][] = [];
      for (const t of texts) kept.push(await cached(t));
      const hit = performance.now() - t0;
      console.log(`${texts.length} strings: model ${Math.round(run)} ms, kept answers ${Math.round(hit)} ms`);
      expect(again).toEqual(first);
      expect(kept).toEqual(first);
    } finally {
      await model.release();
    }
  });

  it("finds every person in the samples, and masks nothing outside a labelled value", { timeout: 600_000 }, async () => {
    const model = await loadDetectionModel();
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
