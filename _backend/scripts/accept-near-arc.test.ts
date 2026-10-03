import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverMessageAddress, recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptAesGcm, encryptAesGcm, receiptTypedHash, sha256Hex, signProviderProof, signReceipt, tcbPolicyRecord } from "@enclave/core";
import { productionInferenceArchiveSchema, type ProductionProviderPolicy } from "../packages/core/src/release-manifest.js";
import { ACCEPTANCE_PROMPT, acceptancePlanSchema, createAcceptanceStore, preparePrivateAcceptanceDirectory, runNearArcAcceptance,
  unlockStaleAcceptanceLock, verifyAcceptanceResult, type AcceptanceApi, type AcceptanceContext, type AcceptanceDependencies, type AcceptanceState } from "./accept-near-arc.js";

// All identities, policies, quotes and chain evidence here are synthetic; hardware and RPC are injected mocks.
const now = Date.parse("2026-10-01T12:00:00Z");
const address = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const sessionId = "00000000-0000-4000-8000-000000000001", paymentId = "00000000-0000-4000-8000-000000000002";
const receiveTypes = { ReceiveWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] } as const;
let directory: string;
let fixture: Awaited<ReturnType<typeof setup>>;
async function setup() {
  const payerKey = generatePrivateKey(), payer = privateKeyToAccount(payerKey), gatewayKey = generatePrivateKey(), gateway = privateKeyToAccount(gatewayKey), provider = privateKeyToAccount(generatePrivateKey());
  const model = "Synthetic/Acceptance", origin = "https://acceptance.example.test", providerOrigin = "https://synthetic.completions.near.ai";
  const software = tcbPolicyRecord({ version: 2, servingImageId: "synthetic-acceptance-v1", requireCpuTee: true, requireGpuCc: true });
  const measurements = Object.fromEntries(Object.entries({ tee_tcb_svn: 16, mr_seam: 48, mr_signer_seam: 48, seam_attributes: 8,
    td_attributes: 8, xfam: 8, mr_td: 48, mr_config_id: 48, mr_owner: 48, mr_owner_config: 48, rt_mr0: 48, rt_mr1: 48, rt_mr2: 48, rt_mr3: 48 })
    .map(([name, bytes]) => [name, "01".repeat(bytes)]));
  const policy: ProductionProviderPolicy = { schemaVersion: 1, version: "synthetic-policy-v1", validFrom: "2026-09-30T00:00:00Z", validUntil: "2026-10-05T00:00:00Z", maxSessionSeconds: 120,
    profiles: [{ model, measurements, appComposeSha256: "02".repeat(32), composeManagerActionsSha256: "03".repeat(32),
      composeManagerImage: `nearaidev/compose-manager@sha256:${"04".repeat(32)}`, gpuCount: 1, gpuModels: ["SYNTHETIC-GPU"] }],
    provenance: { status: "APPROVED", scope: "production", reviewedAt: "2026-10-01T09:00:00Z", reviewedBy: "synthetic-tests-only" } };
  const policyBytes = Buffer.from(JSON.stringify(policy));
  const plan = acceptancePlanSchema.parse({ schemaVersion: 1, providerOrigin, walletAuthOrigin: origin, expectedPriceUnits: "100000", maxOutputTokens: 32,
    confirmations: 12, usdcDomain: { name: "USDC", version: "2" }, acceptanceValidUntil: "2026-10-02T12:00:00Z",
    release: { schemaVersion: 1, chainId: 5042, origin, modelId: model, servingImageId: "synthetic-acceptance-v1", tcbVersion: 2,
      modelHash: sha256Hex(`model:${model}`), codeHash: software.measurement, policyHash: software.policyHash, signer: gateway.address,
      contracts: { ModelRegistry: address(256), AttestationVerifier: address(257), USDC: address(258), UsageMeter: address(259), FeeVault: address(260) },
      providerPolicy: { path: "reviewed-policy.json", sha256: sha256Hex(policyBytes), version: policy.version,
        reviewedAt: policy.provenance.reviewedAt, reviewedBy: policy.provenance.reviewedBy, scope: "production" } } });
  const context: AcceptanceContext = { plan, planHash: sha256Hex(JSON.stringify(plan)), policyBytes, apiBase: "https://acceptance.example.test/api", payerKey };
  const key = randomBytes(32), quoteSignature = await gateway.signMessage({ message: "synthetic software quote" }), attRef = sha256Hex(quoteSignature);
  const output = Buffer.from("READY");
  const requestBody = Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: ACCEPTANCE_PROMPT }], stream: false, max_tokens: 32 }));
  const responseBody = Buffer.from(JSON.stringify({ id: "synthetic-accepted-1", model, choices: [{ message: { content: output.toString() } }] }));
  const signatureText = `${model}:${sha256Hex(requestBody).slice(2)}:${sha256Hex(responseBody).slice(2)}`;
  const receipt = await signReceipt({ receiptVersion: 2, modelHash: plan.release.modelHash, codeHash: plan.release.codeHash, inHash: sha256Hex(ACCEPTANCE_PROMPT),
    outHash: sha256Hex(output), attRef, nonce: sha256Hex("synthetic invocation"), ts: BigInt(now / 1000 - 5) }, gatewayKey, 5042, plan.release.contracts.AttestationVerifier);
  const proof = await signProviderProof(receipt, { schemaVersion: 1, provider: "near", signatureKind: "provider_tee", endpoint: providerOrigin, model,
    completionId: "synthetic-accepted-1", requestHash: sha256Hex(requestBody), responseHash: sha256Hex(responseBody), outputHash: sha256Hex(output),
    signatureText, signature: await provider.signMessage({ message: signatureText }), signingAddress: provider.address,
    attestationRef: sha256Hex("synthetic hardware reference"), verifiedAt: new Date(now - 10_000).toISOString(), expiresAt: new Date(now + 110_000).toISOString(), tlsBound: true },
    gatewayKey, 5042, plan.release.contracts.AttestationVerifier);
  const attestationProof = JSON.stringify({ report: { model_name: model, signing_address: provider.address, intel_quote: "synthetic-quote-requires-hardware-replay", request_nonce: "11".repeat(32) },
    verdict: { ok: true, attestationRef: proof.evidence.attestationRef, policyVersion: policy.version, verifiedAt: proof.evidence.verifiedAt,
      expiresAt: proof.evidence.expiresAt, signingAddress: provider.address, tlsSpkiSha256: "12".repeat(32) }, policy, policyHash: sha256Hex(policyBytes) });
  const result = { receipt: { ...receipt, ts: receipt.ts.toString() }, typedHash: receiptTypedHash(receipt, 5042, plan.release.contracts.AttestationVerifier),
    outputHash: receipt.outHash, output: encryptAesGcm(key, output), providerEvidence: { proof,
      transcript: encryptAesGcm(key, Buffer.from(JSON.stringify({ requestBody: requestBody.toString("base64"), responseBody: responseBody.toString("base64"), attestationProof }))) } };
  const statePath = join(directory, "private", "state.json"), store = createAcceptanceStore(statePath);
  const health = { chainId: 5042, teeMode: "managed-near", inferenceBackend: "near-verified", paymentMode: "authorized", servingModel: { id: model, modelHash: plan.release.modelHash, codeHash: plan.release.codeHash },
    receiptSigner: gateway.address, verifierAddress: plan.release.contracts.AttestationVerifier, settlementToken: plan.release.contracts.USDC,
    inferencePriceUsdc: 0.1, limits: { maxOutputTokens: 32 } };
  const control = { paidFailure: false, consumed: false, anchorReady: true, challengeAmount: "100000", nonceOrigin: origin,
    legacyReceipts: true, walletEnabled: true, paymentPage: 0, badPersistedSignature: false, hardwareFailure: false, settlementFailure: false };
  const token = `enws_${"17".repeat(32)}`, challengeId = "21".repeat(24), settleTx = sha256Hex("synthetic settlement"), anchorTx = sha256Hex("synthetic anchor");
  const calls: Array<{ path: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const api: AcceptanceApi = async (path, method = "GET", body, headers = {}) => {
    calls.push({ path, method, body, headers });
    if (path === "/v1/auth/wallet/config") return { status: 200, data: { enabled: control.walletEnabled, origin, chainId: 5042, accountType: "EOA", sessionMinutes: 30 } };
    if (path === "/health") return { status: 200, data: health };
    if (path === "/v1/tcb/policies") return { status: 200, data: { active: { binding: "onchain", status: "active", version: 2,
      servingImageId: plan.release.servingImageId, measurement: plan.release.codeHash, policyHash: plan.release.policyHash } } };
    if (path === "/v1/auth/wallet/challenge") {
      expect(body).toEqual({ address: payer.address }); expect(headers.origin).toBe(origin);
      const message = createSiweMessage({ domain: new URL(control.nonceOrigin).host, uri: `${control.nonceOrigin}/dashboard`, address: payer.address,
        version: "1", chainId: 5042, nonce: challengeId, issuedAt: new Date(now - 1000), expirationTime: new Date(now + 299_000),
        statement: "Sign in to Enclave. This does not authorize a payment." });
      return { status: 200, data: { id: challengeId, message, expiresAt: new Date(now + 299_000).toISOString() } };
    }
    if (path === "/v1/auth/wallet/verify") {
      expect(headers.origin).toBe(origin);
      const sent = body as { id: string; signature: Hex }, previous = calls.find(call => call.path === "/v1/auth/wallet/challenge"); expect(previous).toBeDefined();
      const message = createSiweMessage({ domain: new URL(origin).host, uri: `${origin}/dashboard`, address: payer.address, version: "1", chainId: 5042, nonce: challengeId,
        issuedAt: new Date(now - 1000), expirationTime: new Date(now + 299_000), statement: "Sign in to Enclave. This does not authorize a payment." });
      expect((await recoverMessageAddress({ message, signature: sent.signature })).toLowerCase()).toBe(payer.address.toLowerCase());
      return { status: 200, data: { token, address: payer.address, expiresAt: new Date(now + 30 * 60_000).toISOString() } };
    }
    if (path === "/v1/attestation/quote") return { status: 200, data: { cpuQuote: "synthetic", gpuQuote: "synthetic", measurement: plan.release.codeHash,
      tcbVersion: 2, timestamp: now, signature: quoteSignature } };
    expect(headers["x-api-key"]).toBe(token);
    if (path === "/v1/session") { expect((await store.load())?.phase).toBe("session-starting");
      return { status: 201, data: { sessionId, wrapKey: key.toString("base64"), expiresAt: new Date(now + 20 * 60_000).toISOString() } }; }
    if (path === "/v1/inference") {
      const payload = body as { sessionId: string; iv: string; tag: string; ciphertext: string };
      expect(payload.sessionId).toBe(sessionId); expect(decryptAesGcm(key, payload).toString()).toBe(ACCEPTANCE_PROMPT);
      expect(headers["idempotency-key"]).toBe((await store.load())?.idempotencyKey);
      if (!headers["x-payment"]) { expect((await store.load())?.phase).toBe("challenge-starting");
        return { status: 402, data: { title: "PAYMENT_REQUIRED", details: { x402Version: 1, accepts: [{ scheme: "exact", network: "arc-5042", maxAmountRequired: control.challengeAmount,
          payTo: plan.release.contracts.UsageMeter, asset: plan.release.contracts.USDC, extra: { receiptPending: true, paymentId } }] } } }; }
      expect(headers["x-payment"]).toBe(paymentId); expect((await store.load())?.phase).toBe("completion-starting");
      control.consumed = true;
      if (control.paidFailure) throw new Error("private response lost; secret body must never be printed");
      return { status: 200, data: result };
    }
    if (path === "/v1/x402/settle") {
      expect((await store.load())?.phase).toBe("settlement-starting");
      const data = body as { paymentId: string; confidential: boolean; authorization: { from: Hex; validAfter: string; validBefore: string; signature: Hex } };
      expect(data.paymentId).toBe(paymentId); expect(data.confidential).toBe(false); expect(data.authorization.from).toBe(payer.address);
      const { keccak256, stringToHex } = await import("viem");
      const signer = await recoverTypedDataAddress({ domain: { ...plan.usdcDomain, chainId: 5042, verifyingContract: plan.release.contracts.USDC }, types: receiveTypes,
        primaryType: "ReceiveWithAuthorization", message: { from: payer.address, to: plan.release.contracts.UsageMeter, value: 100000n, validAfter: 0n,
          validBefore: BigInt(data.authorization.validBefore), nonce: keccak256(stringToHex(paymentId)) }, signature: data.authorization.signature });
      expect(signer.toLowerCase()).toBe(payer.address.toLowerCase());
      if (control.settlementFailure) return { status: 503, data: { title: "INFERENCE_ATTESTATION_FAILED" } };
      return { status: 200, data: { paymentId, confidential: false, tx: settleTx } };
    }
    if (path.startsWith("/v1/workspace?")) {
      const target = { ...result.receipt, chainId: 5042, verifierAddress: plan.release.contracts.AttestationVerifier, typedHash: result.typedHash,
        status: control.anchorReady ? "anchored" : "pending", anchoredTx: control.anchorReady ? anchorTx : null,
        id: sessionId, agentId: null, createdAt: new Date(now).toISOString(), ...(control.badPersistedSignature ? { sig: `0x${"00".repeat(65)}` } : {}) };
      const legacy = { receiptVersion: 1, nonce: null, chainId: null, verifierAddress: null, typedHash: sha256Hex("older legacy receipt"),
        status: "pending", anchoredTx: null, id: paymentId, createdAt: new Date(now - 10_000).toISOString() };
      const page = new URL(`https://unused${path}`).searchParams.get("paymentsBefore") ? 1 : 0;
      return { status: 200, data: { payments: page >= control.paymentPage ? [{ id: paymentId, amountUnits: "100000", status: control.consumed ? "consumed" : "settled", settleTx,
        receiptHash: control.consumed ? result.typedHash : null, confidential: false }] : [], receipts: page === 0 ? [target, ...(control.legacyReceipts ? [legacy] : [])] : [],
        page: { receiptsNext: page === 0 && control.paymentPage === 1 ? sessionId : null, paymentsNext: page === 0 && control.paymentPage === 1 ? paymentId : null } } };
    }
    throw new Error("Unexpected mocked route");
  };
  const deps: AcceptanceDependencies = { api, store, now: () => now, chain: { preflight: vi.fn(async () => ({ payerBalanceUnits: "100000" })), verify: vi.fn(async () => undefined) },
    verifyHardware: vi.fn(async archive => { expect(archive.providerProof.evidence.attestationRef).toBe(proof.evidence.attestationRef); if (control.hardwareFailure) throw new Error("synthetic hardware mismatch"); }) };
  return { context, deps, store, statePath, calls, control, result, key, payer, health, policy, policyBytes, token, settleTx, anchorTx };
}
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "enclave-acceptance-test-")); fixture = await setup(); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
const paidPosts = () => fixture.calls.filter(call => call.path === "/v1/inference" && call.headers["x-payment"]);
const allPosts = () => fixture.calls.filter(call => call.method === "POST");

describe("managed NEAR and Arc synthetic acceptance", () => {
  it.each(["0", "01", "1000001", "-1", "1.0"])("rejects an unbounded or ambiguous testing price %s", expectedPriceUnits => {
    expect(acceptancePlanSchema.safeParse({ ...fixture.context.plan, expectedPriceUnits }).success).toBe(false);
  });
  it.each([0, 513, 4096, 1.5])("rejects an unsafe testing token budget %s", maxOutputTokens => {
    expect(acceptancePlanSchema.safeParse({ ...fixture.context.plan, maxOutputTokens }).success).toBe(false);
  });
  it("accepts an explicitly reviewed 512-token budget for a reasoning model", () => {
    expect(acceptancePlanSchema.safeParse({ ...fixture.context.plan, maxOutputTokens: 512 }).success).toBe(true);
  });
  it("preflights wallet, managed serving identity, reviewed policy and chain without any POST or artifact", async () => {
    const result = await runNearArcAcceptance(fixture.context, "preflight", fixture.deps);
    expect(result).toMatchObject({ status: "preflight-only", capUnits: "1000000", expectedPriceUnits: "100000", walletAuthEnabled: true, mutations: 0 });
    expect(allPosts()).toEqual([]); expect(await fixture.store.load()).toBeUndefined();
    expect(fixture.deps.verifyHardware).not.toHaveBeenCalled();
  });
  it("signs in as payer, settles exact capped authorization, exports verified private archive and review candidate", async () => {
    const result = await runNearArcAcceptance(fixture.context, "execute", fixture.deps);
    expect(result).toMatchObject({ status: "acceptance-evidence-prepared", paidAmountUnits: "100000", paidCompletionPosts: 1, candidateReviewRequired: true, automaticRetry: false });
    expect(allPosts().map(call => call.path)).toEqual(["/v1/auth/wallet/challenge", "/v1/auth/wallet/verify", "/v1/session", "/v1/inference", "/v1/x402/settle", "/v1/inference"]);
    const state = await fixture.store.load(); expect(state?.phase).toBe("completed"); expect(state?.walletAuth?.token).toBe(fixture.token);
    const archive = productionInferenceArchiveSchema.parse(JSON.parse(await readFile(join(directory, "private", "inference.json"), "utf8")));
    expect(Buffer.from(archive.inputBase64, "base64").toString()).toBe(ACCEPTANCE_PROMPT);
    expect(Buffer.from(archive.outputBase64, "base64").toString()).toBe("READY");
    const candidate = JSON.parse(await readFile(join(directory, "private", "release-manifest.candidate.json"), "utf8"));
    expect(candidate.status).toBe("REVIEW_REQUIRED"); expect(candidate.manifest.acceptedPayment.payer).toBe(fixture.payer.address);
    expect(candidate.manifest.acceptedInference.sha256).toBe(sha256Hex(await readFile(join(directory, "private", "inference.json"))));
    expect(candidate.manifest.acceptedPayment.checkedAt).toBe(candidate.manifest.acceptance.acceptedAt);
    expect(candidate.checks.hardwareReplay).toBe(true); expect(candidate.checks.restartReplayVerified).toBe(false);
    expect(fixture.deps.chain.verify).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(fixture.token); expect(JSON.stringify(result)).not.toContain(ACCEPTANCE_PROMPT);
    expect((await readdir(join(directory, "private"))).some(name => name.startsWith(".validation-"))).toBe(false);
  });
  it.each(["execute", "recover"] as const)("never automatically retries an ambiguous completion during %s", async mode => {
    fixture.control.paidFailure = true;
    await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toThrow();
    expect((await fixture.store.load())?.phase).toBe("completion-starting"); expect(paidPosts()).toHaveLength(1);
    if (mode === "execute") await expect(runNearArcAcceptance(fixture.context, mode, fixture.deps)).rejects.toMatchObject({ code: "AMBIGUOUS_REQUEST_RECOVERY_REQUIRED" });
    else expect(await runNearArcAcceptance(fixture.context, mode, fixture.deps)).toMatchObject({ status: "read-only-recovery", paymentStatus: "consumed", completionRetryAllowed: false });
    expect(paidPosts()).toHaveLength(1); expect(fixture.calls.filter(call => call.path === "/v1/x402/settle")).toHaveLength(1);
  });
  it("retains the exact original authorization after an explicit operator rearm", async () => {
    fixture.control.settlementFailure = true;
    await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toMatchObject({ code: "SETTLEMENT_UNCERTAIN" });
    const original = (await fixture.store.load())!;
    expect(original.phase).toBe("settlement-starting"); expect(original.completionPosts).toBe(0);
    await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toMatchObject({ code: "AMBIGUOUS_REQUEST_RECOVERY_REQUIRED" });
    // The separate helper tests below require an operator-reviewed no-spend proof before this transition.
    await fixture.store.save({ ...original, phase: "challenge" }); fixture.control.settlementFailure = false;
    await runNearArcAcceptance(fixture.context, "execute", fixture.deps);
    const posts = fixture.calls.filter(call => call.path === "/v1/x402/settle");
    expect(posts).toHaveLength(2); expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect((await fixture.store.load())?.authorization).toEqual(original.authorization);
    expect(fixture.calls.filter(call => call.path === "/v1/session")).toHaveLength(1);
  });
  it("refuses replacing an expired original authorization after operator rearm", async () => {
    fixture.control.settlementFailure = true;
    await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toThrow();
    const original = (await fixture.store.load())!; await fixture.store.save({ ...original, phase: "challenge" });
    fixture.control.settlementFailure = false; fixture.deps.now = () => now + 601_000;
    await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toMatchObject({ code: "ORIGINAL_AUTHORIZATION_EXPIRED_NO_REPLACEMENT" });
    expect(fixture.calls.filter(call => call.path === "/v1/x402/settle")).toHaveLength(1); expect(paidPosts()).toHaveLength(0);
    expect((await fixture.store.load())?.authorization).toEqual(original.authorization);
  });
  it("refuses every execution or recovery of a closed unspent journal before API or chain calls", async () => {
    fixture.control.settlementFailure = true; await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toThrow();
    const state = (await fixture.store.load())!; await fixture.store.save({ ...state, phase: "aborted-unspent" });
    const calls = fixture.calls.length, chainReads = vi.mocked(fixture.deps.chain.preflight).mock.calls.length;
    for (const mode of ["execute", "recover", "recover-completed", "prepare-manifest"] as const) {
      await expect(runNearArcAcceptance(fixture.context, mode, fixture.deps)).rejects.toMatchObject({ code: "ACCEPTANCE_ABORTED_NO_EXECUTION" });
    }
    expect(fixture.calls).toHaveLength(calls); expect(vi.mocked(fixture.deps.chain.preflight).mock.calls.length).toBe(chainReads);
  });
  it("retrieves the lost stored result only on explicit completed replay after signed owner evidence", async () => {
    fixture.control.paidFailure = true; await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toThrow();
    fixture.control.paidFailure = false;
    const result = await runNearArcAcceptance(fixture.context, "recover-completed", fixture.deps);
    expect(result).toMatchObject({ status: "acceptance-evidence-prepared", replayVerified: true, paidCompletionPosts: 2 });
    expect(paidPosts()).toHaveLength(2);
    expect(paidPosts()[0]?.headers["idempotency-key"]).toBe(paidPosts()[1]?.headers["idempotency-key"]);
    expect(paidPosts()[0]?.body).toEqual(paidPosts()[1]?.body);
    expect(fixture.calls.filter(call => call.path === "/v1/x402/settle")).toHaveLength(1);
  });
  it.each(["not-consumed", "forged-receipt"])("refuses explicit completion replay without sound persisted evidence: %s", async reason => {
    fixture.control.paidFailure = true; await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toThrow();
    fixture.control.paidFailure = false;
    if (reason === "not-consumed") fixture.control.consumed = false; else fixture.control.badPersistedSignature = true;
    await expect(runNearArcAcceptance(fixture.context, "recover-completed", fixture.deps)).rejects.toMatchObject({ code: reason === "not-consumed" ? "COMPLETION_NOT_PROVEN_PERSISTED" : "PERSISTED_RECEIPT_INVALID" });
    expect(paidPosts()).toHaveLength(1);
  });
  it("joins a target receipt from an earlier page when its payment appears on a later page", async () => {
    fixture.control.paymentPage = 1;
    expect(await runNearArcAcceptance(fixture.context, "execute", fixture.deps)).toMatchObject({ status: "acceptance-evidence-prepared" });
    expect(fixture.calls.filter(call => call.path.startsWith("/v1/workspace?")).length).toBeGreaterThanOrEqual(2);
  });
  it("saves the private result while awaiting anchor and later prepares without another paid POST", async () => {
    fixture.control.anchorReady = false;
    expect(await runNearArcAcceptance(fixture.context, "execute", fixture.deps)).toMatchObject({ status: "awaiting-anchor", privateArchiveSaved: true });
    fixture.control.anchorReady = true;
    expect(await runNearArcAcceptance(fixture.context, "prepare-manifest", fixture.deps)).toMatchObject({ status: "acceptance-evidence-prepared" });
    expect(paidPosts()).toHaveLength(1);
  });
  it.each(["price", "token-cap", "wallet-disabled", "origin", "policy-pin"])("fails before any signing or payment when preflight changes: %s", async reason => {
    if (reason === "price") fixture.health.inferencePriceUsdc = 0.2;
    if (reason === "token-cap") fixture.health.limits.maxOutputTokens = 96;
    if (reason === "wallet-disabled") fixture.control.walletEnabled = false;
    if (reason === "origin") fixture.context.plan.walletAuthOrigin = "https://other.example.test";
    if (reason === "policy-pin") fixture.context.policyBytes = Buffer.from("{\"secret\":true}");
    await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toThrow();
    expect(allPosts()).toEqual([]);
  });
  it("refuses signing an altered SIWE origin before session or payment", async () => {
    fixture.control.nonceOrigin = "https://evil.example.test";
    await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toMatchObject({ code: "WALLET_CHALLENGE_SCOPE_MISMATCH" });
    expect(allPosts().map(call => call.path)).toEqual(["/v1/auth/wallet/challenge"]);
  });
  it("refuses a changed payment challenge before authorizing or spending", async () => {
    fixture.control.challengeAmount = "1000001";
    await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toMatchObject({ code: "CHALLENGE_MISMATCH" });
    expect(paidPosts()).toHaveLength(0); expect(fixture.calls.filter(call => call.path === "/v1/x402/settle")).toHaveLength(0);
  });
  it.each(["NEAR_VERIFICATION_FAILED", "PRIVATE_RESPONSE_CONTENT"])("returns fixed status diagnostics without untrusted response text: %s", async title => {
    const api = fixture.deps.api;
    fixture.deps.api = (path, method, body, headers) => path === "/v1/session" ? Promise.resolve({ status: 502, data: { title, detail: "secret transcript and credential" } }) : api(path, method, body, headers);
    await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toMatchObject({ code: "SESSION_FAILED", httpStatus: 502,
      apiTitle: title === "NEAR_VERIFICATION_FAILED" ? title : undefined });
    expect(paidPosts()).toHaveLength(0);
  });
  it("never produces a release candidate after failed hardware replay", async () => {
    fixture.control.hardwareFailure = true;
    await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toThrow();
    expect(paidPosts()).toHaveLength(1); expect((await fixture.store.load())?.phase).toBe("response-received");
    expect((await readdir(join(directory, "private"))).includes("release-manifest.candidate.json")).toBe(false);
  });
  it("refuses resumed journals encrypted with a different prompt before replay", async () => {
    fixture.control.paidFailure = true; await expect(runNearArcAcceptance(fixture.context, "execute", fixture.deps)).rejects.toThrow();
    const state = (await fixture.store.load())!; state.request = { sessionId, ...encryptAesGcm(fixture.key, Buffer.from("different prompt")) }; await fixture.store.save(state);
    await expect(runNearArcAcceptance(fixture.context, "recover-completed", fixture.deps)).rejects.toMatchObject({ code: "JOURNAL_REQUEST_INVALID" });
    expect(paidPosts()).toHaveLength(1);
  });
  it("verifies the gateway receipt signature independently of the signed provider envelope", async () => {
    await runNearArcAcceptance(fixture.context, "execute", fixture.deps);
    const state = (await fixture.store.load())!; state.result!.receipt.sig = `0x${"00".repeat(65)}`;
    await expect(verifyAcceptanceResult(fixture.context, fixture.deps, state)).rejects.toMatchObject({ code: "PROVIDER_SIGNATURE_INVALID" });
  });
  it("rejects a journal belonging to a different payer before any request", async () => {
    await runNearArcAcceptance(fixture.context, "execute", fixture.deps);
    fixture.calls.length = 0; fixture.context.payerKey = generatePrivateKey();
    await expect(runNearArcAcceptance(fixture.context, "recover", fixture.deps)).rejects.toMatchObject({ code: "JOURNAL_SCOPE_MISMATCH" });
    expect(fixture.calls).toEqual([]);
  });
  it("GET recovery refuses an expired saved wallet token without logging in", async () => {
    await runNearArcAcceptance(fixture.context, "execute", fixture.deps);
    const state = (await fixture.store.load())!; state.walletAuth!.expiresAt = new Date(now - 1).toISOString(); await fixture.store.save(state);
    fixture.calls.length = 0;
    await expect(runNearArcAcceptance(fixture.context, "recover", fixture.deps)).rejects.toMatchObject({ code: "WALLET_LOGIN_REQUIRED_EXECUTE" });
    expect(allPosts()).toEqual([]);
  });
});

describe("private acceptance persistence", () => {
  it("uses a dedicated protected directory and refuses artifact collisions", async () => {
    await preparePrivateAcceptanceDirectory(fixture.statePath);
    await writeFile(join(directory, "private", "unrelated.txt"), "must preserve");
    await expect(preparePrivateAcceptanceDirectory(fixture.statePath)).rejects.toMatchObject({ code: "JOURNAL_DIRECTORY_NOT_DEDICATED" });
    expect(() => createAcceptanceStore(join(directory, "inference.json"))).toThrow();
    expect(await readFile(join(directory, "private", "unrelated.txt"), "utf8")).toBe("must preserve");
  });
  it("never unlocks a live process or malformed owner record", async () => {
    await writeFile(`${fixture.statePath}.lock`, String(process.pid)).catch(async () => { await preparePrivateAcceptanceDirectory(fixture.statePath); await writeFile(`${fixture.statePath}.lock`, String(process.pid)); });
    await expect(unlockStaleAcceptanceLock(fixture.statePath)).rejects.toMatchObject({ code: "LOCK_OWNER_ACTIVE" });
    await writeFile(`${fixture.statePath}.lock`, "not-a-pid");
    await expect(unlockStaleAcceptanceLock(fixture.statePath)).rejects.toMatchObject({ code: "LOCK_INVALID" });
  });
});
