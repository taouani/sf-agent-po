import { defineConfig } from "vitest/config";

// Workspace packages resolve to their TypeScript sources, so a test never runs a stale build.
// The rest are Vite's own server conditions.
const conditions = ["@sf-agent-po/source", "module", "node", "development|production"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    server: {
      deps: {
        // The vendored ONNX Runtime must load as plain Node modules: vitest's transform breaks
        // the way it imports its WebAssembly loader by URL.
        external: [/[\\/]vendor[\\/]onnxruntime-web[\\/]/],
      },
    },
  },
});
