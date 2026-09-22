import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, devices, chromium } from "@playwright/test";

function installedChromium(): string | undefined {
  if (process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]) return process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
  if (existsSync(chromium.executablePath())) return undefined;
  const local = process.env["LOCALAPPDATA"];
  if (process.platform !== "win32" || !local) return undefined;
  const cache = join(local, "ms-playwright");
  if (!existsSync(cache)) return undefined;
  const revisions = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  return revisions.map((name) => join(cache, name, "chrome-win64", "chrome.exe")).find(existsSync);
}

const executablePath = installedChromium();
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure", screenshot: "only-on-failure", serviceWorkers: "block" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], ...(executablePath ? { launchOptions: { executablePath } } : {}) } }],
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 5173", url: "http://127.0.0.1:5173", reuseExistingServer: true, timeout: 120_000 },
});
