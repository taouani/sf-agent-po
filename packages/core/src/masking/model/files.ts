// The detection model's files: where they are cached, and how they are downloaded and checked.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export interface ModelFile {
  /** The path inside the model repository. */
  path: string;
  /** Its SHA-256, in hex. A file that does not match is never used. */
  sha256: string;
  /** Its size in bytes; a download that grows past it is stopped. */
  size: number;
}

export interface ModelManifest {
  /** The Hugging Face repository. */
  id: string;
  /** The repository commit the files come from, so a later change upstream cannot change them. */
  revision: string;
  files: { config: ModelFile; tokenizer: ModelFile; tokenizerConfig: ModelFile; onnx: ModelFile };
}

/**
 * The model chosen in spike 1 (decision ST4, run on WebAssembly per RT1): multilingual
 * names, places and organisations, 8-bit quantised, 138 MB. AFL-3.0 licence.
 */
export const DEFAULT_MODEL: ModelManifest = {
  id: "Xenova/distilbert-base-multilingual-cased-ner-hrl",
  revision: "c2a4dbf593c57f47004c5bc2d3770d311aee9c43",
  files: {
    config: { path: "config.json", sha256: "38847be4dc6699b1218a749ed69f888c2ccc7b4deba98e3c4a1cac8cb34d54c8", size: 927 },
    tokenizer: { path: "tokenizer.json", sha256: "bf1b59b7b11c95f194f51708d918eea378e09d05f84c0e1656dc5180e8117088", size: 2919362 },
    tokenizerConfig: { path: "tokenizer_config.json", sha256: "2d61ce6c7646881e0e7ef08e3b5dd655a19553ab85c41b1a3c27090a63ff6f49", size: 373 },
    onnx: { path: "onnx/model_quantized.onnx", sha256: "24a0b98f4dd4cd92842f5a541272f86f760225a64a29928eddef14bdb2edb986", size: 135359829 },
  },
};

/** The default model cache: SF_AGENT_PO_MODEL_DIR, else the user's cache folder for this OS. */
export function defaultModelDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  // An empty or relative value is ignored, as the XDG spec says, so the cache never lands in the working folder.
  const usable = (v: string | undefined) => (v && isAbsolute(v) ? v : undefined);
  const own = usable(env.SF_AGENT_PO_MODEL_DIR);
  if (own) return own;
  const base =
    platform === "win32"
      ? (usable(env.LOCALAPPDATA) ?? join(homedir(), "AppData", "Local"))
      : platform === "darwin"
        ? join(homedir(), "Library", "Caches")
        : (usable(env.XDG_CACHE_HOME) ?? join(homedir(), ".cache"));
  return join(base, "sf-agent-po", "models");
}

export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export interface DownloadOptions {
  fetch?: Fetch;
  /** Gives up on a download after this long; 15 minutes by default. */
  timeoutMs?: number;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Streams a download into `partial` while hashing it, and stops at the expected size. */
async function download(url: string, partial: string, file: ModelFile, opts: DownloadOptions): Promise<string> {
  const res = await (opts.fetch ?? fetch)(url, { headers: { "user-agent": "sf-agent-po" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Could not download the detection model: ${res.status} ${url}`);
  const hash = createHash("sha256");
  const out = await open(partial, "w");
  let size = 0;
  try {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > file.size) throw new Error(`The detection model file ${file.path} is larger than expected (${file.size} bytes).`);
      hash.update(chunk);
      await out.write(chunk);
    }
  } finally {
    await out.close();
  }
  return hash.digest("hex");
}

const inFlight = new Map<string, Promise<Buffer>>();

/**
 * The checked bytes of a model file, downloaded first when it is missing. The download goes
 * to a temporary name and only takes the real name once its checksum matches, so a cut
 * download or a changed file is never used. The bytes returned are the bytes checked: a
 * cached file is read once, checked, and handed over without reading it again. Calls for
 * the same file share one download.
 */
export function modelFile(dir: string, manifest: ModelManifest, file: ModelFile, opts: DownloadOptions = {}): Promise<Buffer> {
  const path = join(dir, manifest.id, manifest.revision, file.path);
  const running = inFlight.get(path);
  if (running) return running;
  const load = loadFile(path, manifest, file, opts).finally(() => inFlight.delete(path));
  inFlight.set(path, load);
  return load;
}

async function loadFile(path: string, manifest: ModelManifest, file: ModelFile, opts: DownloadOptions): Promise<Buffer> {
  const cached = await readFile(path).catch(() => undefined);
  if (cached && sha256(cached) === file.sha256) return cached;
  if (cached) await rm(path, { force: true }); // corrupted or tampered with: download it again
  const url = `https://huggingface.co/${manifest.id}/resolve/${manifest.revision}/${file.path}`;
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    const actual = await download(url, partial, file, opts);
    if (actual !== file.sha256) throw new Error(`The detection model file ${file.path} does not match its checksum (got ${actual}); it was not saved.`);
    try {
      await rename(partial, path);
    } catch (err) {
      // Another process may have saved it first (Windows refuses to replace an open file).
      const other = await readFile(path).catch(() => undefined);
      if (!other || sha256(other) !== file.sha256) throw err;
      return other;
    }
  } finally {
    await rm(partial, { force: true });
  }
  const bytes = await readFile(path);
  if (sha256(bytes) !== file.sha256) throw new Error(`The detection model file ${file.path} changed while it was saved.`);
  return bytes;
}
