import { chromium, expect } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// A real browser journey. No response mocking, stored answer injection or wallet signing.
// Deliberately loads only a local development workspace key via --env-file.
const args = new Set(process.argv.slice(2));
const record = args.has("--record");
const demonstrateRecovery = args.has("--show-recovery");
if (!args.has("--run-inference")) throw new Error("Pass --run-inference to allow one provider request; --record also saves the browser video.");
const root = fileURLToPath(new URL("../", import.meta.url));
const baseUrl = process.env["DEMO_FRONTEND_URL"] || "http://127.0.0.1:5173";
const target = new URL(baseUrl);
if (!["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("This recorder is restricted to the local development app.");
const apiKey = process.env["DEMO_API_KEY"];
if (!apiKey) throw new Error("Load the ignored backend .env.demo with Node --env-file.");
const outputDir = path.join(root, "recordings", record ? new Date().toISOString().replaceAll(":", "-") : "smoke");
mkdirSync(outputDir, { recursive: true });
const cache = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
const found = existsSync(cache) ? readdirSync(cache).filter((entry) => /^chromium-\d+$/.test(entry)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])).map((entry) => path.join(cache, entry, "chrome-win64", "chrome.exe")).find(existsSync) : undefined;
const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] || found;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: "en-GB", reducedMotion: "reduce", ...(record ? { recordVideo: { dir: outputDir, size: { width: 1600, height: 1000 } } } : {}) });
const page = await context.newPage();
page.setDefaultTimeout(25_000);
const started = Date.now();
const scenes = [];
const responses = [];
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error.message).split(apiKey).join("[redacted]")));
page.on("response", (response) => {
  const url = new URL(response.url());
  if (url.pathname.startsWith("/api/")) responses.push({ method: response.request().method(), path: url.pathname, status: response.status() });
});
async function pause(ms) { if (record) await page.waitForTimeout(ms); }
async function caption(title, detail, duration = 6000) {
  scenes.push({ seconds: (Date.now() - started) / 1000, title, detail });
  // Captions are rendered into a separate band by export-demo.mjs, not injected into the app.
  await pause(duration);
}
let passed = false;
let recoveryAttempts = 0;
try {
  await page.goto(`${baseUrl}/dashboard/`, { waitUntil: "networkidle" });
  await page.locator(".dashboard-main[data-workspace-ready=true]").waitFor();
  await caption("Enclave · frontend and backend", "A real local gateway, database and blockchain. NEAR supplies the remote GPU inference.");
  await page.locator("#api-key").fill(apiKey);
  await page.locator("#connect-gateway").click();
  await expect(page.locator("#connection-status")).toContainText("Connected", { timeout: 30_000 });
  await expect(page.locator("#environment-badge")).toContainText("NEAR GPU");
  await caption("Connected to the workspace", "The model, payment mode, policy and history come from the backend. The gateway remains in development mode.");
  await page.screenshot({ path: path.join(outputDir, "01-connected.png"), fullPage: true });
  await page.getByRole("tab", { name: "Models", exact: true }).click();
  await expect(page.locator("#model-cards")).toContainText("SERVING NOW");
  await caption("The active model", "The registry identifies the approved model and serving-code hashes. Requests use the gateway's configured model.");
  await page.getByRole("tab", { name: "Agent mandates", exact: true }).click();
  await page.locator("#new-agent").click();
  await page.locator("#agent-label").fill(record ? "Customer review agent" : "Integration check agent");
  await page.locator("#agent-limit").fill("0.20");
  await caption("Set a spending mandate", "This agent can use the active model and spend up to 0.20 test USDC per day.", 5000);
  await page.locator("#agent-form button").click();
  await expect(page.locator("#agent-dialog")).not.toBeVisible();
  const agent = page.locator(".agent-card").filter({ hasText: record ? "Customer review agent" : "Integration check agent" }).first();
  await expect(agent).toContainText("0.200000 USDC");
  await pause(4500);
  await agent.getByRole("button", { name: "Use this mandate" }).click();
  await page.locator("#prompt").fill("Reply with the single word READY.");
  await caption("Send an encrypted request", "The browser encrypts the prompt with AES-256-GCM. The agent mandate is checked by the gateway.", 5500);
  await page.locator("#run-inference").click();
  await expect(page.locator("#payment-dialog")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#payment-mode-note")).toContainText("test USDC");
  await caption("Payment is explicit", "HTTP 402 produces a payment challenge. This demonstration settles test USDC on local chain 31337.", 7000);
  await page.locator("#confirm-payment").click();
  await caption("NEAR inference is running", "The gateway checks provider evidence. The browser will decrypt the response and verify its receipt.", 3000);
  for (;;) {
    await expect.poll(async () => {
      const status = await page.locator("#output-status").innerText();
      return status === "Response verified" || status.includes("interrupted");
    }, { timeout: 180_000 }).toBe(true);
    if (await page.locator("#output-status").innerText() === "Response verified" || !demonstrateRecovery || recoveryAttempts >= 2) break;
    await caption("The request did not complete", "The gateway did not accept a verified result. Recovery keeps the same encrypted request and test payment.", 8000);
    await page.locator("#retry-inference").scrollIntoViewIfNeeded();
    await caption("Continue the same request", "An explicit operator action resumes this request. No new payment is created; provider usage may still be billed.", 6500);
    recoveryAttempts++;
    await page.locator("#retry-inference").click();
    await expect(page.locator("#output-status")).not.toContainText("interrupted");
  }
  await expect(page.locator("#output-status")).toHaveText("Response verified");
  await expect(page.locator("#open-last-receipt")).toBeVisible();
  await page.locator(".output-panel").scrollIntoViewIfNeeded();
  await caption("Response received and verified", "The response, input/output hashes and EIP-712 signature match. The text below is the live model output.", 11000);
  await page.screenshot({ path: path.join(outputDir, "02-response.png"), fullPage: true });
  await page.locator("#open-last-receipt").click();
  await page.locator("#verify-receipt").click();
  await expect(page.locator("#receipt-integrity")).toContainText("Signature and typed hash verified");
  await caption("Inspect the signed receipt", "The receipt binds model, serving code, input and output hashes. Signature verification is separate from hardware attestation.", 9000);
  await expect(page.locator("#receipt-notice")).toContainText("ANCHORED", { timeout: 35_000 });
  await caption("Anchored on the local chain", "The worker submitted a real local-chain transaction. Its hash is stored with the receipt.", 8000);
  await page.screenshot({ path: path.join(outputDir, "03-receipt.png"), fullPage: true });
  await page.getByRole("button", { name: "Close receipt", exact: true }).click();
  await page.getByRole("tab", { name: "USDC usage", exact: true }).click();
  await page.locator("#view-payments h2").scrollIntoViewIfNeeded();
  await expect(page.locator("#usage-rows")).toContainText("consumed");
  await caption("Payment and usage history", "Payment status, amount and settlement transaction are read from the database; no browser-generated usage data.", 8500);
  await page.screenshot({ path: path.join(outputDir, "04-payments.png"), fullPage: true });
  await page.getByRole("tab", { name: "Audit controls", exact: true }).click();
  await page.locator("#audit-scope").selectOption("combined");
  await page.locator("#audit-purpose").fill("Customer integration review");
  await page.locator("#include-amounts").check();
  await caption("Export an audit record", "The export contains loaded receipt and payment metadata. Prompt text, model answers and credentials are excluded.", 6500);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#audit-form button").click();
  const downloaded = await downloadPromise; await downloaded.saveAs(path.join(outputDir, "enclave-audit.json"));
  const calls = await page.locator("#metric-calls").innerText();
  await caption("History survives a page reload", "The API key is held only in memory, so reconnecting is required. Backend records remain available.", 5500);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".dashboard-main[data-workspace-ready=true]").waitFor();
  await page.locator("#api-key").fill(apiKey); await page.locator("#connect-gateway").click();
  await expect(page.locator("#connection-status")).toContainText("Connected");
  await expect(page.locator("#metric-calls")).toHaveText(calls);
  await page.getByRole("tab", { name: "Receipts", exact: true }).click();
  await expect(page.locator("#receipt-rows")).toContainText("anchored");
  await caption("Frontend and backend, connected", "Live NEAR inference · encrypted prompts and responses · signed receipts · persistent history · local test settlement.", 9000);
  if (pageErrors.length) throw new Error(`Browser reported ${pageErrors.length} runtime errors.`);
  passed = true;
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, "failure.png"), fullPage: true }).catch(() => {});
  const visibleError = await page.locator("#connection-error,#inference-error,#payment-error,#agent-error").allTextContents().catch(() => []);
  writeFileSync(path.join(outputDir, "failure.json"), JSON.stringify({ errors: visibleError, pageErrors, responses }, null, 2));
  console.error("Browser journey failed. Inspect recordings/smoke/failure.json or the timestamped recording folder; no credentials were logged.");
  console.error(String(error.message).split(apiKey).join("[redacted]").slice(0, 1700));
} finally {
  const video = page.video();
  await context.close();
  if (video) await video.saveAs(path.join(outputDir, "Enclave-Demo.webm"));
  await browser.close();
  writeFileSync(path.join(outputDir, "verification.json"), JSON.stringify({ passed, recordedAt: new Date().toISOString(), durationSeconds: (Date.now() - started) / 1000, scenes, responses, pageErrors, recoveryAttempts, liveProviderRequests: responses.filter((r) => r.path === "/api/v1/inference" && r.status === 200).length, boundaries: ["Software development gateway", "NEAR remote GPU inference", "Local Anvil test-USDC settlement", "No production hardware-custody claim"] }, null, 2));
  console.log(JSON.stringify({ passed, outputDir, recorded: record }));
  if (!passed) process.exitCode = 1;
}
