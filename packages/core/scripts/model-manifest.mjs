// Prints the manifest to pin in src/masking/model/files.ts: the repository's current commit
// and each file's SHA-256 (large files from their LFS record, small ones by downloading them).
// Usage: node scripts/model-manifest.mjs [model id] [revision]
import { createHash } from "node:crypto";

const id = process.argv[2] ?? "Xenova/distilbert-base-multilingual-cased-ner-hrl";
const files = { config: "config.json", tokenizer: "tokenizer.json", tokenizerConfig: "tokenizer_config.json", onnx: "onnx/model_quantized.onnx" };
const headers = { "user-agent": "sf-agent-po" };
const get = async (url) => {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
};

const revision = process.argv[3] ?? (await (await get(`https://huggingface.co/api/models/${id}/revision/main`)).json()).sha;
const manifest = { id, revision, files: {} };
for (const [key, path] of Object.entries(files)) {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const tree = await (await get(`https://huggingface.co/api/models/${id}/tree/${revision}/${dir}`)).json();
  const entry = tree.find((e) => e.path === path);
  if (!entry) throw new Error(`${path} not found at ${revision}`);
  const sha256 = entry.lfs?.oid ?? createHash("sha256").update(Buffer.from(await (await get(`https://huggingface.co/${id}/resolve/${revision}/${path}`)).arrayBuffer())).digest("hex");
  manifest.files[key] = { path, sha256, size: entry.lfs?.size ?? entry.size };
}
console.log(JSON.stringify(manifest, null, 2));
