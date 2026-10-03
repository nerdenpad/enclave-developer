import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Isolate HTTP routing checks from wallet and API workflows.
// Build with ENCLAVE_DEPLOY_TARGET=node, then set HTTP_BUILT_SERVER=true to check it.
const builtServer = process.env["HTTP_BUILT_SERVER"] === "true";
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: "http-routing.spec.ts",
  use: { ...base.use, baseURL: "http://127.0.0.1:5197" },
  webServer: {
    ...base.webServer,
    command: builtServer ? "node .output/server/index.mjs" : "npm run dev -- --host 127.0.0.1 --port 5197",
    url: "http://127.0.0.1:5197",
    reuseExistingServer: false,
    env: { VITE_WALLETCONNECT_PROJECT_ID: "", VITE_ARC_PAYMENTS_ENABLED: "false", HOST: "127.0.0.1", PORT: "5197" },
  },
});
