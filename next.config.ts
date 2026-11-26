import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite loads its WASM binary and extension bundles from its own package folder at
  // runtime, and the embedding runtime is native code. Bundling either would break
  // those file lookups, so Next must require them from node_modules as they are.
  serverExternalPackages: [
    "@electric-sql/pglite",
    "@electric-sql/pglite-pgvector",
    "@huggingface/transformers",
    "onnxruntime-node",
    "@napi-rs/canvas",
  ],
};

export default nextConfig;
