import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Isolated, unfunded fixtures. This does not enable checkout in a release build.
export default defineConfig({ ...base, testIgnore: [], testMatch: "checkout-candidate.spec.ts",
  use: { ...base.use, baseURL: "http://127.0.0.1:5273" },
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 5273", url: "http://127.0.0.1:5273", reuseExistingServer: false, timeout: 120_000,
    env: { VITE_WALLETCONNECT_PROJECT_ID: "", VITE_ARC_PAYMENTS_ENABLED: "true",
      VITE_ARC_USAGE_METER: `0x${"12".repeat(20)}`, VITE_ARC_VERIFIER: `0x${"12".repeat(20)}`,
      VITE_ARC_RECEIPT_SIGNER: "0xD3E442496EB66a4748912ec4A3b7A111d0B855d6", VITE_ARC_MAX_PAYMENT_UNITS: "100000" } },
});
