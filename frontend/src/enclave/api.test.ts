import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import arc from "./arc-mainnet.json";
import { receiveData, type ArcPaymentIntent } from "./arc-payment";
import {
  ApiError, EnclaveClient, RECEIPT_TYPES, canSettleLocally, decryptAesGcm, encryptAesGcm,
  importSessionKey, sha256Hex, type EncryptedBlob, type Health, type Receipt, type WorkspaceReceipt,
} from "./api";

const h = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const wrongAccount = privateKeyToAccount(`0x${"22".repeat(32)}`);
const SESSION = "10000000-0000-4000-8000-000000000001";
const PAYMENT = "10000000-0000-4000-8000-000000000002";
const AGENT = "10000000-0000-4000-8000-000000000003";
const health: Health = {
  ok: true, service: "enclave-gateway", teeMode: "dev", inferenceBackend: "echo", chainId: 31337,
  paymentMode: "mock", servingModel: { id: "echo-v1", name: "echo-v1", modelHash: h("a"), codeHash: h("b") },
  receiptSigner: account.address, verifierAddress: `0x${"12".repeat(20)}`, agentRuntimeEnabled: false, inferencePriceUsdc: 0.001,
};
const sessionKey = randomBytes(32);
const quote = () => ({ cpuQuote: "software-cpu", gpuQuote: "software-gpu", measurement: health.servingModel.codeHash, tcbVersion: 1, timestamp: Date.now(), signature: `0x${"ab".repeat(65)}` });
const challenge = () => ({ x402Version: 1, accepts: [{ scheme: "exact", network: "arc-31337", maxAmountRequired: "1000", payTo: `0x${"33".repeat(20)}`, asset: `0x${"44".repeat(20)}`, extra: { receiptPending: true, paymentId: PAYMENT } }] });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
function encryptNode(input: Uint8Array): EncryptedBlob {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", sessionKey, iv);
  return { iv: iv.toString("base64"), ciphertext: Buffer.concat([cipher.update(input), cipher.final()]).toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
function decryptNode(blob: EncryptedBlob): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", sessionKey, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, "base64")), decipher.final()]);
}
async function signedResponse(body: string, options: { signer?: typeof account; chainId?: number; verifier?: Hex; output?: Uint8Array; receiptPatch?: Partial<Receipt> } = {}) {
  const request = JSON.parse(body) as EncryptedBlob & { agentId?: string };
  const plaintext = decryptNode(request); const input = request.agentId ? Buffer.concat([Buffer.from("\n"), plaintext]) : plaintext;
  const output = options.output ?? new TextEncoder().encode("Verified answer ✓");
  const receipt = {
    receiptVersion: 2 as const, nonce: h("c"), modelHash: health.servingModel.modelHash, codeHash: health.servingModel.codeHash,
    inHash: await sha256Hex(input), outHash: await sha256Hex(output), attRef: await sha256Hex(quote().signature), ts: "1800000000", ...options.receiptPatch,
  };
  const typed = { domain: { name: "ENCLAVE", version: "2", chainId: options.chainId ?? health.chainId, verifyingContract: options.verifier ?? health.verifierAddress }, types: RECEIPT_TYPES, primaryType: "InferenceReceipt" as const, message: { ...receipt, ts: BigInt(receipt.ts) } };
  const sig = await (options.signer ?? account).signTypedData(typed);
  return { receipt: { ...receipt, sig }, typedHash: hashTypedData(typed), outputHash: receipt.outHash, output: encryptNode(output) };
}
function scenario(options: { health?: Partial<Health>; challenge?: unknown; response?: (body: string) => Promise<unknown>; failPaid?: boolean; failSettle?: boolean; memoryHash?: Hex } = {}) {
  let paidAttempts = 0; let settlementCount = 0;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url); const headers = new Headers(init?.headers);
    if (path.endsWith("/health")) return json({ ...health, ...options.health });
    if (path.endsWith(`/v1/agents/${AGENT}`)) return json({ id: AGENT, name: "Bot", policyHash: h("a"), memoryHash: options.memoryHash ?? await sha256Hex(new Uint8Array()), createdAt: new Date().toISOString() });
    if (path.endsWith("/v1/attestation/quote")) return json(quote());
    if (path.endsWith("/v1/session")) return json({ sessionId: SESSION, expiresAt: new Date(Date.now() + 60_000).toISOString(), wrapKey: sessionKey.toString("base64") });
    if (path.endsWith("/v1/x402/settle")) {
      settlementCount++;
      if (options.failSettle) throw new Error("private provider failure");
      return json({ paymentId: PAYMENT, tx: h("d"), confidential: false });
    }
    if (path.endsWith("/v1/inference")) {
      if (!headers.has("x-payment")) return json({ title: "PAYMENT_REQUIRED", details: options.challenge ?? challenge() }, 402);
      paidAttempts++;
      if (options.failPaid) throw new Error("private provider failure");
      return json(await (options.response ?? signedResponse)(String(init?.body)));
    }
    throw new Error("Unexpected route");
  });
  const client = new EnclaveClient({ apiKey: "in-memory-test-key", fetch: fetcher });
  return { client, fetcher, counts: () => ({ paidAttempts, settlementCount }) };
}
afterEach(() => vi.useRealTimers());

describe("explicit Arc wallet settlement", () => {
  const policy = { meter: `0x${"33".repeat(20)}`, verifier: health.verifierAddress, receiptSigner: account.address, maxAmountUnits: "1000" };
  function arcScenario(extra: { failSettle?: boolean; failPaid?: boolean } = {}) {
    const options = { ...extra, health: { chainId: arc.chainId, paymentMode: "authorized" as const, settlementToken: arc.usdc.address as Hex },
      challenge: { ...challenge(), accepts: [{ ...challenge().accepts[0]!, network: "arc-5042", asset: arc.usdc.address }] },
      response: (body: string) => signedResponse(body, { chainId: arc.chainId }) };
    const wallet = { account: { address: account.address, chainId: arc.chainId }, authorizeArc: vi.fn(async (intent: ArcPaymentIntent) => ({
      from: account.address, validAfter: "0", validBefore: intent.validBefore, signature: await account.signTypedData(receiveData(intent)),
    })) };
    return { ...scenario(options), wallet, options };
  }
  it("does not sign during preparation and validates the resulting paid receipt on Arc", async () => {
    const { client, wallet, counts } = arcScenario();
    const prepared = await client.prepareInference("private request");
    expect(wallet.authorizeArc).not.toHaveBeenCalled();
    expect((await client.settleArcAndRun(prepared, wallet, policy)).outputText).toBe("Verified answer ✓");
    expect(wallet.authorizeArc).toHaveBeenCalledTimes(1);
    expect(counts()).toEqual({ paidAttempts: 1, settlementCount: 1 });
    await client.settleArcAndRun(prepared, wallet, policy);
    expect(counts()).toEqual({ paidAttempts: 1, settlementCount: 1 });
  });
  it("reuses byte-identical authorization after an uncertain settlement response", async () => {
    const { client, wallet, options, fetcher } = arcScenario({ failSettle: true });
    const prepared = await client.prepareInference("private request");
    await expect(client.settleArcAndRun(prepared, wallet, policy)).rejects.toThrow();
    options.failSettle = false;
    await client.settleArcAndRun(prepared, wallet, policy);
    const submitted = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/v1/x402/settle")).map(([, init]) => init?.body);
    expect(submitted).toHaveLength(2); expect(submitted[0]).toBe(submitted[1]);
    expect(wallet.authorizeArc).toHaveBeenCalledTimes(1);
  });
  it("never resettles after inference fails following confirmed settlement", async () => {
    const { client, wallet, options, counts } = arcScenario({ failPaid: true });
    const prepared = await client.prepareInference("private request");
    await expect(client.settleArcAndRun(prepared, wallet, policy)).rejects.toThrow();
    options.failPaid = false;
    await client.settleArcAndRun(prepared, wallet, policy);
    expect(wallet.authorizeArc).toHaveBeenCalledTimes(1);
    expect(counts()).toEqual({ settlementCount: 1, paidAttempts: 2 });
  });
  it.each([{ meter: `0x${"88".repeat(20)}` }, { maxAmountUnits: "999" }, { receiptSigner: wrongAccount.address }, { verifier: wrongAccount.address }])("rejects mismatched deployment pins or overspending before a wallet prompt: %s", async patch => {
    const { client, wallet, counts } = arcScenario();
    await expect(client.settleArcAndRun(await client.prepareInference("hello"), wallet, { ...policy, ...patch })).rejects.toMatchObject({ code: "ARC_PAYMENT_POLICY" });
    expect(wallet.authorizeArc).not.toHaveBeenCalled(); expect(counts().settlementCount).toBe(0);
  });
  it("rejects a wallet change while approval is pending before submission", async () => {
    const { client, wallet, counts } = arcScenario();
    const sign = wallet.authorizeArc.getMockImplementation()!;
    wallet.authorizeArc.mockImplementation(async intent => { const auth = await sign(intent); wallet.account.address = wrongAccount.address; return auth; });
    await expect(client.settleArcAndRun(await client.prepareInference("hello"), wallet, policy)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(counts().settlementCount).toBe(0);
  });
  it("discards late approval after workspace disconnect", async () => {
    const { client, wallet, counts } = arcScenario();
    const sign = wallet.authorizeArc.getMockImplementation()!;
    wallet.authorizeArc.mockImplementation(async intent => { const auth = await sign(intent); client.disconnect(); return auth; });
    await expect(client.settleArcAndRun(await client.prepareInference("hello"), wallet, policy)).rejects.toMatchObject({ name: "AbortError" });
    expect(counts().settlementCount).toBe(0);
  });
  it("user rejection never submits a payment", async () => {
    const { client, wallet, counts } = arcScenario();
    wallet.authorizeArc.mockRejectedValue({ code: 4001 });
    await expect(client.settleArcAndRun(await client.prepareInference("hello"), wallet, policy)).rejects.toMatchObject({ code: 4001 });
    expect(counts().settlementCount).toBe(0);
  });
});

describe("browser AES-GCM interoperability", () => {
  it("creates non-extractable AES keys and decrypts Node backend outputs", async () => {
    const key = await importSessionKey(sessionKey.toString("base64"));
    expect(key.extractable).toBe(false);
    expect(new TextDecoder().decode(await decryptAesGcm(key, encryptNode(Buffer.from("Привет 🌐"))))).toBe("Привет 🌐");
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });
  it("backend decrypts browser requests and each encryption gets a fresh IV", async () => {
    const key = await importSessionKey(sessionKey.toString("base64")); const input = new TextEncoder().encode("private prompt");
    const first = await encryptAesGcm(key, input); const second = await encryptAesGcm(key, input);
    expect(decryptNode(first).toString()).toBe("private prompt"); expect(first.iv).not.toBe(second.iv);
  });
  it.each(["", "!!!", "YQ==", "YWJjZA=", `${sessionKey.toString("base64")}\n`])("rejects malformed/short keys (%s)", async (key) => {
    await expect(importSessionKey(key)).rejects.toBeInstanceOf(ApiError);
  });
  it.each(["iv", "tag", "ciphertext"] as const)("authenticates %s tampering", async (field) => {
    const key = await importSessionKey(sessionKey.toString("base64")); const blob = encryptNode(Buffer.from("answer"));
    const changed = Buffer.from(blob[field], "base64"); changed[0] = changed[0]! ^ 1; blob[field] = changed.toString("base64");
    await expect(decryptAesGcm(key, blob)).rejects.toBeInstanceOf(ApiError);
  });
  it("rejects oversized input and validates SHA-256 over exact UTF-8 bytes", async () => {
    const key = await importSessionKey(sessionKey.toString("base64"));
    await expect(encryptAesGcm(key, new Uint8Array(1_048_577))).rejects.toMatchObject({ code: "INPUT_TOO_LARGE" });
    expect(await sha256Hex("abc")).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("explicit local payment and receipt verification", () => {
  it("pauses at 402, then settles once and repeats the exact ciphertext/idempotency key", async () => {
    const { client, fetcher, counts } = scenario(); const steps: string[] = [];
    const pending = await client.prepareInference("Exact private prompt", { agentId: AGENT, onStep: (step) => steps.push(step) });
    expect(pending.challenge?.accepts[0]?.extra.paymentId).toBe(PAYMENT);
    expect(counts()).toEqual({ paidAttempts: 0, settlementCount: 0 });
    expect(JSON.stringify(pending)).not.toContain("Exact private prompt");
    expect(JSON.stringify(pending)).not.toContain(sessionKey.toString("base64"));
    const result = await client.settleLocalAndRun(pending, { onStep: (step) => steps.push(step) });
    expect(result.outputText).toBe("Verified answer ✓"); expect(result.verification.hardwareAttestationVerified).toBe(false);
    expect(counts()).toEqual({ paidAttempts: 1, settlementCount: 1 });
    const posts = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/v1/inference"));
    expect(posts).toHaveLength(2); expect(posts[0]![1]!.body).toBe(posts[1]![1]!.body);
    expect(new Headers(posts[0]![1]!.headers).get("idempotency-key")).toBe(new Headers(posts[1]![1]!.headers).get("idempotency-key"));
    expect(new Headers(posts[1]![1]!.headers).get("x-payment")).toBe(PAYMENT);
    expect(JSON.parse(String(posts[0]![1]!.body))).toMatchObject({ agentId: AGENT });
    expect(steps).toEqual(["connecting", "attesting", "encrypting", "payment-required", "settling", "inferencing", "verifying", "complete"]);
    expect(await client.settleLocalAndRun(pending)).toBe(result); expect(counts().paidAttempts).toBe(1);
  });
  it.each([{ paymentMode: "authorized" as const }, { chainId: 1 }, { teeMode: "hardware" }])("never settles outside explicitly local mock mode %j", async (change) => {
    const ch = challenge(); ch.accepts[0]!.network = `arc-${change.chainId ?? 31337}`;
    const { client, counts } = scenario({ health: change, challenge: ch }); const prepared = await client.prepareInference("hello");
    await expect(client.settleLocalAndRun(prepared)).rejects.toMatchObject({ code: "LOCAL_SETTLEMENT_ONLY" });
    expect(counts()).toEqual({ paidAttempts: 0, settlementCount: 0 });
  });
  it("rechecks payment mode after preparation and ignores mutated public snapshots", async () => {
    const current: Partial<Health> = {}; const { client, counts } = scenario({ health: current });
    const pending = await client.prepareInference("hello"); pending.health.paymentMode = "authorized";
    current.paymentMode = "authorized";
    await expect(client.settleLocalAndRun(pending)).rejects.toMatchObject({ code: "LOCAL_SETTLEMENT_ONLY" }); expect(counts().settlementCount).toBe(0);
  });
  it.each(["network", "price", "payment-id", "multiple"])("rejects an invalid %s payment challenge before settling", async (field) => {
    const ch = challenge();
    if (field === "network") ch.accepts[0]!.network = "arc-1";
    if (field === "price") ch.accepts[0]!.maxAmountRequired = "999999";
    if (field === "payment-id") ch.accepts[0]!.extra.paymentId = "not-a-uuid";
    if (field === "multiple") ch.accepts.push(ch.accepts[0]!);
    const { client, counts } = scenario({ challenge: ch });
    await expect(client.prepareInference("hello")).rejects.toMatchObject({ code: "INVALID_RESPONSE" }); expect(counts().settlementCount).toBe(0);
  });
  it("does not automatically retry a failed paid inference; manual continuation reuses settled payment", async () => {
    const opts = { failPaid: true }; const { client, counts } = scenario(opts); const prepared = await client.prepareInference("hello");
    await expect(client.settleLocalAndRun(prepared)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(counts()).toEqual({ paidAttempts: 1, settlementCount: 1 });
    opts.failPaid = false; await client.settleLocalAndRun(prepared);
    expect(counts()).toEqual({ paidAttempts: 2, settlementCount: 1 });
  });
  it("a failed settlement never proceeds to inference", async () => {
    const { client, counts } = scenario({ failSettle: true }); const prepared = await client.prepareInference("hello");
    await expect(client.settleLocalAndRun(prepared)).rejects.toMatchObject({ code: "NETWORK_ERROR" }); expect(counts().paidAttempts).toBe(0);
  });
  it("refuses agents with unknown sealed plaintext before opening or settling a payment", async () => {
    const { client, fetcher, counts } = scenario({ memoryHash: h("e") });
    await expect(client.prepareInference("hello", { agentId: AGENT })).rejects.toMatchObject({ code: "AGENT_MEMORY_UNAVAILABLE" });
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/v1/inference"))).toBe(false);
    expect(counts().settlementCount).toBe(0);
  });
  it("does not pay after the prepared session expires", async () => {
    const { client, counts } = scenario(); const prepared = await client.prepareInference("hello");
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 61_000);
    await expect(client.settleLocalAndRun(prepared)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(counts()).toEqual({ paidAttempts: 0, settlementCount: 0 });
  });
  it("rejects concurrent execution of one prepared request", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const { client, counts } = scenario({ response: async (body) => { await gate; return signedResponse(body); } });
    const prepared = await client.prepareInference("hello"); const first = client.settleLocalAndRun(prepared);
    await expect(client.settleLocalAndRun(prepared)).rejects.toMatchObject({ code: "REQUEST_BUSY" });
    release(); await first; expect(counts()).toEqual({ paidAttempts: 1, settlementCount: 1 });
  });
  it("rejects a prepared request passed to another client", async () => {
    const first = scenario(); const second = scenario(); const prepared = await first.client.prepareInference("hello");
    await expect(second.client.settleLocalAndRun(prepared)).rejects.toMatchObject({ code: "UNKNOWN_REQUEST" });
    expect(second.fetcher).not.toHaveBeenCalled();
  });
  it.each(["modelHash", "codeHash", "inHash", "outHash", "attRef"] as const)("rejects even correctly signed mismatched %s", async (field) => {
    const { client } = scenario({ response: (body) => signedResponse(body, { receiptPatch: { [field]: h("e") } }) });
    await expect(client.settleLocalAndRun(await client.prepareInference("hello"))).rejects.toMatchObject({ code: "RECEIPT_VERIFICATION_FAILED" });
  });
  it.each(["signer", "chain", "contract", "typedHash", "outputHash", "nonce", "signature"])("rejects %s tampering", async (field) => {
    const { client } = scenario({ response: async (body) => {
      const result = await signedResponse(body, { ...(field === "signer" ? { signer: wrongAccount } : {}), ...(field === "chain" ? { chainId: 1 } : {}), ...(field === "contract" ? { verifier: `0x${"99".repeat(20)}` as Hex } : {}) });
      if (field === "typedHash") result.typedHash = h("e");
      if (field === "outputHash") result.outputHash = h("e");
      if (field === "nonce") result.receipt.nonce = h("e");
      if (field === "signature") result.receipt.sig = `0x${"00".repeat(65)}`;
      return result;
    } });
    await expect(client.settleLocalAndRun(await client.prepareInference("hello"))).rejects.toMatchObject({ code: "RECEIPT_VERIFICATION_FAILED" });
  });
  it("retains binary echo bytes without pretending they are UTF-8 text", async () => {
    const { client } = scenario({ response: (body) => signedResponse(body, { output: Uint8Array.from([0xff, 0xfe]) }) });
    const result = await client.settleLocalAndRun(await client.prepareInference("hello")); expect(result.outputText).toBeNull(); expect([...result.outputBytes]).toEqual([255, 254]);
  });
  it("drops credentials and request handles on disconnect", async () => {
    const { client, fetcher } = scenario(); const pending = await client.prepareInference("hello"); client.disconnect(); const calls = fetcher.mock.calls.length;
    await expect(client.workspace()).rejects.toMatchObject({ code: "API_KEY_REQUIRED" });
    await expect(client.settleLocalAndRun(pending)).rejects.toMatchObject({ code: "UNKNOWN_REQUEST" }); expect(fetcher).toHaveBeenCalledTimes(calls);
  });
});

describe("bounded transport and private owner reads", () => {
  it.each(["http://example.com", "https://user:password@example.com", "https://example.com/?key=secret", "//attacker.test", "file:///tmp/gateway"])("rejects unsafe base URL %s", (baseUrl) => {
    expect(() => new EnclaveClient({ baseUrl })).toThrow(ApiError);
  });
  it("uses one fixed origin, no redirects/cookies/referrer, and keeps the key out of URLs", async () => {
    const fetcher = vi.fn(async () => json(health)); const client = new EnclaveClient({ apiKey: "private-test-key", baseUrl: "https://gateway.example/api", fetch: fetcher });
    await client.health(); const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://gateway.example/api/health"); expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(new Headers(init.headers).has("x-api-key")).toBe(false); expect(JSON.stringify(client)).not.toContain("private-test-key");
  });
  it("passes owner cursors unchanged, strips sealed agent fields and never stores data", async () => {
    const fetcher = vi.fn(async () => json({ usage: { calls: 0, usdcUnits: "0" }, receipts: [], payments: [], agents: [{ id: AGENT, name: "Bot", policyHash: h("a"), memoryHash: h("b"), createdAt: new Date().toISOString(), sealedMemory: { secret: "hidden" }, ownerKeyHash: h("c"), dailyLimitUnits: "1000", spentTodayUnits: "0", lane: "local", allowedModels: [] }], page: { limit: 10, receiptsNext: null, paymentsNext: null, agentsNext: null } }));
    const client = new EnclaveClient({ apiKey: "private-test-key", fetch: fetcher }); const result = await client.workspace({ limit: 10, receiptsBefore: PAYMENT });
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain(`receiptsBefore=${PAYMENT}`); expect(new Headers(init.headers).get("x-api-key")).toBe("private-test-key");
    expect(result.agents[0]).not.toHaveProperty("sealedMemory"); expect(result.agents[0]).not.toHaveProperty("ownerKeyHash"); expect(result.agents[0]?.dailyLimitUnits).toBe("1000");
  });
  it("sanitizes network exceptions and server error details while preserving status/code", async () => {
    const key = "private-test-key";
    const client = new EnclaveClient({ apiKey: key, fetch: vi.fn(async () => json({ title: "FORBIDDEN", detail: key, details: { nested: key, apiKey: "another-secret" } }, 403)) });
    await expect(client.listAgents()).rejects.toMatchObject({ status: 403, code: "FORBIDDEN", details: { nested: "[redacted]", apiKey: "[redacted]" } });
    const network = new EnclaveClient({ apiKey: key, fetch: vi.fn(async () => { throw new Error(key); }) });
    await expect(network.listAgents()).rejects.toMatchObject({ message: "Cannot reach the gateway; no automatic retry was made" });
  });
  it("cancels without retrying or opening a request when already aborted", async () => {
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn(); const client = new EnclaveClient({ fetch: fetcher });
    await expect(client.health({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" }); expect(fetcher).not.toHaveBeenCalled();
  });
  it("enforces a timeout without retrying", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const client = new EnclaveClient({ fetch: fetcher, timeoutMs: 10 }); const result = client.health().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(11); expect(await result).toMatchObject({ code: "TIMEOUT" }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["redirect", "invalid-json", "oversized"])("rejects %s responses", async (kind) => {
    const response = kind === "redirect" ? new Response(null, { status: 302, headers: { location: "https://attacker.test" } }) : kind === "invalid-json" ? new Response("<html>bad</html>") : new Response("{}", { headers: { "content-length": "99999999" } });
    const client = new EnclaveClient({ fetch: vi.fn(async () => response) }); await expect(client.health()).rejects.toBeInstanceOf(ApiError);
  });
  it("issues a view key only on explicit invocation and sends export credentials only in its header", async () => {
    const secret = `enclave_vk_${"ab".repeat(16)}`;
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/view-keys") ? json({ id: AGENT, label: "Auditor", secret }) : json({ auditor: { id: AGENT, label: "Auditor" }, receipts: [], payments: [], usage: { calls: 0, usdcUnits: "0" } }));
    const client = new EnclaveClient({ apiKey: "private-test-key", fetch: fetcher }); expect(fetcher).not.toHaveBeenCalled();
    expect((await client.issueViewKey("Auditor")).secret).toBe(secret); await client.exportWithViewKey(secret);
    const [url, init] = fetcher.mock.calls[1]! as unknown as [string, RequestInit];
    expect(url).not.toContain(secret); expect(new Headers(init.headers).get("x-view-key")).toBe(secret); expect(new Headers(init.headers).has("x-api-key")).toBe(false);
  });
  it("verifies persisted receipts without claiming plaintext or hardware verification", async () => {
    const { client, fetcher } = scenario(); const pending = await client.prepareInference("hello"); const result = await client.settleLocalAndRun(pending);
    const record: WorkspaceReceipt = { ...result.receipt, id: AGENT, typedHash: result.typedHash, chainId: 31337, verifierAddress: health.verifierAddress, status: "signed", anchoredTx: null, agentId: null, createdAt: new Date().toISOString() };
    expect(await client.verifyReceipt(record)).toEqual({ signature: true, typedHash: true, ioHashesVerified: false, hardwareAttestationVerified: false });
    await expect(client.verifyReceipt({ ...record, chainId: 1 })).rejects.toMatchObject({ code: "RECEIPT_VERIFICATION_FAILED" });
    await expect(client.verifyReceipt({ ...record, typedHash: h("f") })).rejects.toMatchObject({ code: "RECEIPT_VERIFICATION_FAILED" });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/v1/x402/settle"))).toHaveLength(1);
  });
  it("local readiness requires all three safety conditions", () => {
    expect(canSettleLocally(health)).toBe(true); expect(canSettleLocally({ ...health, paymentMode: "authorized" })).toBe(false);
  });
  it("verifies historical v1 receipt domains explicitly and rejects missing persisted domain", async () => {
    const fields = RECEIPT_TYPES.InferenceReceipt.filter((field) => field.name !== "nonce");
    const receipt = { modelHash: h("a"), codeHash: h("b"), inHash: h("c"), outHash: h("d"), attRef: h("e"), ts: 100n };
    const typed = { domain: { name: "ENCLAVE", version: "1", chainId: health.chainId, verifyingContract: health.verifierAddress }, types: { InferenceReceipt: fields }, primaryType: "InferenceReceipt" as const, message: receipt };
    const record: WorkspaceReceipt = { ...receipt, id: AGENT, receiptVersion: 1, nonce: null, ts: "100", sig: await account.signTypedData(typed), typedHash: hashTypedData(typed), chainId: health.chainId, verifierAddress: health.verifierAddress, status: "signed", agentId: null, anchoredTx: null, createdAt: new Date().toISOString() };
    const client = new EnclaveClient({ fetch: vi.fn(async () => json(health)) });
    expect((await client.verifyReceipt(record)).signature).toBe(true);
    await expect(client.verifyReceipt({ ...record, chainId: null, verifierAddress: null })).rejects.toMatchObject({ code: "RECEIPT_VERIFICATION_FAILED" });
  });
  it("reads actual software policy shape without a hardware claim", async () => {
    const policy = { version: 1, servingImageId: "dev-image", measurement: h("a"), policyHash: h("b"), status: "active", binding: "legacy", scope: null, activatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), trustMode: "development-software" };
    const client = new EnclaveClient({ fetch: vi.fn(async () => json({ active: policy, history: [policy] })) });
    expect((await client.policies()).active.servingImageId).toBe("dev-image");
  });
});
