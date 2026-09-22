import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: process.env.ENCLAVE_INTEGRATION === "1" ? [] : ["src/e2e*.test.ts", "src/acceptance.test.ts", "src/chain-replay.test.ts", "src/*.integration.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "json-summary", "html"],
      thresholds: process.env.ENCLAVE_INTEGRATION === "1" ? { lines: 90, statements: 90, functions: 90, branches: 85 } : {},
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
