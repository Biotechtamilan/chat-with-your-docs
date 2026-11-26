import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

// Evaluations use the real embedding model and, when a key is present in
// .env.local, the real chat model. The database stays in memory.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(root, "src") } },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    env: { ...loadEnv("", root, ""), AI_MODE: "live", DATA_DIR: ":memory:", LOG_IN_TESTS: "" },
    testTimeout: 180_000,
    hookTimeout: 600_000,
  },
});
