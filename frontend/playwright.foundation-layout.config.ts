import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: "foundation-layout.spec.ts",
  timeout: 45_000,
  outputDir: "./test-results/foundation-layout",
  use: { ...base.use, baseURL: "http://127.0.0.1:5184" },
  webServer: {
    ...base.webServer,
    command: "npm run dev -- --host 127.0.0.1 --port 5184",
    url: "http://127.0.0.1:5184",
    reuseExistingServer: false,
    env: { VITE_WALLETCONNECT_PROJECT_ID: "", VITE_ARC_PAYMENTS_ENABLED: "false" },
  },
});
