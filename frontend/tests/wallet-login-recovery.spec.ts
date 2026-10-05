import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { hexToString, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

// Unfunded, synthetic signatures remain in Node. Every API request is intercepted.
// No WalletConnect relay, gateway, inference, transaction or real wallet is used.
const account = privateKeyToAccount(`0x${"23".repeat(32)}`);
const hash = (text: string): Hex => `0x${createHash("sha256").update(text).digest("hex")}`;
const address = `0x${"12".repeat(20)}`;

async function loginFixture(page: Page) {
  const requests: { path: string; body: Record<string, unknown> | null; token?: string }[] = [];
  const walletCalls: string[] = [];
  const challenges = new Map<string, string>();
  const pending: { message: string; resolve: (signature: Hex) => void; reject: (error: unknown) => void }[] = [];
  let challengeNumber = 0, verifiedToken: string | null = null;
  await page.clock.install();
  await page.exposeBinding("loginRecoveryWalletRequest", async (_source, args: { method: string; params?: unknown[] }) => {
    walletCalls.push(args.method);
    if (["eth_requestAccounts", "eth_accounts"].includes(args.method)) return [account.address];
    if (args.method === "eth_chainId") return "0x13b2";
    if (args.method === "personal_sign") {
      expect(args.params?.[1]).toBe(account.address);
      const message = hexToString(String(args.params?.[0]) as Hex);
      expect(challenges.has(message)).toBe(true);
      expect(args.params?.[0]).toBe(stringToHex(message));
      return new Promise<Hex>((resolve, reject) => pending.push({ message, resolve, reject }));
    }
    throw Error("Unexpected synthetic wallet operation");
  });
  await page.addInitScript(() => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const provider = {
      request: (args: { method: string; params?: unknown[] }) => Reflect.get(window, "loginRecoveryWalletRequest")(args),
      on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); },
      removeListener: (event: string) => { listeners.delete(event); },
    };
    const detail = { info: { uuid: "a139eb1f-44df-456a-ad70-197939cf0806", name: "Login recovery fixture", rdns: "test.login-recovery", icon: "data:image/svg+xml,<svg/>" }, provider };
    window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail })));
    Reflect.set(window, "dropLoginRecoveryWallet", () => listeners.get("disconnect")?.({ code: 4900 }));
  });
  const health = { ok: true, service: "synthetic-login-fixture", teeMode: "managed-near", inferenceBackend: "near-verified",
    inferenceRoute: "near-direct-experimental", chainId: 5042, paymentMode: "authorized", settlementToken: "0x3600000000000000000000000000000000000000",
    servingModel: { id: "fixture", name: "Login fixture", modelHash: hash("model"), codeHash: hash("code") },
    receiptSigner: account.address, verifierAddress: address, agentRuntimeEnabled: false, inferencePriceUsdc: 0.1,
    deployment: { stage: "pilot", productionReady: false, gatewayKeyCustody: "software", inferenceTrust: "near-cpu-gpu", releaseProfile: "near-arc" },
    providerPolicy: { sha256: hash("policy"), expiresAt: "2030-01-01T00:00:00.000Z" } };
  const policy = { version: 2, servingImageId: "login-fixture", measurement: hash("code"), policyHash: hash("policy"), status: "active",
    binding: "registry", scope: null, trustMode: "development-software", activatedAt: null, createdAt: "2026-10-04T00:00:00.000Z" };
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return url.origin === "http://127.0.0.1:5173" ? route.continue() : route.abort();
    const path = url.pathname.slice(4), body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    requests.push({ path, body, token: request.headers()["x-api-key"] });
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === "/v1/auth/wallet/config") return reply({ enabled: true, origin: url.origin, chainId: 5042 });
    if (path === "/v1/auth/wallet/resume") return reply({}, 401);
    if (path === "/v1/auth/wallet/logout") return reply({ ok: true });
    if (path === "/v1/auth/wallet/challenge") {
      expect(body).toEqual({ address: account.address });
      const now = await page.evaluate(() => Date.now()), id = (++challengeNumber).toString(16).padStart(48, "0");
      const message = createSiweMessage({ domain: url.host, address: account.address, uri: `${url.origin}/dashboard`, chainId: 5042,
        version: "1", nonce: id, issuedAt: new Date(now), expirationTime: new Date(now + 300_000),
        statement: "Sign in to Enclave. This does not authorize a payment." });
      challenges.set(message, id);
      return reply({ id, message });
    }
    if (path === "/v1/auth/wallet/verify") {
      const entry = [...challenges].find(([, id]) => id === body?.id);
      expect(entry).toBeDefined();
      expect(body?.signature).toBe(await account.signMessage({ message: entry![0] }));
      verifiedToken = `enws_${String(body!.id).padStart(64, "0")}`;
      const now = await page.evaluate(() => Date.now());
      return reply({ token: verifiedToken, address: account.address, expiresAt: new Date(now + 1_800_000).toISOString() });
    }
    if (path === "/health") return reply(health);
    if (path === "/v1/tcb/policies") return reply({ active: policy, history: [policy] });
    if (path === "/v1/models") return reply([]);
    if (path === "/v1/workspace") {
      expect(request.headers()["x-api-key"]).toBe(verifiedToken);
      return reply({ usage: { calls: 0, usdcUnits: "0" }, receipts: [], payments: [], agents: [], page: { limit: 50, receiptsNext: null, paymentsNext: null, agentsNext: null } });
    }
    // A sign-in test must never open an inference session or submit a payment.
    expect(["/v1/session", "/v1/inference", "/v1/x402/settle"]).not.toContain(path);
    return reply({ title: "UNEXPECTED_LOGIN_FIXTURE_REQUEST", status: 500 }, 500);
  });
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/view=inference/);
  await expect(page.locator("#wallet-login-panel")).toBeVisible();
  async function connect() {
    const count = requests.filter(request => request.path === "/v1/auth/wallet/resume").length;
    await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
    await page.getByRole("button", { name: "Login recovery fixture Browser extension", exact: true }).click();
    await expect(page.locator(".wallet-network")).toHaveText("Login recovery fixture · Arc Mainnet");
    // Automatic cookie resume must settle before an explicit sign-in starts.
    if (count === 0) await expect.poll(() => requests.filter(request => request.path === "/v1/auth/wallet/resume").length).toBeGreaterThan(count);
    await expect(page.locator("#wallet-login")).toBeEnabled();
  }
  async function beginSignature(index: number) {
    await page.locator("#wallet-login").click();
    await expect.poll(() => pending.length).toBe(index + 1);
    await expect(page.locator("#wallet-login")).toBeDisabled();
  }
  async function approve(index: number) { pending[index]!.resolve(await account.signMessage({ message: pending[index]!.message })); }
  function assertNoPayments() {
    expect(walletCalls.filter(method => /sign/i.test(method)).every(method => method === "personal_sign")).toBe(true);
    expect(requests.filter(request => ["/v1/session", "/v1/inference", "/v1/x402/settle"].includes(request.path))).toEqual([]);
  }
  return { requests, pending, connect, beginSignature, approve, assertNoPayments };
}

test("hung sign-in can disconnect and reconnect without a late signature reviving its login", async ({ page }) => {
  const f = await loginFixture(page); await f.connect(); await f.beginSignature(0);
  const disconnect = page.locator(".wallet-control").getByRole("button", { name: "Disconnect wallet", exact: true });
  await expect(disconnect).toBeEnabled(); await disconnect.click();
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeEnabled();
  await expect(page.locator("#wallet-login")).toBeEnabled();
  await expect(page.locator("#wallet-login-status")).toHaveText("Connect your wallet on Arc Mainnet, then sign in. Signing in is free.");
  await f.connect();
  await expect(page.locator("#wallet-login-status")).toHaveText("Wallet connected. Sign in to load your workspace. Signing in is free.");
  await expect(page.locator("#connection-error")).toBeEmpty();
  await f.beginSignature(1);
  // The old promise settles while the replacement attempt is still awaiting approval.
  await f.approve(0);
  await page.clock.runFor(25);
  expect(f.requests.filter(request => request.path === "/v1/auth/wallet/verify")).toHaveLength(0);
  await expect(page.locator("#wallet-login")).toBeDisabled();
  await f.approve(1);
  await expect(page.locator("#connection-status")).toContainText("Connected ·");
  const verified = f.requests.filter(request => request.path === "/v1/auth/wallet/verify");
  expect(verified).toHaveLength(1); expect(verified[0]!.body?.id).toBe("2".padStart(48, "0"));
  await expect(page.locator("#wallet-login")).toBeEnabled(); f.assertNoPayments();
});

test("timed-out sign-in allows a fresh attempt and ignores the original wallet reply", async ({ page }) => {
  const f = await loginFixture(page); await f.connect(); await f.beginSignature(0);
  // This is longer than the sign-in approval budget, and shorter than the SIWE expiry.
  await page.clock.fastForward(60_001);
  await expect(page.locator("#wallet-login")).toBeEnabled();
  await expect(page.locator("#connection-status")).not.toContainText("Connected ·");
  await expect(page.locator("#wallet-login-status")).toHaveText("Sign-in timed out. Reconnect your wallet on Arc Mainnet, then sign in again.");
  expect(f.requests.filter(request => request.path === "/v1/auth/wallet/verify")).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeEnabled();
  await f.connect();
  await expect(page.locator("#wallet-login-status")).toHaveText("Wallet connected. Sign in to load your workspace. Signing in is free.");
  await expect(page.locator("#connection-error")).toBeEmpty();
  await f.beginSignature(1); await f.approve(0); await page.clock.runFor(25);
  await expect(page.locator("#wallet-login")).toBeDisabled();
  expect(f.requests.filter(request => request.path === "/v1/auth/wallet/verify")).toHaveLength(0);
  await f.approve(1); await expect(page.locator("#connection-status")).toContainText("Connected ·");
  expect(f.requests.filter(request => request.path === "/v1/auth/wallet/verify")).toHaveLength(1); f.assertNoPayments();
});

test("an expired login in a long-open tab can cancel a hung new signature and sign in again", async ({ page }) => {
  const f = await loginFixture(page); await f.connect(); await f.beginSignature(0); await f.approve(0);
  await expect(page.locator("#connection-status")).toContainText("Connected ·");
  await page.clock.fastForward(1_800_001);
  await expect(page.locator("#connection-status")).toHaveText("Disconnected");
  await expect(page.locator("#wallet-login")).toBeEnabled();
  await expect(page.locator("#wallet-login-status")).toHaveText("Wallet connected. Sign in to load your workspace. Signing in is free.");
  await f.beginSignature(1);
  await page.locator(".wallet-control").getByRole("button", { name: "Disconnect wallet", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeEnabled();
  await f.connect(); await f.beginSignature(2); await f.approve(2);
  await expect(page.locator("#connection-status")).toContainText("Connected ·");
  await f.approve(1); await page.clock.runFor(25);
  const verified = f.requests.filter(request => request.path === "/v1/auth/wallet/verify");
  expect(verified.map(request => request.body?.id)).toEqual(["1".padStart(48, "0"), "3".padStart(48, "0")]);
  await expect(page.locator("#connection-status")).toContainText("Connected ·"); f.assertNoPayments();
});

test("disconnecting a wallet workspace resets signed-in copy without disconnecting its wallet", async ({ page }) => {
  const f = await loginFixture(page); await f.connect(); await f.beginSignature(0); await f.approve(0);
  await expect(page.locator("#connection-status")).toContainText("Connected ·");
  await expect(page.locator("#wallet-login-status")).toHaveText("Signed in. Payments are confirmed separately in your wallet.");
  await page.locator("#disconnect-gateway").click();
  await expect(page.locator("#connection-status")).toHaveText("Disconnected");
  await expect(page.locator(".wallet-network")).toHaveText("Login recovery fixture · Arc Mainnet");
  await expect(page.locator("#wallet-login-status")).toHaveText("Wallet connected. Sign in to load your workspace. Signing in is free.");
  await expect(page.locator("#connection-note")).toHaveText("Sign in with your wallet or use an API key to load your workspace.");
  await expect(page.locator("#wallet-login")).toBeEnabled();
  await f.beginSignature(1); await f.approve(1);
  await expect(page.locator("#connection-status")).toContainText("Connected ·");
  f.assertNoPayments();
});
