// The detection model's files: where they are cached, and how they are downloaded and checked.

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ModelFile {
  /** The path inside the model repository. */
  path: string;
  /** Its SHA-256, in hex. A file that does not match is never used. */
  sha256: string;
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
  revision: "REVISION",
  files: {
    config: { path: "config.json", sha256: "SHA_CONFIG" },
    tokenizer: { path: "tokenizer.json", sha256: "SHA_TOKENIZER" },
    tokenizerConfig: { path: "tokenizer_config.json", sha256: "SHA_TOKENIZER_CONFIG" },
    onnx: { path: "onnx/model_quantized.onnx", sha256: "SHA_ONNX" },
  },
};

/** The default model cache: SF_AGENT_PO_MODEL_DIR, else the user's cache folder for this OS. */
export function defaultModelDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.SF_AGENT_PO_MODEL_DIR) return env.SF_AGENT_PO_MODEL_DIR;
  const base =
    platform === "win32"
      ? (env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : platform === "darwin"
        ? join(homedir(), "Library", "Caches")
        : (env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
  return join(base, "sf-agent-po", "models");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

/**
 * The local path of a model file, downloaded first when it is missing. The download goes
 * to a temporary name and is checked before it takes the real name, so a cut download or a
 * changed file is never used. A cached file is checked again each time it is loaded.
 */
export async function modelFile(dir: string, manifest: ModelManifest, file: ModelFile, fetchImpl: Fetch = fetch): Promise<string> {
  const path = join(dir, manifest.id, manifest.revision, file.path);
  if (existsSync(path)) {
    const actual = await sha256File(path);
    if (actual === file.sha256) return path;
    await rm(path, { force: true }); // corrupted or tampered with: download it again
  }
  const url = `https://huggingface.co/${manifest.id}/resolve/${manifest.revision}/${file.path}`;
  const res = await fetchImpl(url, { headers: { "user-agent": "sf-agent-po" } });
  if (!res.ok) throw new Error(`Could not download the detection model: ${res.status} ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== file.sha256) throw new Error(`The detection model file ${file.path} does not match its checksum (got ${actual}); it was not saved.`);
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, body);
  await rename(partial, path);
  return path;
}
