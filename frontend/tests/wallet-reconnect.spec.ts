import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { hexToString, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

// The SDK module, every API response and wallet directory are intercepted.
// Synthetic, unfunded signatures stay in Node; no relay or paid service is used.
const signer = privateKeyToAccount(`0x${"23".repeat(32)}`), other = privateKeyToAccount(`0x${"24".repeat(32)}`);
const oldTopic = "a".repeat(64), meter = `0x${"12".repeat(20)}`, projectId = "b".repeat(32);
const paymentId = "20000000-0000-4000-8000-000000000002", sessionId = "50000000-0000-4000-8000-000000000005";
const hash = (text: string): Hex => `0x${createHash("sha256").update(text).digest("hex")}`;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function reconnectFixture(page: Page, options: { resume?: boolean; rejectPayment?: boolean } = {}) {
  const requests: { path: string; body: Record<string, unknown> | null; headers: Record<string, string> }[] = [];
  const walletCalls: { topic: string; method: string }[] = [], pairings: { topic: string; approval: ReturnType<typeof deferred<string>> }[] = [];
  const signatures: { message: string; approval: ReturnType<typeof deferred<Hex>> }[] = [];
  const cleanups: { topic: string; done: ReturnType<typeof deferred<void>> }[] = [], pairingCleanups: string[] = [];
  const challenges = new Map<string, string>(), loginToken = `enws_${"ab".repeat(32)}`;
  let loginReady = Boolean(options.resume), challengeNumber = 0;
  await page.exposeBinding("reconnectFixtureApproval", (_source, topic: string) => {
    const approval = deferred<string>(); pairings.push({ topic, approval }); return approval.promise;
  });
  await page.exposeBinding("reconnectFixtureDisconnect", (_source, topic: string) => {
    const done = deferred<void>(); cleanups.push({ topic, done }); return done.promise;
  });
  await page.exposeBinding("reconnectFixturePairingDisconnect", (_source, topic: string) => { pairingCleanups.push(topic); });
  await page.exposeBinding("reconnectFixtureRequest", (_source, args: { topic: string; request: { method: string; params: unknown[] } }) => {
    walletCalls.push({ topic: args.topic, method: args.request.method });
    if (args.request.method === "personal_sign") {
      const message = hexToString(String(args.request.params[0]) as Hex);
      expect(challenges.has(message)).toBe(true); expect(args.request.params[1]).toBe(signer.address);
      const approval = deferred<Hex>(); signatures.push({ message, approval }); return approval.promise;
    }
    if (args.request.method === "eth_signTypedData_v4" && options.rejectPayment) throw Error("There is no existing session matching the topic");
    throw Error("Unexpected reconnect fixture wallet method");
  });
  await page.addInitScript(({ address, oldTopic }) => {
    type Handler = (event: { topic: string }) => void;
    const listeners = new Map<string, Set<Handler>>();
    const session = (topic: string, address: string) => ({ topic, expiry: Math.floor(Date.now() / 1000) + 3600,
      peer: { metadata: { name: "OKX reconnect fixture" } },
      namespaces: { eip155: { accounts: [`eip155:5042:${address}`], methods: ["personal_sign", "eth_signTypedData_v4"] } } });
    const sessions = new Map([[oldTopic, session(oldTopic, address)]]);
    let number = 1;
    const client = {
      session: { get: (topic: string) => { const value = sessions.get(topic); if (!value) throw Error("No matching key. session topic doesn't exist"); return value; } },
      connect: async () => {
        const topic = (++number).toString(16).padStart(64, "0");
        return { uri: `wc:${topic}@2?symKey=synthetic`, approval: async () => {
          const approved = session(topic, await Reflect.get(window, "reconnectFixtureApproval")(topic)); sessions.set(topic, approved); return approved;
        } };
      },
      disconnect: async ({ topic }: { topic: string }) => {
        await Reflect.get(window, "reconnectFixtureDisconnect")(topic); sessions.delete(topic);
        for (const handler of listeners.get("session_delete") ?? []) handler({ topic });
      },
      request: (args: unknown) => Reflect.get(window, "reconnectFixtureRequest")(args),
      on: (name: string, handler: Handler) => { let set = listeners.get(name); if (!set) listeners.set(name, set = new Set()); set.add(handler); },
      off: (name: string, handler: Handler) => { listeners.get(name)?.delete(handler); },
      core: { pairing: { disconnect: async ({ topic }: { topic: string }) => { await Reflect.get(window, "reconnectFixturePairingDisconnect")(topic); } } },
    };
    Reflect.set(window, "reconnectFixtureClient", client);
    Reflect.set(window, "reconnectFixturePageId", crypto.randomUUID());
    localStorage.setItem("enclave.wallet.selection", JSON.stringify({ transport: "walletconnect", address, chainId: 5042, topic: oldTopic }));
  }, { address: signer.address, oldTopic });
  const codeHash = hash("code"), policyHash = hash("policy"), quoteSignature = `0x${"34".repeat(65)}`;
  const health = { ok: true, service: "synthetic-reconnect-fixture", teeMode: "managed-near", inferenceBackend: "near-verified",
    inferenceRoute: "near-direct-experimental", chainId: 5042, paymentMode: "authorized", settlementToken: "0x3600000000000000000000000000000000000000",
    servingModel: { id: "fixture", name: "Reconnect fixture", modelHash: hash("model"), codeHash }, receiptSigner: signer.address,
    verifierAddress: meter, agentRuntimeEnabled: false, inferencePriceUsdc: 0.1,
    deployment: { stage: "production", productionReady: true, providerAdmissionReady: true, gatewayKeyCustody: "software", inferenceTrust: "near-cpu-gpu", releaseProfile: "near-arc" },
    providerPolicy: { sha256: policyHash, expiresAt: "2030-01-01T00:00:00Z" } };
  const policy = { version: 2, servingImageId: "reconnect-fixture", measurement: codeHash, policyHash, status: "active",
    binding: "registry", scope: null, trustMode: "development-software", activatedAt: null, createdAt: "2026-10-05T00:00:00Z" };
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith("/@walletconnect_sign-client.js")) return route.fulfill({ contentType: "application/javascript", body: "export default class FixtureClient { static async init() { return window.reconnectFixtureClient; } }" });
    if (url.pathname === "/src/enclave/wallets.ts") {
      const response = await route.fetch(), source = await response.text();
      expect(source).toContain("export const walletProjectId");
      return route.fulfill({ response, body: source.replace(/export const walletProjectId =[\s\S]*?export const connectionNetworks/, `export const walletProjectId = "${projectId}";\nexport const connectionNetworks`) });
    }
    if (url.pathname === "/src/enclave/arc-payment.ts") {
      const response = await route.fetch(); let source = await response.text();
      for (const [key, value] of Object.entries({ VITE_ARC_PAYMENTS_ENABLED: "true", VITE_ARC_USAGE_METER: meter, VITE_ARC_VERIFIER: meter,
        VITE_ARC_RECEIPT_SIGNER: signer.address, VITE_ARC_MAX_PAYMENT_UNITS: "100000" })) source = source.replaceAll(`import.meta.env["${key}"]`, JSON.stringify(value));
      return route.fulfill({ response, body: source });
    }
    if (url.hostname === "explorer-api.walletconnect.com") return route.fulfill({ status: 200, json: { listings: {}, total: 0 } });
    if (url.pathname === "/ui-release.json") return route.fulfill({ status: 200, json: { schemaVersion: 1, revision: 1, updatedAt: "2026-10-05T00:00:00Z",
      features: { receiptDrop: false, verificationBadge: false, copyIdentifiers: false, historyFilters: false, mandateProgress: false, dataPath: false } } });
    if (!url.pathname.startsWith("/api/")) return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
    const path = url.pathname.slice(4), body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    requests.push({ path, body, headers: request.headers() });
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === "/v1/auth/wallet/config") return reply({ enabled: true, origin: url.origin, chainId: 5042 });
    if (path === "/v1/auth/wallet/resume") return loginReady ? reply({ token: loginToken, address: signer.address, expiresAt: new Date(Date.now() + 1_800_000).toISOString() }) : reply({}, 401);
    if (path === "/v1/auth/wallet/logout") { loginReady = false; return reply({ ok: true }); }
    if (path === "/v1/auth/wallet/challenge") {
      expect(body?.address).toBe(signer.address);
      const id = (++challengeNumber).toString(16).padStart(48, "0"), message = createSiweMessage({ domain: url.host, address: signer.address,
        uri: `${url.origin}/dashboard`, chainId: 5042, version: "1", nonce: id, issuedAt: new Date(), expirationTime: new Date(Date.now() + 300_000),
        statement: "Sign in to Enclave. This does not authorize a payment." });
      challenges.set(message, id); return reply({ id, message });
    }
    if (path === "/v1/auth/wallet/verify") {
      const message = [...challenges].find(([, id]) => id === body?.id)?.[0]; expect(message).toBeDefined();
      expect(body?.signature).toBe(await signer.signMessage({ message: message! })); loginReady = true;
      return reply({ token: loginToken, address: signer.address, expiresAt: new Date(Date.now() + 1_800_000).toISOString() });
    }
    if (path === "/health") return reply(health);
    if (path === "/v1/models") return reply([]);
    if (path === "/v1/tcb/policies") return reply({ active: policy, history: [policy] });
    if (path === "/v1/workspace") return reply({ usage: { calls: 0, usdcUnits: "0" }, receipts: [], payments: [], agents: [], page: { limit: 50, receiptsNext: null, paymentsNext: null, agentsNext: null } });
    if (path === "/v1/attestation/quote") return reply({ cpuQuote: "fixture", gpuQuote: "fixture", measurement: codeHash, tcbVersion: 2, timestamp: Date.now(), signature: quoteSignature });
    if (path === "/v1/session") return reply({ sessionId, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), wrapKey: Buffer.alloc(32, 71).toString("base64") });
    if (path === "/v1/inference" && !request.headers()["x-payment"]) return reply({ title: "PAYMENT_REQUIRED", status: 402, details: { x402Version: 1,
      accepts: [{ scheme: "exact", network: "arc-5042", maxAmountRequired: "100000", payTo: meter, asset: health.settlementToken, extra: { paymentId, receiptPending: true } }] } }, 402);
    // This suite never settles or dispatches a paid inference, even synthetically.
    expect(["/v1/x402/settle", "/v1/inference"]).not.toContain(path);
    return reply({ title: "UNEXPECTED_RECONNECT_FIXTURE_REQUEST", status: 500 }, 500);
  });
  await page.goto("/dashboard");
  await expect(page.locator(".wallet-notice")).toHaveText("Saved wallet session. Open your wallet to sign in, or reconnect with QR.");
  await expect(page.locator("#wallet-login")).toBeEnabled();
  const pageId = await page.evaluate(() => Reflect.get(window, "reconnectFixturePageId"));
  const reconnect = page.locator(".wallet-control").getByRole("button", { name: "Reconnect via QR", exact: true });
  async function openQr(index = 0) {
    await reconnect.click();
    await expect(page.getByRole("dialog", { name: "Connect your wallet" })).toBeVisible();
    await expect.poll(() => pairings.length).toBe(index + 1);
    await expect(page.getByRole("img", { name: "WalletConnect pairing QR code" })).toBeVisible();
  }
  async function approveQr(index = 0, address = signer.address) { pairings[index]!.approval.resolve(address); }
  async function beginSignature(index: number) {
    await page.locator("#wallet-login").click(); await expect.poll(() => signatures.length).toBe(index + 1);
    await expect(page.locator("#wallet-login")).toBeDisabled();
  }
  async function approveSignature(index: number) { signatures[index]!.approval.resolve(await signer.signMessage({ message: signatures[index]!.message })); }
  async function assertNoReloadOrPayment() {
    expect(await page.evaluate(() => Reflect.get(window, "reconnectFixturePageId"))).toBe(pageId);
    expect(requests.filter(row => row.path === "/v1/x402/settle" || row.path === "/v1/inference" && row.headers["x-payment"])).toEqual([]);
  }
  return { requests, walletCalls, pairings, cleanups, pairingCleanups, reconnect, openQr, approveQr, beginSignature, approveSignature, assertNoReloadOrPayment };
}

test("Reconnect via QR cancels a stale sign-in before timeout and ignores the old signature and cleanup", async ({ page }) => {
  const f = await reconnectFixture(page); await f.beginSignature(0); await f.openQr();
  await expect(page.locator("#wallet-login")).toBeEnabled();
  await expect.poll(() => f.cleanups.length).toBe(1); expect(f.cleanups[0]!.topic).toBe(oldTopic);
  expect(f.requests.filter(row => row.path.endsWith("/verify"))).toHaveLength(0);
  await f.approveQr(); await expect(page.locator(".wallet-dialog")).not.toBeVisible();
  await expect(page.locator("#wallet-login-status")).toHaveText("Wallet connected. Sign in to load your workspace. Signing in is free.");
  await expect(page.locator("#connection-error")).toBeEmpty();
  await f.beginSignature(1); await f.approveSignature(0);
  await page.waitForTimeout(30); expect(f.requests.filter(row => row.path.endsWith("/verify"))).toHaveLength(0);
  await expect(page.locator("#wallet-login")).toBeDisabled(); await f.approveSignature(1);
  await expect(page.locator("#connection-status")).toContainText("Connected ·");
  f.cleanups[0]!.done.resolve(); await expect(page.locator(".wallet-network")).toHaveText("OKX reconnect fixture · Arc Mainnet");
  expect(f.requests.filter(row => row.path.endsWith("/verify")).map(row => row.body?.id)).toEqual(["2".padStart(48, "0")]);
  expect(f.walletCalls.map(row => row.method)).toEqual(["personal_sign", "personal_sign"]);
  await f.assertNoReloadOrPayment();
});

test("cancelling a fresh QR preserves the signed workspace and restores keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const f = await reconnectFixture(page, { resume: true });
  await expect(page.locator("#connection-status")).toContainText("Connected ·");
  await f.openQr(); await expect(page.locator("#wallet-login-status")).toContainText("Signed in · wallet disconnected");
  expect(await page.locator(".wallet-dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press("Escape"); await expect(page.locator(".wallet-dialog")).not.toBeVisible(); await expect(f.reconnect).toBeFocused();
  await f.approveQr(); await expect.poll(() => f.cleanups.length).toBe(2);
  expect(f.cleanups.map(row => row.topic)).toEqual([oldTopic, f.pairings[0]!.topic]);
  await expect(page.locator(".wallet-network")).toHaveCount(0); await expect(page.locator("#connection-status")).toContainText("Connected ·");
  await f.openQr(1); await f.approveQr(1); await expect(page.locator(".wallet-dialog")).not.toBeVisible();
  await expect(page.locator("#wallet-login-status")).toHaveText("Signed in. Payments are confirmed separately in your wallet.");
  expect(f.requests.filter(row => /\/(challenge|verify|logout)$/.test(row.path))).toEqual([]); expect(f.walletCalls).toEqual([]);
  await f.assertNoReloadOrPayment();
});

for (const changedWallet of [false, true]) test(`QR reconnect ${changedWallet ? "clears a different wallet's" : "preserves the same wallet's"} workspace and payment recovery`, async ({ page }) => {
  const f = await reconnectFixture(page, { resume: true, rejectPayment: true });
  await expect(page.locator("#connection-status")).toContainText("Connected ·");
  await page.locator("#prompt").fill("Retain this encrypted request until I choose what to do");
  await page.locator("#run-inference").click(); await expect(page.locator("#payment-dialog")).toBeVisible();
  await page.locator("#confirm-payment").click(); await expect(page.locator("#inference-recovery")).toBeVisible();
  await expect(page.locator("#recovery-payment")).toContainText(paymentId); await expect(page.locator("#retry-inference")).toBeDisabled();
  await f.openQr(); await f.approveQr(0, changedWallet ? other.address : signer.address); await expect(page.locator(".wallet-dialog")).not.toBeVisible();
  if (changedWallet) {
    await expect(page.locator("#connection-status")).toHaveText("Disconnected"); await expect(page.locator("#inference-recovery")).not.toBeVisible();
    await expect.poll(() => f.requests.filter(row => row.path.endsWith("/logout")).length).toBe(1);
    await expect(page.locator("#run-inference")).toBeDisabled();
  } else {
    await expect(page.locator("#connection-status")).toContainText("Connected ·"); await expect(page.locator("#inference-recovery")).toBeVisible();
    await expect(page.locator("#recovery-payment")).toContainText(paymentId); await expect(page.locator("#retry-inference")).toBeEnabled();
    expect(f.requests.filter(row => row.path.endsWith("/logout"))).toEqual([]);
  }
  expect(f.requests.filter(row => /\/(challenge|verify)$/.test(row.path))).toEqual([]);
  expect(f.requests.filter(row => row.path === "/v1/inference")).toHaveLength(1); expect(f.walletCalls.map(row => row.method)).toEqual(["eth_signTypedData_v4"]);
  await f.assertNoReloadOrPayment();
});
