import { chromium, expect } from "@playwright/test";
import { existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = new URL(process.env.PILOT_URL || "https://enclaveagent.tech");
if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash || target.pathname !== "/") throw Error("PILOT_URL must be a credential-free HTTPS origin.");
const apiKey = process.env.PILOT_API_KEY;
const infer = process.argv.includes("--run-inference");
if (infer && !apiKey) throw Error("PILOT_API_KEY is required for an explicitly enabled inference check.");
const outputDir = fileURLToPath(new URL("../test-results/pilot/", import.meta.url));
mkdirSync(outputDir, { recursive: true });
let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (!executablePath && !existsSync(chromium.executablePath()) && process.env.LOCALAPPDATA) {
  const cache = path.join(process.env.LOCALAPPDATA, "ms-playwright");
  if (existsSync(cache)) executablePath = readdirSync(cache).filter(x => /^chromium-\d+$/.test(x))
    .sort((a,b) => Number(b.split("-")[1])-Number(a.split("-")[1]))
    .map(x => path.join(cache,x,"chrome-win64","chrome.exe")).find(existsSync);
}
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
// Certificate errors are intentionally not ignored.
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" });
const page = await context.newPage();
const errors = [], responses = [];
page.on("pageerror", error => errors.push(String(error.message).split(apiKey || "__no_key__").join("[redacted]")));
page.on("response", response => { const url = new URL(response.url()); if (url.origin === target.origin && url.pathname.startsWith("/api/")) responses.push({ path: url.pathname, status: response.status() }); });
const metadata = { origin: target.origin, checkedAt: new Date().toISOString(), passed: false, inferenceEnabled: infer, autoRetries: 0, responses, errors };
try {
  for (const route of ["/", "/verify", "/status", "/dashboard"]) {
    const response = await page.goto(target.origin + route, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    expect(await page.evaluate(() => window.isSecureContext && Boolean(crypto.subtle))).toBe(true);
    if (route === "/status") await expect(page.getByText("DEVELOPMENT · E1 NOT RELEASED", { exact: true })).toBeVisible();
  }
  const unauthorized = await context.request.get(target.origin + "/api/v1/workspace");
  expect(unauthorized.status()).toBe(401);
  await page.locator('.dashboard-main[data-workspace-ready="true"]').waitFor();
  if (apiKey) {
    const loginConfig = await context.request.get(target.origin + "/api/v1/auth/wallet/config");
    if (loginConfig.ok() && (await loginConfig.json()).enabled) await expect(page.locator("#wallet-login-panel")).toBeVisible();
    await page.locator("#operator-access").evaluate(details => { details.open = true; });
    await page.locator("#api-key").fill(apiKey);
    await page.locator("#connect-gateway").click();
    await expect(page.locator("#connection-status")).toContainText("Connected", { timeout: 30_000 });
    await expect(page.locator("#environment-badge")).toContainText("NEAR GPU");
    const administration = await context.request.post(target.origin + "/api/v1/marketplace/2147483647/bootstrap-approve", { headers: { "x-api-key": apiKey } });
    expect(administration.status()).toBe(403);
    // Never include credentials in screenshots, even in ignored artifacts.
    await page.locator("#api-key").evaluate(input => { input.value = ""; });
  }
  if (infer) {
    await page.locator("#prompt").fill("Reply with the single word READY.");
    await page.locator("#run-inference").click();
    await expect(page.locator("#payment-dialog")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#payment-mode-note")).toContainText("test USDC");
    await page.locator("#confirm-payment").click();
    await expect.poll(async () => page.locator("#output-status").innerText(), { timeout: 330_000 }).toMatch(/Response verified|interrupted/);
    await expect(page.locator("#output-status")).toHaveText("Response verified");
    await page.locator("#open-last-receipt").click();
    await page.locator("#verify-receipt").click();
    await expect(page.locator("#receipt-integrity")).toContainText("Signature and typed hash verified");
    await expect(page.locator("#receipt-notice")).toContainText("ANCHORED", { timeout: 45_000 });
    metadata.receiptSignatureVerified = true;
    metadata.anchoredOnDevelopmentChain = true;
  }
  expect(errors).toEqual([]);
  await page.screenshot({ path: path.join(outputDir, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(target.origin + "/status", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("DEVELOPMENT · E1 NOT RELEASED", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(outputDir, "mobile.png"), fullPage: true });
  metadata.passed = true;
} catch (error) {
  metadata.failure = String(error.message).split(apiKey || "__no_key__").join("[redacted]").slice(0, 1200);
  metadata.visibleErrors = await page.locator("#connection-error,#inference-error,#payment-error").allTextContents().catch(() => []);
  process.exitCode = 1;
} finally {
  await browser.close();
  writeFileSync(path.join(outputDir, "verification.json"), JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify(metadata));
}
