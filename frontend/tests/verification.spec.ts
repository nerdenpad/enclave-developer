import { test, expect, type Page } from "@playwright/test";
import { hashTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { receiptTypedData, type PortableReceipt } from "../src/enclave/receipt-verifier";

const h = (byte: string) => `0x${byte.repeat(32)}` as Hex;
const signer = privateKeyToAccount(h("11")), verifier = `0x${"ab".repeat(20)}` as Hex;
async function receipt() {
  const r: PortableReceipt = { receiptVersion: 2, nonce: h("01"), chainId: 31337, verifierAddress: verifier, modelHash: h("02"), codeHash: h("03"), inHash: h("04"), outHash: h("05"), attRef: h("06"), ts: "1800000000", sig: `0x${"00".repeat(65)}`, typedHash: h("00"), anchoredTx: null };
  const typed = receiptTypedData(r); r.sig = await signer.signTypedData(typed); r.typedHash = hashTypedData(typed); return r;
}
async function fillTrust(page: Page) {
  await page.getByLabel("Trusted chain ID", { exact: true }).fill("31337");
  await page.getByLabel("Trusted verifier address").fill(verifier);
  await page.getByLabel("Trusted receipt signer").fill(signer.address);
}
test("uploaded receipt verifies locally without API/RPC requests or persistent storage", async ({ page }) => {
  const requests: string[] = []; page.on("request", request => { if (["fetch", "xhr"].includes(request.resourceType())) requests.push(request.url()); });
  await page.goto("/verify"); await fillTrust(page);
  await page.getByLabel("Open receipt JSON", { exact: false }).setInputFiles({ name: "receipt.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(await receipt())) });
  await page.getByRole("button", { name: "Verify locally", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Local signature and receipt hash verified" })).toBeVisible();
  await expect(page.getByText("Not checked. No RPC request was sent.")).toBeVisible(); expect(requests).toEqual([]);
  await page.screenshot({ path: "test-results/verify-desktop.png", fullPage: true });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(signer.address);
  await page.getByLabel("Trusted chain ID", { exact: true }).fill("1");
  await expect(page.getByRole("heading", { name: "Results appear here" })).toBeVisible();
  await page.getByRole("button", { name: "Verify locally", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("does not match");
});
test("malformed and oversized imports fail without executing uploaded markup", async ({ page }) => {
  await page.goto("/verify"); await fillTrust(page);
  await page.getByLabel("Or paste a single receipt").fill('{"receiptVersion":"<img src=x onerror=alert(1)>"}');
  await page.getByRole("button", { name: "Verify locally", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("Invalid receipt JSON");
  await expect(page.locator(".verification-results img")).toHaveCount(0);
  await page.getByLabel("Open receipt JSON", { exact: false }).setInputFiles({ name: "large.json", mimeType: "application/json", buffer: Buffer.alloc(65_537) });
  await expect(page.getByRole("alert")).toContainText("64 KiB"); await expect(page.getByLabel("Or paste a single receipt")).toHaveValue("");
});
test("changing input cancels an in-flight RPC result and clear removes receipt and endpoint", async ({ page }) => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("https://rpc.example/**", async route => { await gate; await route.fulfill({ json: { jsonrpc: "2.0", id: 1, result: "0x7a69" } }).catch(() => {}); });
  await page.goto("/verify"); await fillTrust(page);
  await page.getByLabel("Or paste a single receipt").fill(JSON.stringify(await receipt())); await page.getByLabel("RPC URL", { exact: false }).fill("https://rpc.example/");
  const outgoing = page.waitForRequest("https://rpc.example/"); await page.getByRole("button", { name: "Verify on-chain" }).click(); await outgoing;
  await page.getByLabel("Trusted chain ID", { exact: true }).fill("1"); release();
  await expect(page.getByRole("heading", { name: "Results appear here" })).toBeVisible(); await expect(page.getByRole("alert")).toBeEmpty();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByLabel("Or paste a single receipt")).toHaveValue(""); await expect(page.getByLabel("RPC URL", { exact: false })).toHaveValue("");
});
test("status is public, shows configuration and never labels the software gateway live", async ({ page }) => {
  const headers: Record<string, string>[] = [];
  await page.route("**/api/**", async route => {
    headers.push(route.request().headers());
    await route.fulfill({ json: route.request().url().endsWith("/health") ? {
      ok: true, service: "enclave-gateway", teeMode: "dev", inferenceBackend: "near-verified", chainId: 31337, paymentMode: "mock", servingModel: { id: "glm", name: "GLM", modelHash: h("02"), codeHash: h("03") }, receiptSigner: signer.address, verifierAddress: verifier, agentRuntimeEnabled: false, inferencePriceUsdc: 0.001,
      deployment: { stage: "development", productionReady: false, gatewayKeyCustody: "software" }, limits: { inferenceTimeoutMs: 300000, maxOutputTokens: 96 }, settlementToken: verifier,
    } : { active: { version: 2, servingImageId: "image", measurement: h("03"), policyHash: h("08"), status: "active", binding: "onchain", scope: "local", trustMode: "development-software", activatedAt: null, createdAt: "2026-09-22T00:00:00Z" }, history: [] } });
  });
  await page.goto("/status"); await expect(page.getByText("DEVELOPMENT · E1 NOT RELEASED")).toBeVisible();
  await expect(page.getByLabel("Deployment details")).toContainText("Local Anvil"); await expect(page.getByLabel("Deployment details")).toContainText("96");
  expect(headers.length).toBeGreaterThanOrEqual(2); expect(headers.every(h => !h["x-api-key"])).toBe(true);
});
test("unreachable gateway cannot be shown as production ready", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ status: 503, json: { title: "UNAVAILABLE" } }));
  await page.goto("/status"); await expect(page.getByText("STATUS UNAVAILABLE")).toBeVisible(); await expect(page.getByText(/No live or production status has been established/)).toBeVisible();
});
test("verification form fits a narrow viewport and exposes labelled keyboard controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/verify");
  await expect(page.getByLabel("Or paste a single receipt")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByLabel("Trusted chain ID", { exact: true })).toBeEnabled();
  await page.getByLabel("Trusted chain ID", { exact: true }).focus(); await expect(page.getByLabel("Trusted chain ID", { exact: true })).toBeFocused();
  await page.screenshot({ path: "test-results/verify-mobile.png", fullPage: true });
});
