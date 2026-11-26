import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Every test runs with fake AI and an in-memory database: no network, no key, no disk.
    // TRUST_PROXY lets each test act as a separate client through X-Forwarded-For.
    env: { AI_MODE: "mock", DATA_DIR: ":memory:", EMBEDDING_DIMENSIONS: "64", TRUST_PROXY: "true" },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
