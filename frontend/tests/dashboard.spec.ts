import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { hashTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// All HTTP API traffic is fulfilled here. Neither a gateway nor a funded wallet is used.
const key = "BROWSER-OWNER-SECRET-CANARY";
const hash = (value: string | Buffer): Hex => `0x${createHash("sha256").update(value).digest("hex")}`;
const signer = privateKeyToAccount(`0x${"23".repeat(32)}`);
const modelHash = hash("model:zai-org/GLM-5.3-Flash"), codeHash = hash("software-gateway-code");
const verifier = `0x${"12".repeat(20)}` as Hex, signature = `0x${"34".repeat(65)}`;
const ids = { receipt: "10000000-0000-4000-8000-000000000001", payment: "20000000-0000-4000-8000-000000000002",
  agent: "30000000-0000-4000-8000-000000000003", model: "40000000-0000-4000-8000-000000000004", session: "50000000-0000-4000-8000-000000000005" };
const createdAt = "2026-09-21T00:00:00.000Z", output = "PRIVATE-OUTPUT-CANARY: the signed browser flow completed.";
const receiptTypes = { InferenceReceipt: [
  { name: "modelHash", type: "bytes32" }, { name: "codeHash", type: "bytes32" }, { name: "inHash", type: "bytes32" },
  { name: "outHash", type: "bytes32" }, { name: "attRef", type: "bytes32" }, { name: "nonce", type: "bytes32" }, { name: "ts", type: "uint64" },
] } as const;

async function fixture(page: Page, options: { rejected?: boolean; maliciousName?: string; authorized?: boolean; paidFailureOnce?: boolean;
  paginated?: boolean; secondReceipt?: boolean; backend?: "near-verified" | "openai-compatible" } = {}) {
  const health = { ok: true, service: "enclave-gateway", teeMode: "dev", inferenceBackend: options.backend ?? "near-verified", chainId: options.authorized ? 8453 : 31337,
    paymentMode: options.authorized ? "authorized" : "mock", servingModel: { id: "zai-org/GLM-5.3-Flash", name: "GLM-5.3-Flash", modelHash, codeHash },
    receiptSigner: signer.address, verifierAddress: verifier, agentRuntimeEnabled: false, inferencePriceUsdc: 0.1 };
  const quote = { cpuQuote: "development-software", gpuQuote: "development-software", measurement: codeHash, tcbVersion: 1, timestamp: Date.now(), signature };
  const stored = { id: ids.receipt, receiptVersion: 2, nonce: hash("stored-nonce"), chainId: health.chainId, verifierAddress: verifier, modelHash, codeHash,
    inHash: hash("old-input"), outHash: hash("old-output"), attRef: hash(signature), ts: "1800489600", sig: signature, typedHash: hash("stored-receipt"),
    status: "anchored", anchoredTx: hash("anchor"), agentId: null, createdAt };
  const storedTyped = { domain: { name: "ENCLAVE", version: "2", chainId: health.chainId, verifyingContract: verifier }, types: receiptTypes,
    primaryType: "InferenceReceipt" as const, message: { ...stored, ts: BigInt(stored.ts) } };
  stored.sig = await signer.signTypedData(storedTyped); stored.typedHash = hashTypedData(storedTyped);
  const older = { ...stored, id: "70000000-0000-4000-8000-000000000007", typedHash: hash("unverified-second-receipt"), createdAt: "2026-09-20T00:00:00.000Z" };
  const workspace = { usage: { calls: 7, usdcUnits: "700000" }, receipts: [stored], payments: [{ id: ids.payment, amountUnits: "100000", status: "consumed",
    settleTx: hash("settle"), receiptHash: stored.typedHash, agentId: null, listingId: 1, confidential: false, createdAt }],
    agents: [{ id: ids.agent, name: options.maliciousName ?? "Owner research mandate", policyHash: hash("policy"), memoryHash: hash(""), createdAt,
      dailyLimitUnits: "1000000", spentTodayUnits: "300000", lane: "agent", allowedModels: [modelHash] }],
    page: { limit: 50, receiptsNext: options.paginated ? stored.id : null, paymentsNext: null, agentsNext: null } };
  if (options.secondReceipt) workspace.receipts.push(older);
  const policy = { version: 1, servingImageId: "software-gateway-image", measurement: codeHash, policyHash: hash("policy"), status: "active",
    binding: "legacy", scope: null, trustMode: "development-software", activatedAt: null, createdAt };
  const sessionKey = Buffer.alloc(32, 71);
  const requests: Array<{ path: string; method: string; headers: Record<string, string>; body: string | null }> = [];
  let settlements = 0, inferences = 0;
  let delayedHealth: { wait: Promise<void>; entered: () => void } | null = null;
  function holdNextHealth() {
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    delayedHealth = { wait, entered };
    return { release, started };
  }
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) {
      if (url.origin === "http://127.0.0.1:5173") return route.continue();
      return route.abort(); // Fonts/analytics/unknown origins cannot become external inference traffic.
    }
    const path = url.pathname.slice(4), headers = req.headers();
    requests.push({ path, method: req.method(), headers, body: req.postData() });
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/health") {
      const held = delayedHealth; delayedHealth = null;
      if (held) { held.entered(); await held.wait; }
      return reply(health);
    }
    if (path === "/v1/models") return reply([{ id: ids.model, modelHash, codeHash, version: "development-v1", provider: "NEAR", approved: true, revoked: false, listingBps: 0, listingId: 1, createdAt }]);
    if (path === "/v1/tcb/policies") return reply({ active: policy, history: [policy] });
    if (path === "/v1/attestation/quote") return reply({ ...quote, timestamp: Date.now() });
    if (options.rejected || headers["x-api-key"] !== key) return reply({ title: "UNAUTHORIZED", detail: "Unknown API key", status: 401 }, 401);
    if (path === "/v1/workspace") {
      if (options.paginated && url.searchParams.get("receiptsBefore") === stored.id) return reply({ ...workspace, receipts: [older], page: { ...workspace.page, receiptsNext: null } });
      return reply(workspace);
    }
    if (path === "/v1/session") return reply({ sessionId: ids.session, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), wrapKey: sessionKey.toString("base64") }, 201);
    if (path === "/v1/x402/settle") { settlements++; return reply({ paymentId: ids.payment, tx: hash("new-settlement"), confidential: false }); }
    if (path === "/v1/inference") {
      const body = req.postDataJSON() as { sessionId: string; iv: string; tag: string; ciphertext: string };
      if (!headers["x-payment"]) return reply({ title: "PAYMENT_REQUIRED", status: 402, detail: "USDC payment required", details: { x402Version: 1,
        accepts: [{ scheme: "exact", network: `arc-${health.chainId}`, maxAmountRequired: "100000", payTo: verifier, asset: verifier, extra: { paymentId: ids.payment, receiptPending: true } }] } }, 402);
      inferences++;
      if (options.paidFailureOnce && inferences === 1) return reply({ title: "INFERENCE_BACKEND_FAILED", status: 503, detail: "Fixture lost the paid response" }, 503);
      const decipher = createDecipheriv("aes-256-gcm", sessionKey, Buffer.from(body.iv, "base64"));
      decipher.setAuthTag(Buffer.from(body.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(body.ciphertext, "base64")), decipher.final()]);
      const iv = Buffer.alloc(12, 52), cipher = createCipheriv("aes-256-gcm", sessionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(output), cipher.final()]);
      const receipt = { receiptVersion: 2 as const, nonce: hash("new-nonce"), modelHash, codeHash, inHash: hash(plaintext), outHash: hash(output), attRef: hash(signature), ts: BigInt(Math.floor(Date.now() / 1000)) };
      const typed = { domain: { name: "ENCLAVE", version: "2", chainId: health.chainId, verifyingContract: verifier }, types: receiptTypes, primaryType: "InferenceReceipt" as const, message: receipt };
      const sig = await signer.signTypedData(typed), typedHash = hashTypedData(typed);
      workspace.receipts.unshift({ ...stored, ...receipt, ts: receipt.ts.toString(), sig, typedHash, id: "60000000-0000-4000-8000-000000000006" });
      return reply({ receipt: { ...receipt, ts: receipt.ts.toString(), sig }, typedHash, outputHash: receipt.outHash,
        output: { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") } });
    }
    return reply({ title: "UNEXPECTED_TEST_API", status: 500 }, 500);
  });
  await page.goto("/dashboard/");
  await expect(page).toHaveURL(/view=inference/); // The imperative dashboard has mounted after hydration.
  return { health, workspace, requests, older, holdNextHealth, counts: () => ({ settlements, inferences }) };
}

async function connect(page: Page) {
  await page.locator("#api-key").fill(key);
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await expect(page.locator("#connection-status")).toContainText("Connected");
}

test("unauthorized connection shows a real error and never falls back to populated preview data", async ({ page }) => {
  const f = await fixture(page, { rejected: true });
  await page.locator("#api-key").fill(key);
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await expect(page.locator("#connection-error")).toContainText("API key was rejected");
  await expect(page.locator("#environment-badge")).toHaveText("NOT CONNECTED");
  await expect(page.locator("#metric-calls")).toHaveText("0");
  await expect(page.locator("#receipt-rows tr")).toHaveCount(0);
  await expect(page.locator("#run-inference")).toBeDisabled();
  expect(f.counts()).toEqual({ settlements: 0, inferences: 0 });
});

test("connection distinguishes NEAR GPU, software gateway and local test chain with owner history", async ({ page }) => {
  const f = await fixture(page); await connect(page);
  await expect(page.locator("#environment-badge")).toHaveText("NEAR GPU · DEVELOPMENT GATEWAY");
  await expect(page.locator("#environment-description")).toContainText("gateway and its keys run in software");
  await expect(page.locator("#topology-chain")).toHaveText("CHAIN 31337 · TEST USDC · x402");
  await expect(page.locator("#metric-calls")).toHaveText("7");
  await expect(page.locator("#metric-usage")).toHaveText("0.700000");
  await expect(page.locator("#model-select")).toBeDisabled();
  await expect(page.locator("#model-select option")).toHaveText("GLM-5.3-Flash");
  await page.getByRole("tab", { name: "Receipts", exact: true }).click();
  await expect(page.locator("#receipt-rows tr")).toHaveCount(1);
  await expect(page.locator("#receipt-rows")).toContainText(ids.receipt);
  await page.getByRole("tab", { name: "Agent mandates", exact: true }).click();
  await expect(page.locator("#agent-cards")).toContainText("Owner research mandate");
  await expect(page.locator("#agent-cards")).toContainText("1.000000 USDC");
  await expect(page.locator("#agent-cards")).toContainText("0.300000 USDC");
  expect(f.requests.find((r) => r.path === "/v1/workspace")?.headers["x-api-key"]).toBe(key);
  await expect(page.locator("#api-key")).toHaveValue("");
});

test("stored hostile agent names are text, never executable HTML", async ({ page }) => {
  const maliciousName = '<img src=x onerror="document.body.dataset.pwned=1">';
  await fixture(page, { maliciousName }); await connect(page);
  await page.getByRole("tab", { name: "Agent mandates", exact: true }).click();
  await expect(page.locator("#agent-cards h3")).toHaveText(maliciousName);
  await expect(page.locator("#agent-cards img")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute("data-pwned", "1");
  await expect(page.locator("#inference-agent option")).toHaveText(maliciousName);
});

test("encrypted request waits for explicit local payment and disconnect clears private data", async ({ page }) => {
  const f = await fixture(page); await connect(page);
  const prompt = "PRIVATE-PROMPT-CANARY: explain the receipt.";
  await page.locator("#prompt").fill(prompt);
  await page.locator("#run-inference").click();
  await expect(page.locator("#payment-dialog")).toBeVisible();
  await expect(page.locator("#payment-amount")).toHaveText("0.100000 USDC");
  expect(f.counts()).toEqual({ settlements: 0, inferences: 0 });
  const initial = f.requests.find((r) => r.path === "/v1/inference")!;
  expect(initial.body).not.toContain(prompt);
  expect(JSON.parse(initial.body!)).toMatchObject({ sessionId: ids.session, iv: expect.any(String), tag: expect.any(String), ciphertext: expect.any(String) });
  await page.locator("#confirm-payment").click();
  await expect(page.locator("#inference-output")).toHaveText(output);
  await expect(page.locator("#output-status")).toHaveText("Response verified");
  expect(f.counts()).toEqual({ settlements: 1, inferences: 1 });
  const calls = f.requests.filter((r) => r.path === "/v1/inference");
  expect(calls[1]?.body).toBe(initial.body);
  expect(calls[1]?.headers["idempotency-key"]).toBe(initial.headers["idempotency-key"]);
  await page.locator("#disconnect-gateway").click();
  await expect(page.locator("#connection-status")).toHaveText("Disconnected");
  await expect(page.locator("#prompt")).toHaveValue("");
  await expect(page.locator("#api-key")).toHaveValue("");
  await expect(page.locator("#receipt-rows tr")).toHaveCount(0);
  await expect(page.locator("#agent-cards")).not.toContainText("Owner research mandate");
  await expect(page.locator("#metric-calls")).toHaveText("0");
  await expect(page.locator("body")).not.toContainText(output);
  await expect(page.locator("#run-inference")).toBeDisabled();
  const persisted = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie }));
  expect(JSON.stringify(persisted)).not.toMatch(/BROWSER-OWNER-SECRET|PRIVATE-PROMPT|PRIVATE-OUTPUT/);
});

test("cancelling a payment challenge does not settle or execute inference", async ({ page }) => {
  const f = await fixture(page); await connect(page);
  await page.locator("#prompt").fill("Cancel before spending");
  await page.locator("#run-inference").click();
  await expect(page.locator("#payment-dialog")).toBeVisible();
  await page.locator("#cancel-payment").click();
  await expect(page.locator("#output-status")).toHaveText("Payment not submitted");
  await expect(page.locator("#run-inference")).toBeEnabled();
  expect(f.counts()).toEqual({ settlements: 0, inferences: 0 });
});

test("a real-network authorized challenge never enables automatic settlement", async ({ page }) => {
  const f = await fixture(page, { authorized: true }); await connect(page);
  await page.locator("#prompt").fill("Do not authorize a wallet automatically");
  await page.locator("#run-inference").click();
  await expect(page.locator("#payment-dialog")).toBeVisible();
  await expect(page.locator("#confirm-payment")).toBeDisabled();
  await expect(page.locator("#payment-mode-note")).toContainText("external wallet authorization");
  await page.locator("#cancel-payment").click();
  expect(f.requests.some((r) => r.path === "/v1/x402/settle")).toBe(false);
  expect(f.counts()).toEqual({ settlements: 0, inferences: 0 });
});

test("mobile workspace tabs support keyboard navigation without hiding their active panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page); await connect(page);
  const inference = page.getByRole("tab", { name: "Inference", exact: true });
  await inference.focus(); await inference.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Receipts", exact: true })).toBeFocused();
  await expect(page.locator("#view-receipts")).toBeVisible();
  await expect(page.locator("#view-inference")).toBeHidden();
  await page.getByRole("tab", { name: "Receipts", exact: true }).press("End");
  await expect(page.getByRole("tab", { name: "Audit controls", exact: true })).toBeFocused();
  await expect(page.locator("#view-compliance")).toBeVisible();
});

test("uncertain paid response requires explicit recovery with the same request and one settlement", async ({ page }) => {
  await page.clock.install();
  const f = await fixture(page, { paidFailureOnce: true }); await connect(page);
  await page.locator("#prompt").fill("Retry this exact encrypted request, without another payment");
  await page.locator("#run-inference").click();
  await expect(page.locator("#payment-dialog")).toBeVisible();
  await page.locator("#confirm-payment").click();
  await expect(page.locator("#inference-recovery")).toBeVisible();
  await expect(page.locator("#run-inference")).toBeDisabled();
  await expect(page.locator("#prompt")).toBeDisabled();
  await expect(page.locator("#recovery-payment")).toContainText(ids.payment);
  expect(f.counts()).toEqual({ settlements: 1, inferences: 1 });
  await page.clock.fastForward(10_000);
  expect(f.counts()).toEqual({ settlements: 1, inferences: 1 });
  await page.locator("#retry-inference").click();
  await expect(page.locator("#inference-output")).toHaveText(output);
  await expect(page.locator("#inference-recovery")).toBeHidden();
  await expect(page.locator("#run-inference")).toBeEnabled();
  expect(f.counts()).toEqual({ settlements: 1, inferences: 2 });
  const attempts = f.requests.filter((request) => request.path === "/v1/inference");
  expect(attempts).toHaveLength(3);
  expect(new Set(attempts.map((request) => request.body)).size).toBe(1);
  expect(new Set(attempts.map((request) => request.headers["idempotency-key"])).size).toBe(1);
  expect(attempts.slice(1).map((request) => request.headers["x-payment"])).toEqual([ids.payment, ids.payment]);
  expect(f.requests.filter((request) => request.path === "/v1/session")).toHaveLength(1);
});

test("late successful verification of receipt A cannot mark newly selected receipt B as verified", async ({ page }) => {
  const f = await fixture(page, { secondReceipt: true }); await connect(page);
  // Observe completion of the genuine crypto verifier without changing its input, output or timing.
  await page.evaluate(async () => {
    const modulePath = "/src/enclave/api.ts";
    const { EnclaveClient } = await import(modulePath);
    const verify = EnclaveClient.prototype.verifyReceipt;
    EnclaveClient.prototype.verifyReceipt = async function (this: unknown, record: { typedHash: string }, options: unknown) {
      const result = await verify.call(this, record, options);
      (window as Window & { completedReceiptVerification?: string }).completedReceiptVerification = record.typedHash;
      return result;
    };
  });
  await page.getByRole("tab", { name: "Receipts", exact: true }).click();
  await page.locator(`[data-receipt="${f.workspace.receipts[0]!.typedHash}"]`).click();
  const held = f.holdNextHealth();
  await page.locator("#verify-receipt").click(); await held.started;
  await expect(page.locator("#receipt-integrity")).toContainText("Checking");
  await page.getByRole("button", { name: "Close receipt", exact: true }).click();
  await page.locator(`[data-receipt="${f.older.typedHash}"]`).click();
  await expect(page.locator("#receipt-fields")).toContainText(f.older.typedHash);
  held.release();
  await page.waitForFunction((typedHash) => (window as Window & { completedReceiptVerification?: string }).completedReceiptVerification === typedHash, f.workspace.receipts[0]!.typedHash);
  await expect(page.locator("#receipt-integrity")).toBeEmpty();
  await expect(page.locator("#receipt-fields")).toContainText(f.older.typedHash);
  // B has an intentionally invalid typed hash; its own verification must still fail.
  await page.locator("#verify-receipt").click();
  await expect(page.locator("#receipt-integrity")).toContainText("Stored receipt signature or domain is invalid");
});

test("expanded receipt history survives automatic polling and resets only on explicit refresh", async ({ page }) => {
  await page.clock.install();
  const f = await fixture(page, { paginated: true }); await connect(page);
  await page.getByRole("tab", { name: "Receipts", exact: true }).click();
  await page.locator("#load-more-receipts").click();
  await expect(page.locator("#receipt-rows tr")).toHaveCount(2);
  await expect(page.locator("#receipt-rows")).toContainText(f.older.id);
  await expect(page.locator("#workspace-updated")).toContainText("automatic refresh paused");
  const previousRequests = f.requests.filter((request) => request.path === "/v1/workspace").length;
  await page.clock.fastForward(10_000);
  await expect(page.locator("#receipt-rows tr")).toHaveCount(2);
  expect(f.requests.filter((request) => request.path === "/v1/workspace")).toHaveLength(previousRequests);
  await page.locator("#view-receipts [data-refresh]").click();
  await expect(page.locator("#receipt-rows tr")).toHaveCount(1);
  await expect(page.locator("#receipt-rows")).not.toContainText(f.older.id);
  await expect(page.locator("#load-more-receipts")).toBeVisible();
  await expect(page.locator("#toast")).toContainText("latest page");
});

test("OpenAI-compatible provider is labelled as a model endpoint without echo or hardware claims", async ({ page }) => {
  await fixture(page, { backend: "openai-compatible" }); await connect(page);
  await expect(page.locator("#environment-badge")).toHaveText("MODEL ENDPOINT · DEVELOPMENT GATEWAY");
  await expect(page.locator("#environment-description")).toContainText("does not verify provider hardware");
  await expect(page.locator("#topology-provider")).toHaveText("OpenAI-compatible model provider");
  await expect(page.locator("#request-note")).not.toContainText("Echo");
  await expect(page.locator("#provider-trust-note")).toContainText("hardware not verified");
});
