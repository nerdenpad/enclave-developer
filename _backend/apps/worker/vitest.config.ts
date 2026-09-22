import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: process.env.ENCLAVE_INTEGRATION === "1" ? [] : ["src/**/*.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: process.env.ENCLAVE_INTEGRATION !== "1",
    coverage: {
      provider: "v8",
      allowExternal: true,
      include: [fileURLToPath(new URL("./src/", import.meta.url)).replaceAll("\\", "/") + "**/*.ts", fileURLToPath(new URL("../../packages/db/src/signer.ts", import.meta.url)).replaceAll("\\", "/")],
      exclude: ["src/**/*.test.ts", "src/test-db.ts"],
      reporter: ["text", "json-summary", "html"],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 95 },
    },
  },
});
