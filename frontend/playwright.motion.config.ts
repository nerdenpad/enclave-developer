import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Set MOTION_BASE_URL to check the actual published SSR/assets pair after a deploy.
// The suite never connects a wallet or calls the backend.
const deployedUrl = process.env["MOTION_BASE_URL"];
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: "motion.spec.ts",
  timeout: 45_000,
  use: { ...base.use, ...(deployedUrl ? { baseURL: deployedUrl } : {}) },
  ...(deployedUrl ? { webServer: undefined } : {}),
});
