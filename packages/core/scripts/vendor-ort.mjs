// Copies the three files of ONNX Runtime Web that run in Node into vendor/onnxruntime-web,
// which the published package ships (decision RT1). onnxruntime-web itself (145 MB) is only
// a dev dependency; at run time the package needs these files and onnxruntime-common.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = ["ort.node.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "vendor", "onnxruntime-web");
/** A package's folder, found the way Node does (its package.json is not exported). */
function packageDir(name) {
  for (let dir = here; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) throw new Error(`${name} is not installed; run npm install`);
  }
}
const web = packageDir("onnxruntime-web");
const pkg = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
const common = JSON.parse(readFileSync(join(packageDir("onnxruntime-common"), "package.json"), "utf8"));
if (pkg.version !== common.version) throw new Error(`onnxruntime-web ${pkg.version} and onnxruntime-common ${common.version} must match`);

mkdirSync(target, { recursive: true });
for (const f of FILES) {
  if (!f.endsWith(".mjs")) copyFileSync(join(web, "dist", f), join(target, f));
  // The source maps are not shipped, so their references go too.
  else writeFileSync(join(target, f), readFileSync(join(web, "dist", f), "utf8").replace(/\n?\/\/# sourceMappingURL=\S+\s*$/u, "\n"));
}
writeFileSync(
  join(target, "LICENSE"),
  `ONNX Runtime Web ${pkg.version}, copied from the onnxruntime-web npm package by scripts/vendor-ort.mjs.

MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
);
console.log(`vendored onnxruntime-web ${pkg.version} into ${target}`);
