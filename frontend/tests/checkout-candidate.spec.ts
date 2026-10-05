import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { hashTypedData, keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

// Every API response is intercepted; the unfunded test signer stays in Node.
// The browser receives only the EIP-1193 interface and public account details.
const account = privateKeyToAccount(`0x${"23".repeat(32)}`);
const hash = (value: string | Buffer): Hex => `0x${createHash("sha256").update(value).digest("hex")}`;
const meter = `0x${"12".repeat(20)}` as Hex;
const token = "0x3600000000000000000000000000000000000000";
const paymentId = "20000000-0000-4000-8000-000000000002", sessionId = "50000000-0000-4000-8000-000000000005";
const modelHash = hash("fixture-model"), codeHash = hash("fixture-code"), quoteSignature = `0x${"34".repeat(65)}`;
const output = "The encrypted checkout candidate response is signed.";
const receiptTypes = { InferenceReceipt: [
  { name: "modelHash", type: "bytes32" }, { name: "codeHash", type: "bytes32" }, { name: "inHash", type: "bytes32" },
  { name: "outHash", type: "bytes32" }, { name: "attRef", type: "bytes32" }, { name: "nonce", type: "bytes32" }, { name: "ts", type: "uint64" },
] } as const;

async function fixture(page: Page, options: { rejectPayment?: boolean; lostResponse?: boolean; uncertainExecution?: boolean; historyRecord?: boolean; resumeAfterLogin?: boolean;
  admissionFailureOnce?: boolean; admissionStatus?: "provider-unavailable" | "unavailable" } = {}) {
  const walletCalls: string[] = [], requests: { path: string; body: string | null; headers: Record<string, string> }[] = [];
  const loginId = "ab".repeat(24), loginToken = `enws_${"ab".repeat(32)}`;
  let loginMessage = "", settlements = 0, paidAttempts = 0, loginVerified = false;
  let admissionFailed = false;
  let failHealth = false;
  let delayedHealth: { wait: Promise<void>; entered: () => void } | null = null;
  function holdNextHealth() {
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    delayedHealth = { wait, entered }; return { release, started };
  }
  let delayedPolicies: { wait: Promise<void>; entered: () => void } | null = null;
  function holdNextPolicies() {
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    delayedPolicies = { wait, entered }; return { release, started };
  }
  await page.exposeBinding("fixtureWalletRequest", async (_source, args: { method: string; params?: unknown[] }) => {
    walletCalls.push(args.method);
    if (["eth_requestAccounts", "eth_accounts"].includes(args.method)) return [account.address];
    if (args.method === "eth_chainId") return "0x13b2";
    if (args.method === "personal_sign") {
      expect(args.params).toEqual([stringToHex(loginMessage), account.address]);
      return account.signMessage({ message: loginMessage });
    }
    if (args.method === "eth_signTypedData_v4") {
      if (options.rejectPayment) throw { code: 4001 };
      expect(args.params?.[0]).toBe(account.address);
      const typed = JSON.parse(String(args.params?.[1]));
      expect(typed.domain).toEqual({ name: "USDC", version: "2", chainId: 5042, verifyingContract: token });
      expect(typed.primaryType).toBe("ReceiveWithAuthorization");
      expect(typed.message).toMatchObject({ from: account.address, to: meter, value: "100000", validAfter: "0", nonce: keccak256(stringToHex(paymentId)) });
      const deadline = Number(typed.message.validBefore), now = Math.floor(Date.now() / 1000);
      expect(deadline).toBeGreaterThan(now); expect(deadline).toBeLessThanOrEqual(now + 600);
      return account.signTypedData(typed);
    }
    throw Error("Unsupported fixture wallet method");
  });
  await page.addInitScript(() => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const provider = { request: (args: { method: string; params?: unknown[] }) => Reflect.get(window, "fixtureWalletRequest")(args),
      on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); },
      removeListener: (event: string) => { listeners.delete(event); } };
    Reflect.set(window, "fixtureDropWallet", () => { listeners.get("disconnect")?.({ code: 4900 }); });
    const detail = { info: { uuid: "a139eb1f-44df-456a-ad70-197939cf0806", name: "Checkout fixture", rdns: "test.checkout", icon: "data:image/svg+xml,<svg/>" }, provider };
    window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail })));
  });
  const health = { ok: true, service: "gateway", teeMode: "managed-near", inferenceBackend: "near-verified", inferenceRoute: "near-direct-experimental",
    chainId: 5042, paymentMode: "authorized", settlementToken: token, servingModel: { id: "fixture", name: "GLM fixture", modelHash, codeHash },
    receiptSigner: account.address, verifierAddress: meter, agentRuntimeEnabled: false, inferencePriceUsdc: 0.1,
    deployment: { stage: "production", productionReady: true, providerAdmissionReady: true, gatewayKeyCustody: "software", inferenceTrust: "near-cpu-gpu", releaseProfile: "near-arc" },
    providerPolicy: { sha256: hash("policy"), expiresAt: "2026-10-10T00:00:00Z" } };
  const policy = { version: 2, servingImageId: "fixture", measurement: codeHash, policyHash: hash("policy"), status: "active", binding: "registry", scope: null,
    trustMode: "development-software", activatedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
  const sessionKey = Buffer.alloc(32, 71);
  const stored = { id: "10000000-0000-4000-8000-000000000001", receiptVersion: 2 as const, nonce: hash("stored-nonce"), chainId: 5042,
    verifierAddress: meter, modelHash, codeHash, inHash: hash("stored-input"), outHash: hash("stored-output"), attRef: hash(quoteSignature),
    ts: "1800000000", sig: `0x${"00".repeat(65)}` as Hex, typedHash: hash("stored-receipt"), status: "anchored", anchoredTx: hash("anchor"),
    agentId: null, createdAt: new Date().toISOString() };
  const storedTyped = { domain: { name: "ENCLAVE", version: "2", chainId: 5042, verifyingContract: meter }, types: receiptTypes,
    primaryType: "InferenceReceipt" as const, message: { ...stored, ts: BigInt(stored.ts) } };
  stored.sig = await account.signTypedData(storedTyped); stored.typedHash = hashTypedData(storedTyped);
  const workspace = { usage: { calls: options.historyRecord ? 1 : 0, usdcUnits: options.historyRecord ? "100000" : "0" }, receipts: options.historyRecord ? [stored] : [],
    payments: options.historyRecord ? [{ id: paymentId, amountUnits: "100000", status: "consumed", settleTx: hash("stored-settlement"), receiptHash: stored.typedHash,
      agentId: null, listingId: 1, confidential: false, createdAt: stored.createdAt }] : [], agents: [], page: { limit: 50, receiptsNext: null, paymentsNext: null, agentsNext: null } };
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
    const path = url.pathname.slice(4), headers = req.headers();
    requests.push({ path, body: req.postData(), headers });
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === "/health") {
      const snapshot = structuredClone(health), held = delayedHealth; delayedHealth = null;
      if (held) { held.entered(); await held.wait; }
      if (failHealth) { failHealth = false; return reply({ title: "STATUS_UNAVAILABLE", status: 503 }, 503); }
      return reply(snapshot);
    }
    if (path === "/v1/auth/wallet/config") return reply({ enabled: true, origin: url.origin, chainId: 5042 });
    if (path === "/v1/auth/wallet/resume") return options.resumeAfterLogin && loginVerified
      ? reply({ token: loginToken, address: account.address, expiresAt: new Date(Date.now() + 1_800_000).toISOString() }) : reply({}, 401);
    if (path === "/v1/auth/wallet/challenge") {
      loginMessage = createSiweMessage({ domain: url.host, address: account.address, statement: "Sign in to Enclave. This does not authorize a payment.",
        uri: `${url.origin}/dashboard`, version: "1", chainId: 5042, nonce: loginId, issuedAt: new Date(), expirationTime: new Date(Date.now() + 300_000) });
      return reply({ id: loginId, message: loginMessage });
    }
    if (path === "/v1/auth/wallet/verify") { loginVerified = true; return reply({ token: loginToken, address: account.address, expiresAt: new Date(Date.now() + 1_800_000).toISOString() }); }
    if (path === "/v1/tcb/policies") {
      const held = delayedPolicies; delayedPolicies = null;
      if (held) { held.entered(); await held.wait; }
      return reply({ active: policy, history: [policy] });
    }
    if (path === "/v1/models") return reply([]);
    if (path === "/v1/attestation/quote") return reply({ cpuQuote: "fixture", gpuQuote: "fixture", measurement: codeHash, tcbVersion: 2, timestamp: Date.now(), signature: quoteSignature });
    if (headers["x-api-key"] !== loginToken) return reply({ title: "UNAUTHORIZED", status: 401 }, 401);
    if (path === "/v1/workspace") return reply(workspace);
    if (path === "/v1/session") return reply({ sessionId, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), wrapKey: sessionKey.toString("base64") });
    if (path === "/v1/x402/settle") {
      if (options.admissionFailureOnce && !admissionFailed) {
        admissionFailed = true;
        if (options.admissionStatus) { health.deployment.productionReady = false; health.deployment.providerAdmissionReady = false; }
        if (options.admissionStatus === "unavailable") failHealth = true;
        return reply({ title: "INFERENCE_ATTESTATION_FAILED", status: 503 }, 503);
      }
      settlements++; return reply({ paymentId, tx: hash("settlement"), confidential: false });
    }
    if (path === "/v1/inference") {
      if (!headers["x-payment"]) return reply({ title: "PAYMENT_REQUIRED", status: 402, details: { x402Version: 1, accepts: [{ scheme: "exact", network: "arc-5042",
        maxAmountRequired: "100000", payTo: meter, asset: token, extra: { paymentId, receiptPending: true } }] } }, 402);
      paidAttempts++;
      if (options.uncertainExecution) return reply({ title: "INFERENCE_EXECUTION_UNCERTAIN", status: 409,
        detail: "Execution may have been dispatched. This payment is quarantined; do not submit another payment for this request.", details: { paymentId } }, 409);
      if (options.lostResponse && paidAttempts === 1) return reply({ title: "INFERENCE_BACKEND_FAILED", status: 503 }, 503);
      const body = req.postDataJSON();
      const decipher = createDecipheriv("aes-256-gcm", sessionKey, Buffer.from(body.iv, "base64")); decipher.setAuthTag(Buffer.from(body.tag, "base64"));
      const input = Buffer.concat([decipher.update(Buffer.from(body.ciphertext, "base64")), decipher.final()]);
      const iv = Buffer.alloc(12, 52), cipher = createCipheriv("aes-256-gcm", sessionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(output), cipher.final()]);
      const receipt = { receiptVersion: 2 as const, modelHash, codeHash, inHash: hash(input), outHash: hash(output), attRef: hash(quoteSignature), nonce: hash("nonce"), ts: BigInt(Math.floor(Date.now() / 1000)) };
      const typed = { domain: { name: "ENCLAVE", version: "2", chainId: 5042, verifyingContract: meter }, types: receiptTypes, primaryType: "InferenceReceipt" as const, message: receipt };
      return reply({ receipt: { ...receipt, ts: receipt.ts.toString(), sig: await account.signTypedData(typed) }, typedHash: hashTypedData(typed), outputHash: receipt.outHash,
        output: { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") } });
    }
    return reply({ title: "UNEXPECTED_FIXTURE_API", status: 500 }, 500);
  });
  await page.goto("/dashboard"); await expect(page).toHaveURL(/view=inference/);
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: "Checkout fixture" }).click();
  await page.locator("#wallet-login").click();
  await expect(page.locator("#connection-status")).toContainText("Connected");
  return { requests, walletCalls, stored, health, holdNextPolicies, holdNextHealth,
    failNextHealth: () => { failHealth = true; }, counts: () => ({ settlements, paidAttempts }) };
}

for (const width of [1440, 390]) test(`enabled candidate requires separate login and payment approval at width ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); const f = await fixture(page);
  expect(f.walletCalls.filter(method => /sign/i.test(method))).toEqual(["personal_sign"]);
  await page.locator("#prompt").fill("PRIVATE CHECKOUT PROMPT"); await page.locator("#run-inference").click();
  await expect(page.locator("#payment-dialog")).toBeVisible(); await expect(page.locator("#payment-amount")).toHaveText("0.100000 USDC");
  await expect(page.locator("#payment-recipient")).toContainText(meter); await expect(page.locator("#payment-mode-note")).toContainText("real USDC");
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
  expect(f.walletCalls.filter(method => /sign/i.test(method))).toEqual(["personal_sign"]);
  await page.locator("#confirm-payment").click(); await expect(page.locator("#inference-output")).toHaveText(output);
  await expect(page.locator("#output-status")).toHaveText("Response verified");
  expect(f.walletCalls.filter(method => /sign/i.test(method))).toEqual(["personal_sign", "eth_signTypedData_v4"]);
  expect(f.counts()).toEqual({ settlements: 1, paidAttempts: 1 });
  expect(f.requests.filter(req => req.path === "/v1/inference").every(req => !req.body?.includes("PRIVATE CHECKOUT PROMPT"))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("declining the candidate payment performs no settlement or paid inference", async ({ page }) => {
  const f = await fixture(page, { rejectPayment: true });
  await page.locator("#prompt").fill("Do not charge this declined approval"); await page.locator("#run-inference").click();
  await expect(page.locator("#payment-dialog")).toBeVisible(); await page.locator("#confirm-payment").click();
  await expect(page.locator("#inference-recovery")).toBeVisible();
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
});

test("lost wallet session preserves the original request until explicit same-wallet reconnection", async ({ page }) => {
  const f = await fixture(page);
  await page.locator("#prompt").fill("Keep this encrypted request when the wallet disconnects");
  await page.locator("#run-inference").click(); await expect(page.locator("#payment-dialog")).toBeVisible();
  await page.evaluate(() => { Reflect.get(window, "fixtureDropWallet")(); });
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeVisible();
  await expect(page.locator("#wallet-login-status")).toContainText("Signed in · wallet disconnected");
  await page.locator("#confirm-payment").click(); await expect(page.locator("#inference-recovery")).toBeVisible();
  await expect(page.locator("#recovery-payment")).toContainText(paymentId);
  await expect(page.locator("#retry-inference")).toBeDisabled();
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: "Checkout fixture" }).click();
  await expect(page.locator("#wallet-login-status")).toHaveText("Signed in. Payments are confirmed separately in your wallet.");
  await expect(page.locator("#retry-inference")).toBeEnabled();
  await page.locator("#retry-inference").click(); await expect(page.locator("#inference-output")).toHaveText(output);
  expect(f.counts()).toEqual({ settlements: 1, paidAttempts: 1 });
  expect(f.walletCalls.filter(method => method === "personal_sign")).toHaveLength(1);
  expect(f.requests.filter(req => req.path === "/v1/auth/wallet/challenge")).toHaveLength(1);
  const attempts = f.requests.filter(req => req.path === "/v1/inference");
  expect(new Set(attempts.map(req => req.body)).size).toBe(1);
  expect(new Set(attempts.map(req => req.headers["idempotency-key"])).size).toBe(1);
  expect(attempts.at(-1)?.headers["x-payment"]).toBe(paymentId);
});

test("wallet loss while login is loading cancels restoration without resurrecting workspace actions", async ({ page }) => {
  const f = await fixture(page, { historyRecord: true, resumeAfterLogin: true });
  await page.clock.install();
  const held = f.holdNextPolicies();
  await page.goto("/"); await page.goto("/dashboard"); await held.started;
  await page.evaluate(() => { Reflect.get(window, "fixtureDropWallet")(); });
  held.release();
  await expect(page.locator("#connection-status")).toHaveText("Disconnected");
  await expect(page.locator("#wallet-login-status")).toHaveText("Connect your wallet on Arc Mainnet, then sign in. Signing in is free.");
  await expect(page.locator("#run-inference")).toBeDisabled();
  await expect(page.locator("#new-agent")).toBeDisabled(); await expect(page.locator("#issue-view-key")).toBeDisabled();
  await expect(page.locator("#export-receipts-csv")).toBeDisabled();
  await expect(page.locator("#receipt-rows tr")).toHaveCount(0);
  await page.clock.fastForward(1_805_000);
  await expect(page.locator("#connection-status")).toHaveText("Disconnected");
  await expect(page.locator("#wallet-login-status")).toHaveText("Connect your wallet on Arc Mainnet, then sign in. Signing in is free.");
  await expect(page.locator("#export-receipts-csv")).toBeDisabled();
  expect(f.walletCalls.filter(method => /sign/i.test(method))).toEqual(["personal_sign"]);
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
});

test("sign-in without a connected wallet asks for login connection rather than payment", async ({ page }) => {
  const f = await fixture(page);
  await page.getByRole("button", { name: "Disconnect wallet", exact: true }).click();
  await page.locator("#wallet-login").click();
  await expect(page.locator("#connection-error")).toHaveText("Connect a wallet before signing in");
  expect(f.requests.filter(req => req.path === "/v1/auth/wallet/challenge")).toHaveLength(1);
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
});

test("rejected provider admission stops settlement display and preserves exact authorization for retry", async ({ page }) => {
  const f = await fixture(page, { admissionFailureOnce: true });
  await page.locator("#prompt").fill("Keep the admitted payment intent when hardware verification rejects a node");
  await page.locator("#run-inference").click(); await expect(page.locator("#payment-dialog")).toBeVisible();
  await page.locator("#confirm-payment").click(); await expect(page.locator("#inference-recovery")).toBeVisible();
  await expect(page.locator('[data-step="1"] i')).toHaveText("Settlement interrupted");
  await expect(page.locator("#inference-error")).toContainText("provider hardware check failed");
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
  await page.locator("#retry-inference").click(); await expect(page.locator("#inference-output")).toHaveText(output);
  expect(f.counts()).toEqual({ settlements: 1, paidAttempts: 1 });
  expect(f.walletCalls.filter(method => method === "eth_signTypedData_v4")).toHaveLength(1);
  const settlements = f.requests.filter(req => req.path === "/v1/x402/settle");
  expect(settlements).toHaveLength(2); expect(settlements[0]?.body).toBe(settlements[1]?.body);
});

test("workspace refresh keeps production stage while reporting the current not-ready status", async ({ page }) => {
  const f = await fixture(page, { historyRecord: true });
  await expect(page.locator("#environment-badge")).toHaveText("NEAR GPU · PRODUCTION (REPORTED)");
  f.health.deployment.productionReady = false;
  await page.getByRole("tab", { name: "Receipts", exact: true }).click();
  await page.locator("#view-receipts [data-refresh]").click();
  await expect(page.locator("#environment-badge")).toHaveText("NEAR GPU · PRODUCTION · NOT READY");
  await expect(page.locator("#environment-description")).toContainText("Production · not ready");
  await expect(page.locator("#metric-calls")).toHaveText("1");
  await expect(page.locator("#receipt-rows tr")).toHaveCount(1);
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
  expect(f.walletCalls.filter(method => /sign/i.test(method))).toEqual(["personal_sign"]);
});

test("failed health refresh marks status unavailable while preserving wallet workspace and history", async ({ page }) => {
  const f = await fixture(page, { historyRecord: true }); f.failNextHealth();
  await page.getByRole("tab", { name: "Receipts", exact: true }).click();
  await page.locator("#view-receipts [data-refresh]").click();
  await expect(page.locator("#environment-badge")).toHaveText("STATUS UNAVAILABLE");
  await expect(page.locator("#environment-description")).not.toContainText("reported ready");
  await expect(page.locator("#wallet-login-status")).toContainText("Signed in");
  await expect(page.locator("#metric-calls")).toHaveText("1");
  await expect(page.locator("#receipt-rows tr")).toHaveCount(1);
  await expect(page.locator("#export-receipts")).toBeEnabled();
  await expect(page.locator("#run-inference")).toBeDisabled();
  await page.locator("#view-receipts [data-refresh]").click();
  await expect(page.locator("#environment-badge")).toHaveText("NEAR GPU · PRODUCTION (REPORTED)");
  await expect(page.locator("#run-inference")).toBeEnabled();
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
});

for (const admissionStatus of ["provider-unavailable", "unavailable"] as const) test(`provider rejection refreshes ${admissionStatus} status without losing the original payment recovery`, async ({ page }) => {
  if (admissionStatus === "provider-unavailable") await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page, { admissionFailureOnce: true, admissionStatus });
  await page.locator("#prompt").fill("Retain the signed payment when provider admission fails");
  await page.locator("#run-inference").click(); await expect(page.locator("#payment-dialog")).toBeVisible();
  await page.locator("#confirm-payment").click(); await expect(page.locator("#inference-recovery")).toBeVisible();
  await expect(page.locator("#environment-badge")).toHaveText(admissionStatus === "provider-unavailable" ? "NEAR GPU · PRODUCTION · PROVIDER UNAVAILABLE" : "STATUS UNAVAILABLE");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator("#environment-description")).not.toContainText("reported ready");
  await expect(page.locator("#recovery-payment")).toHaveText(`Payment ${paymentId}`);
  await expect(page.locator("#wallet-login-status")).toContainText("Signed in");
  await expect(page.locator("#retry-inference")).toBeEnabled();
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
  expect(f.requests.filter(req => req.path === "/v1/x402/settle")).toHaveLength(1);
  expect(f.walletCalls.filter(method => method === "eth_signTypedData_v4")).toHaveLength(1);
  // Only this explicit action continues; it reuses the same authorization/body.
  await page.locator("#retry-inference").click(); await expect(page.locator("#inference-output")).toHaveText(output);
  expect(f.counts()).toEqual({ settlements: 1, paidAttempts: 1 });
  expect(f.walletCalls.filter(method => method === "eth_signTypedData_v4")).toHaveLength(1);
  const settlements = f.requests.filter(req => req.path === "/v1/x402/settle");
  expect(settlements).toHaveLength(2); expect(settlements[0]?.body).toBe(settlements[1]?.body);
});

test("a delayed old production health response cannot overwrite a newer provider rejection", async ({ page }) => {
  const f = await fixture(page, { admissionFailureOnce: true, admissionStatus: "provider-unavailable" });
  const held = f.holdNextHealth();
  await page.getByRole("tab", { name: "Receipts", exact: true }).click();
  await page.locator("#view-receipts [data-refresh]").click(); await held.started;
  await page.getByRole("tab", { name: "Inference", exact: true }).click();
  await page.locator("#prompt").fill("Fence an older status read without duplicating payment");
  await page.locator("#run-inference").click(); await expect(page.locator("#payment-dialog")).toBeVisible();
  await page.locator("#confirm-payment").click();
  await expect(page.locator("#environment-badge")).toHaveText("NEAR GPU · PRODUCTION · PROVIDER UNAVAILABLE");
  await expect(page.locator("#inference-recovery")).toBeVisible();
  const obsolete = page.waitForResponse(async response => new URL(response.url()).pathname === "/api/health"
    && response.status() === 200 && (await response.json()).deployment?.productionReady === true);
  held.release();
  const oldResponse = await obsolete; await oldResponse.finished();
  // The response and body have arrived. Yield browser tasks/render frames so
  // this assertion observes the old response being processed, not the prior DOM.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator("#environment-badge")).toHaveText("NEAR GPU · PRODUCTION · PROVIDER UNAVAILABLE");
  await expect(page.locator("#recovery-payment")).toHaveText(`Payment ${paymentId}`);
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
  expect(f.requests.filter(req => req.path === "/v1/x402/settle")).toHaveLength(1);
});

test("slow health reads are not starved by routine polling or allowed to retain a ready banner on failure", async ({ page }) => {
  await page.clock.install();
  const f = await fixture(page), held = f.holdNextHealth();
  const before = f.requests.filter(req => req.path === "/health").length;
  await page.getByRole("tab", { name: "Receipts", exact: true }).click();
  await page.locator("#view-receipts [data-refresh]").click(); await held.started;
  await page.clock.runFor(10_001);
  expect(f.requests.filter(req => req.path === "/health")).toHaveLength(before + 1);
  f.failNextHealth(); held.release();
  await expect(page.locator("#environment-badge")).toHaveText("STATUS UNAVAILABLE");
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
  expect(f.walletCalls.filter(method => /sign/i.test(method))).toEqual(["personal_sign"]);
});

test("explicit candidate recovery reuses the paid request without another signature or settlement", async ({ page }) => {
  const f = await fixture(page, { lostResponse: true });
  await page.locator("#prompt").fill("Recover this request"); await page.locator("#run-inference").click();
  await expect(page.locator("#payment-dialog")).toBeVisible(); await page.locator("#confirm-payment").click();
  await expect(page.locator("#inference-recovery")).toBeVisible(); expect(f.counts()).toEqual({ settlements: 1, paidAttempts: 1 });
  await page.locator("#retry-inference").click(); await expect(page.locator("#inference-output")).toHaveText(output);
  expect(f.counts()).toEqual({ settlements: 1, paidAttempts: 2 });
  expect(f.walletCalls.filter(method => method === "eth_signTypedData_v4")).toHaveLength(1);
  const attempts = f.requests.filter(req => req.path === "/v1/inference");
  expect(new Set(attempts.map(req => req.body)).size).toBe(1);
  expect(new Set(attempts.map(req => req.headers["idempotency-key"])).size).toBe(1);
  expect(attempts.slice(1).map(req => req.headers["x-payment"])).toEqual([paymentId, paymentId]);
});

test("uncertain execution blocks retries and new inference while preserving payment history access", async ({ page }) => {
  const f = await fixture(page, { uncertainExecution: true });
  await page.locator("#prompt").fill("Do not repeat uncertain execution"); await page.locator("#run-inference").click();
  await expect(page.locator("#payment-dialog")).toBeVisible(); await page.locator("#confirm-payment").click();
  await expect(page.locator("#inference-recovery")).toBeVisible();
  await expect(page.locator("#output-status")).toHaveText("Execution uncertain · operator review required");
  await expect(page.locator("#recovery-note")).toContainText("quarantined");
  await expect(page.locator("#recovery-payment")).toContainText(paymentId);
  await expect(page.locator("#inference-error")).toContainText("Do not retry or submit another payment");
  await expect(page.locator("#retry-inference")).toBeHidden(); await expect(page.locator("#retry-inference")).toBeDisabled();
  await expect(page.locator("#dismiss-recovery")).toBeHidden(); await expect(page.locator("#dismiss-recovery")).toBeDisabled();
  await expect(page.locator("#run-inference")).toBeDisabled(); await expect(page.locator("#prompt")).toBeDisabled();
  // The handlers also reject direct events; hiding a control alone is insufficient.
  await page.locator("#retry-inference").dispatchEvent("click"); await page.locator("#dismiss-recovery").dispatchEvent("click");
  await expect(page.locator("#run-inference")).toBeDisabled();
  await page.getByRole("link", { name: "View payment history", exact: true }).click();
  await expect(page.locator("#view-payments")).toBeVisible(); await expect(page).toHaveURL(/view=payments/);
  expect(f.counts()).toEqual({ settlements: 1, paidAttempts: 1 });
  expect(f.walletCalls.filter(method => method === "eth_signTypedData_v4")).toHaveLength(1);
  expect(f.requests.filter(req => req.path === "/v1/inference")).toHaveLength(2);
});

test("wallet owner can export visible receipt and usage records without receiving mutation permissions", async ({ page }) => {
  const f = await fixture(page, { historyRecord: true });
  await page.getByRole("tab", { name: "Receipts", exact: true }).click();
  await expect(page.locator("#export-receipts")).toBeEnabled(); await expect(page.locator("#export-receipts-csv")).toBeEnabled();
  const csvDownload = page.waitForEvent("download"); await page.locator("#export-receipts-csv").click();
  const receiptCsv = await csvDownload; expect(receiptCsv.suggestedFilename()).toBe("enclave-receipts.csv");
  const csv = await readFile((await receiptCsv.path())!, "utf8"); expect(csv).toContain(f.stored.typedHash); expect(csv).toContain(f.stored.anchoredTx);
  await page.getByRole("tab", { name: "USDC usage", exact: true }).click();
  await expect(page.locator("#export-usage")).toBeEnabled();
  const usageDownload = page.waitForEvent("download"); await page.locator("#export-usage").click();
  const usageCsv = await usageDownload; expect(usageCsv.suggestedFilename()).toBe("enclave-usage.csv");
  const usage = await readFile((await usageCsv.path())!, "utf8"); expect(usage).toContain(paymentId); expect(usage).toContain("0.100000");
  for (const action of ["#new-agent", "#issue-view-key"]) await expect(page.locator(action)).toBeDisabled();
  expect(f.requests.some(request => ["/v1/agents", "/v1/compliance/view-keys", "/v1/x402/settle", "/v1/session", "/v1/inference"].includes(request.path))).toBe(false);
  expect(f.walletCalls.filter(method => /sign/i.test(method))).toEqual(["personal_sign"]);
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
});

test("fast wallet resume preserves the dashboard document through query updates and full navigation", async ({ page }) => {
  const f = await fixture(page, { historyRecord: true, resumeAfterLogin: true });
  await page.evaluate(() => { Reflect.set(window, "fixtureDashboardNode", document.getElementById("connection-status")); });
  await page.evaluate(() => { history.replaceState({}, "", "/dashboard?view=receipts"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page).toHaveURL(/view=receipts/);
  await expect(page.locator("#connection-status")).toContainText("Connected");
  expect(await page.evaluate(() => Reflect.get(window, "fixtureDashboardNode") === document.getElementById("connection-status"))).toBe(true);
  await page.goto("/"); await expect(page.locator("#site-document")).toBeVisible();
  await page.goto("/dashboard"); await expect(page.locator(".wallet-notice")).toHaveText("Wallet connection restored.");
  await expect(page.locator("#connection-status")).toContainText("Connected");
  await expect(page.locator("#run-inference")).toBeEnabled();
  await page.reload(); await expect(page.locator(".wallet-notice")).toHaveText("Wallet connection restored.");
  await expect(page.locator("#connection-status")).toContainText("Connected");
  expect(f.walletCalls.filter(method => /sign/i.test(method))).toEqual(["personal_sign"]);
  expect(f.requests.filter(request => request.path === "/v1/auth/wallet/resume").length).toBeGreaterThanOrEqual(3);
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
});

test("restoring wallet login visibly waits for policy and disables another sign-in until workspace is ready", async ({ page }) => {
  const f = await fixture(page, { historyRecord: true, resumeAfterLogin: true });
  const held = f.holdNextPolicies();
  await page.goto("/"); await page.goto("/dashboard"); await held.started;
  await expect(page.locator(".wallet-notice")).toHaveText("Wallet connection restored.");
  await expect(page.locator("#connection-status")).toHaveText("Loading workspace and gateway policy…");
  await expect(page.locator("#wallet-login-status")).toContainText("Restoring your wallet login");
  await expect(page.locator("#wallet-login")).toBeDisabled(); await expect(page.locator("#run-inference")).toBeDisabled();
  expect(f.walletCalls.filter(method => /sign/i.test(method))).toEqual(["personal_sign"]);
  held.release();
  await expect(page.locator("#connection-status")).toContainText("Connected");
  await expect(page.locator("#wallet-login-status")).toHaveText("Signed in. Payments are confirmed separately in your wallet.");
  await expect(page.locator("#run-inference")).toBeEnabled();
  await expect(page.locator("#metric-calls")).toHaveText("1");
  expect(f.requests.filter(request => request.path === "/v1/auth/wallet/challenge")).toHaveLength(1);
  expect(f.walletCalls.filter(method => /sign/i.test(method))).toEqual(["personal_sign"]);
  expect(f.counts()).toEqual({ settlements: 0, paidAttempts: 0 });
});
