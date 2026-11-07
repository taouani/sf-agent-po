import { defineConfig } from "vitest/config";

export default defineConfig({
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
