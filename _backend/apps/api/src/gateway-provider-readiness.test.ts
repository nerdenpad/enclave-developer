import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as core from "@enclave/core";
import { apiKeys, payments, sessions, models, tcbPolicy, inferenceExecutions, type Database } from "@enclave/db";
import { EnclaveGateway } from "./gateway.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createApp } from "./app.js";
import * as store from "./cvm-store.js";
import * as near from "./near-provider.js";
import { TcbLifecycle } from "./tcb-lifecycle.js";
import * as releaseProfile from "./release-profile.js";
import * as tcbChain from "./tcb-chain.js";
import * as runtimeWiring from "./runtime-contract-wiring.js";

type VerifiedSession = Awaited<ReturnType<core.NearAttestationVerifier>>;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const paymentId = "10000000-0000-4000-8000-000000000001", key = "readiness-test-owner";
const payer = privateKeyToAccount(`0x${"51".repeat(32)}`).address;
function denied() { return new core.AppError("INFERENCE_ATTESTATION_FAILED", "NEAR hardware attestation or transport verification failed", 503,
  { attestationFailure: { stage: "verifier", reason: "rejected", verifierError: "WORKLOAD_NOT_APPROVED" } }); }

async function fixture(startupFailure?: unknown, archiveFailure?: unknown) {
  const policy = { version: 1, servingImageId: "enclave-echo-v1", requireCpuTee: true, requireGpuCc: true } as const;
  const record = core.tcbPolicyRecord(policy), hash = `0x${"ab".repeat(32)}`;
  // Release file, archive crypto and chain validation have independent suites;
  // this fixture exercises real gateway readiness and public payment admission.
  const release = { manifest: { policyHash: record.policyHash, codeHash: record.measurement, tcbVersion: 1,
    acceptance: { acceptedAt: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 600_000).toISOString() } },
    providerPolicy: { validUntil: new Date(Date.now() + 600_000).toISOString() }, providerPolicyHash: hash } as unknown as releaseProfile.AcceptedRelease;
  const config = { ...loadConfig({ DATABASE_URL: "postgres://unit.invalid/test", NODE_ENV: "test", TEE_MODE: "managed-near", PAYMENT_MODE: "authorized", ARC_CHAIN_ID: "5042",
    DEPLOYER_PRIVATE_KEY: `0x${"66".repeat(32)}`,
    USDC_ADDRESS: `0x${"31".repeat(20)}`, USAGE_METER_ADDRESS: `0x${"32".repeat(20)}`,
    INFERENCE_BACKEND: "near-verified", INFERENCE_BASE_URL: "https://cloud-api.near.ai/v1", INFERENCE_MODEL: "Qwen/Test", INFERENCE_ALLOW_REMOTE: "true",
    INFERENCE_API_KEY: "synthetic-provider-credential", NEAR_VERIFIER_PYTHON: "fixture-python", NEAR_ATTESTATION_POLICY: "fixture-policy.json" }),
    NODE_ENV: "production" as const, NEAR_ATTESTATION_POLICY_SHA256: hash };
  const vendorPrivateKey = `0x${"11".repeat(32)}` as const;
  vi.spyOn(store, "loadOrCreateCvmKeys").mockResolvedValue({
    stored: { vendorPrivateKey, enclavePrivateKey: `0x${"22".repeat(32)}`, wrappingKey: `0x${"33".repeat(32)}`, modelKey: `0x${"44".repeat(32)}` },
    vendor: { privateKey: vendorPrivateKey, address: privateKeyToAccount(vendorPrivateKey).address },
  });
  const accepted = vi.spyOn(releaseProfile, "assertAcceptedRelease").mockResolvedValue(release);
  const archive = vi.spyOn(releaseProfile, "verifyAcceptedProviderEvidence").mockResolvedValue();
  if (archiveFailure) archive.mockRejectedValueOnce(archiveFailure);
  const wiring = vi.spyOn(runtimeWiring, "verifyRuntimeContractWiring").mockResolvedValue();
  vi.spyOn(TcbLifecycle.prototype, "current").mockResolvedValue({ ...record, policy, status: "active", binding: "onchain", scope: "fixture-scope",
    activatedAt: null, createdAt: new Date(0).toISOString(), trustMode: "development-software" });
  vi.spyOn(tcbChain, "verifyTcbApproval").mockResolvedValue({ mode: "onchain", scope: "fixture-scope", listingId: 1n });
  const fetch = vi.fn<core.NearVerifiedFetch>(), close = vi.fn();
  const verified: VerifiedSession = { tlsBound: true, allowedSigners: [privateKeyToAccount(`0x${"22".repeat(32)}`).address], attestationRef: core.sha256Hex("fixture attestation"),
    verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), fetch, close };
  const preflight = vi.fn<core.NearAttestationVerifier>().mockResolvedValue(verified);
  if (startupFailure) preflight.mockRejectedValueOnce(startupFailure);
  const source = vi.spyOn(near, "createNearAttestationVerifier").mockReturnValue(preflight);
  const db = { select: vi.fn(() => {
    let table: unknown;
    const query = { from: (value: unknown) => { table = value; return query; }, where: () => query, limit: async () => {
      if (table === apiKeys) return [{ keyHash: core.sha256Hex(key) }];
      if (table === payments) return [{ id: paymentId, keyHash: core.sha256Hex(key), amountUnits: 100_000n, status: "open", listingId: null, agentId: null }];
      throw Error("Unexpected readiness fixture query");
    } };
    return query;
  }) };
  // The public authorization path only reads these two tables; no database or
  // network mutation is installed in this isolated fixture.
  const gateway = await EnclaveGateway.boot(db as unknown as Database, config, createLogger("silent"), undefined);
  return { gateway, config, release, accepted, archive, wiring, preflight, source, fetch, close, verified, db,
    authorize: () => gateway.paymentAuthorization(key, paymentId, payer) };
}

/** Isolated transactions keep the dispatch claim committed when publication
 * rolls back. The gateway, CVM, session quote and verified adapter remain real. */
async function inferenceFixture(state: Awaited<ReturnType<typeof fixture>>) {
  type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
  const dialect = new PgDialect(), owner = core.sha256Hex(key), inferencePaymentId = "10000000-0000-4000-8000-000000000004";
  const sessionId = "10000000-0000-4000-8000-000000000005", claimId = "10000000-0000-4000-8000-000000000006";
  const health = state.gateway.health(), policy = { version: 1, servingImageId: "enclave-echo-v1", requireCpuTee: true, requireGpuCc: true } as const;
  let paymentRows = new Map<string, Record<string, unknown>>([
    [paymentId, { id: paymentId, keyHash: owner, amountUnits: 100_000n, status: "open", listingId: null, agentId: null }],
    [inferencePaymentId, { id: inferencePaymentId, keyHash: owner, amountUnits: 100_000n, status: "settled", settlementMode: "simulated", requestHash: null,
      listingId: null, agentId: null }],
  ]);
  let sessionRow: Record<string, unknown> | undefined, dispatch: Record<string, unknown> | undefined;
  const inserted = vi.fn();
  const memory = {
    execute: vi.fn().mockResolvedValue(undefined),
    select: () => {
      let table: unknown, condition: SQL | undefined;
      const rows = async (): Promise<unknown[]> => {
        const selectedId = condition ? String(dialect.sqlToQuery(condition).params[0]) : undefined;
        if (table === apiKeys) return [{ keyHash: owner }];
        if (table === payments) { const row = selectedId ? paymentRows.get(selectedId) : undefined; return row ? [row] : []; }
        if (table === sessions) return sessionRow && selectedId === sessionId ? [sessionRow] : [];
        if (table === inferenceExecutions) return dispatch ? [dispatch] : [];
        if (table === models) return [{ modelHash: health.servingModel.modelHash, codeHash: health.servingModel.codeHash, version: "fixture",
          approved: true, revoked: false, listingBps: 0, listingId: null }];
        if (table === tcbPolicy) return [{ ...core.tcbPolicyRecord(policy), status: "active", activationMode: "onchain", activationScope: "fixture-scope",
          activatedAt: null, createdAt: new Date(0) }];
        throw Error("Unexpected inference fixture query");
      };
      const query = { from: (value: unknown) => { table = value; return query; }, where: (value: SQL) => { condition = value; return query; },
        for: () => query, limit: rows, then: (resolve: (value: unknown[]) => void, reject: (error: unknown) => void) => rows().then(resolve, reject) };
      return query;
    },
    insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => {
      inserted(table);
      return {
        returning: async () => {
          if (table !== sessions) throw Error("Unexpected fixture insert");
          sessionRow = { ...values, id: sessionId, createdAt: new Date() }; return [sessionRow];
        },
        onConflictDoNothing: () => ({ returning: async () => {
          if (table !== inferenceExecutions) throw Error("Unexpected fixture dispatch");
          if (dispatch) return [];
          dispatch = { ...values, claimId, status: "dispatched", receiptHash: null }; return [{ claimId }];
        } }),
      };
    } }),
    update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: (condition: SQL) => ({ returning: async () => {
      if (table !== payments) throw Error("Unexpected fixture update");
      const row = paymentRows.get(String(dialect.sqlToQuery(condition).params[0]));
      if (!row) return [];
      Object.assign(row, values); return [row];
    } }) }) }),
    async transaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
      const savedPayments = structuredClone(paymentRows), savedSession = structuredClone(sessionRow), savedDispatch = structuredClone(dispatch);
      // Only the query shapes used by the public gateway path are installed.
      try { return await operation(memory as unknown as Tx); }
      catch (error) { paymentRows = savedPayments; sessionRow = savedSession; dispatch = savedDispatch; throw error; }
    },
  };
  Object.assign(state.db, memory);
  const quote = await state.gateway.quote();
  await state.gateway.openSession(key, quote);
  const input = { apiKey: key, sessionId, paymentId: inferencePaymentId,
    blob: core.encryptAesGcm(state.gateway.sessionWrapKey(sessionId), Buffer.from("Synthetic readiness probe")) };
  return { input, dispatch: () => dispatch, payment: () => paymentRows.get(inferencePaymentId), inserted };
}
afterEach(() => vi.restoreAllMocks());

describe("strict provider admission readiness", () => {
  it("keeps public status available after a typed fresh startup rejection and denies authorization until a new strict success", async () => {
    const failure = denied(), state = await fixture(failure);
    expect(state.accepted).toHaveBeenCalledOnce(); expect(state.archive).toHaveBeenCalledOnce();
    const response = await createApp(state.gateway, createLogger("silent")).request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deployment: { stage: "pilot", productionReady: false, providerAdmissionReady: false } });
    state.preflight.mockRejectedValueOnce(failure);
    await expect(state.authorize()).rejects.toBe(failure);
    expect(state.fetch).not.toHaveBeenCalled(); expect(state.gateway.health().deployment.productionReady).toBe(false);
    await expect(state.authorize()).resolves.toMatchObject({ paymentId, mode: "authorized" });
    expect(state.gateway.health().deployment.productionReady).toBe(true);
    expect(state.preflight).toHaveBeenCalledTimes(3);
  });
  it("still fails startup for rejected archived evidence and untrusted errors", async () => {
    const archiveFailure = denied();
    await expect(fixture(undefined, archiveFailure)).rejects.toBe(archiveFailure);
    vi.restoreAllMocks();
    const failure = Object.assign(new Error("Untrusted startup error"), { code: "INFERENCE_ATTESTATION_FAILED" });
    await expect(fixture(failure)).rejects.toBe(failure);
  });
  it("clears readiness through the wired NEAR inference adapter while retaining the durable quarantine and never redispatching", async () => {
    const state = await fixture(), inference = await inferenceFixture(state);
    expect(state.gateway.health().deployment.productionReady).toBe(true);
    state.preflight.mockRejectedValueOnce(denied());
    await expect(state.gateway.infer(inference.input)).rejects.toMatchObject({ code: "INFERENCE_EXECUTION_UNCERTAIN", statusCode: 409,
      details: { paymentId: inference.input.paymentId } });
    expect(state.gateway.health().deployment).toMatchObject({ productionReady: false, providerAdmissionReady: false });
    expect(inference.dispatch()).toMatchObject({ paymentId: inference.input.paymentId, status: "dispatched", receiptHash: null });
    expect(inference.payment()).toMatchObject({ status: "settled" });
    expect(state.preflight).toHaveBeenCalledTimes(2); expect(state.fetch).not.toHaveBeenCalled();
    await expect(state.gateway.infer(inference.input)).rejects.toMatchObject({ code: "INFERENCE_EXECUTION_UNCERTAIN" });
    expect(state.preflight).toHaveBeenCalledTimes(2);
    await state.authorize(); expect(state.gateway.health().deployment.productionReady).toBe(true);
    await expect(state.gateway.infer(inference.input)).rejects.toMatchObject({ code: "INFERENCE_EXECUTION_UNCERTAIN" });
    expect(state.preflight).toHaveBeenCalledTimes(3); expect(state.fetch).not.toHaveBeenCalled();
    expect(inference.dispatch()?.status).toBe("dispatched");
  });
  it("also clears readiness for a typed attestation failure at the actual CVM boundary", async () => {
    const state = await fixture(), inference = await inferenceFixture(state);
    const infer = vi.spyOn(core.DevCvm.prototype, "infer").mockRejectedValueOnce(denied());
    await expect(state.gateway.infer(inference.input)).rejects.toMatchObject({ code: "INFERENCE_EXECUTION_UNCERTAIN" });
    expect(infer).toHaveBeenCalledOnce(); expect(state.gateway.health().deployment.productionReady).toBe(false);
    expect(inference.dispatch()).toMatchObject({ status: "dispatched" }); expect(inference.payment()).toMatchObject({ status: "settled" });
  });
  it("does not classify an arbitrary error carrying a verification code as a trusted readiness failure", async () => {
    const state = await fixture(), inference = await inferenceFixture(state);
    vi.spyOn(core.DevCvm.prototype, "infer").mockRejectedValueOnce(Object.assign(new Error("Untrusted error"), { code: "NEAR_VERIFICATION_FAILED" }));
    await expect(state.gateway.infer(inference.input)).rejects.toMatchObject({ code: "INFERENCE_EXECUTION_UNCERTAIN" });
    expect(state.gateway.health().deployment).toMatchObject({ productionReady: true, providerAdmissionReady: true });
    expect(inference.dispatch()?.status).toBe("dispatched");
  });
  it("fences an older preflight success after a typed rejection in the real provider inference path", async () => {
    const state = await fixture(), inference = await inferenceFixture(state), older = deferred<VerifiedSession>();
    state.preflight.mockImplementationOnce(() => older.promise).mockRejectedValueOnce(denied());
    const authorizing = state.authorize(); await vi.waitFor(() => expect(state.preflight).toHaveBeenCalledTimes(2));
    await expect(state.gateway.infer(inference.input)).rejects.toMatchObject({ code: "INFERENCE_EXECUTION_UNCERTAIN" });
    older.resolve(state.verified); await authorizing;
    expect(state.gateway.health().deployment).toMatchObject({ productionReady: false, providerAdmissionReady: false });
    expect(inference.dispatch()?.status).toBe("dispatched"); expect(state.fetch).not.toHaveBeenCalled();
    await state.authorize(); expect(state.gateway.health().deployment.productionReady).toBe(true);
    expect(state.preflight).toHaveBeenCalledTimes(4);
  });
  it("starts ready after archive replay and fresh hardware verification, then reports a denied workload until a new strict success", async () => {
    const state = await fixture(), failure = denied();
    expect(state.accepted).toHaveBeenCalledOnce(); expect(state.archive).toHaveBeenCalledOnce(); expect(state.preflight).toHaveBeenCalledOnce();
    expect(state.gateway.health().deployment).toMatchObject({ productionReady: true, providerAdmissionReady: true });
    state.preflight.mockRejectedValueOnce(failure);
    await expect(state.authorize()).rejects.toBe(failure);
    const response = await createApp(state.gateway, createLogger("silent")).request("/health");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: true, deployment: { stage: "pilot", productionReady: false, providerAdmissionReady: false } });
    expect(state.preflight).toHaveBeenCalledTimes(2); expect(state.fetch).not.toHaveBeenCalled(); expect(state.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(state.gateway.health())).not.toContain("WORKLOAD_NOT_APPROVED");
    expect(JSON.stringify(state.gateway.health())).not.toContain("synthetic-provider-credential");
    await expect(state.authorize()).resolves.toMatchObject({ paymentId, mode: "authorized" });
    expect(state.gateway.health().deployment).toMatchObject({ productionReady: true, providerAdmissionReady: true });
    expect(state.wiring).toHaveBeenCalledTimes(3); expect(state.close).toHaveBeenCalledTimes(2); expect(state.fetch).not.toHaveBeenCalled();
  });
  it("clears readiness for verifier factory and trusted configuration-source errors without replacing the original error", async () => {
    const state = await fixture(), failure = denied();
    state.source.mockImplementationOnce(() => { throw failure; });
    await expect(state.authorize()).rejects.toBe(failure);
    expect(state.gateway.health().deployment.productionReady).toBe(false);
    await state.authorize(); expect(state.gateway.health().deployment.productionReady).toBe(true);
    state.config.NVIDIA_VERIFIER_MODE = "local";
    await expect(state.authorize()).rejects.toThrow("Local NVIDIA verification requires absolute binary and library paths");
    expect(state.gateway.health().deployment).toMatchObject({ productionReady: false, providerAdmissionReady: false });
    state.config.NVIDIA_VERIFIER_MODE = "nras";
    await state.authorize(); expect(state.gateway.health().deployment.productionReady).toBe(true);
  });
  it("does not let an older successful preflight hide a newer failure", async () => {
    const state = await fixture(), older = deferred<VerifiedSession>(), newer = deferred<VerifiedSession>();
    state.preflight.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    const first = state.authorize(), second = state.authorize(), rejected = expect(second).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    await vi.waitFor(() => expect(state.preflight).toHaveBeenCalledTimes(3));
    expect(state.gateway.health().deployment.productionReady).toBe(false);
    newer.reject(denied()); await rejected; older.resolve(state.verified); await first;
    expect(state.gateway.health().deployment).toMatchObject({ productionReady: false, providerAdmissionReady: false });
    await state.authorize(); expect(state.gateway.health().deployment.productionReady).toBe(true);
  });
  it("clears a newer successful result when an older in-flight strict failure is subsequently observed", async () => {
    const state = await fixture(), older = deferred<VerifiedSession>(), newer = deferred<VerifiedSession>();
    state.preflight.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    const first = state.authorize(), second = state.authorize(), rejected = expect(first).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    await vi.waitFor(() => expect(state.preflight).toHaveBeenCalledTimes(3));
    newer.resolve(state.verified); await second; expect(state.gateway.health().deployment.productionReady).toBe(true);
    older.reject(denied()); await rejected; expect(state.gateway.health().deployment.productionReady).toBe(false);
    await state.authorize(); expect(state.gateway.health().deployment.productionReady).toBe(true);
  });
  it("does not substitute provider readiness for acceptance freshness or runtime contract wiring", async () => {
    const state = await fixture();
    state.wiring.mockRejectedValueOnce(new core.AppError("PAYMENTS_RUNTIME_UNAVAILABLE", "RPC unavailable", 503));
    await expect(state.authorize()).rejects.toMatchObject({ code: "PAYMENTS_RUNTIME_UNAVAILABLE" });
    expect(state.gateway.health().deployment.productionReady).toBe(false); expect(state.preflight).toHaveBeenCalledOnce();
    await state.authorize(); expect(state.gateway.health().deployment.productionReady).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(state.release.manifest.acceptance.validUntil));
    expect(state.gateway.health().deployment.productionReady).toBe(false);
    await expect(state.authorize()).rejects.toThrow("expired"); expect(state.preflight).toHaveBeenCalledTimes(2);
  });
  it("clears readiness after known model revocation and restores it only after new chain and strict provider checks", async () => {
    const state = await fixture(), failure = new core.ConflictError("Model revoked");
    vi.mocked(tcbChain.verifyTcbApproval).mockRejectedValueOnce(failure);
    await expect(state.authorize()).rejects.toBe(failure);
    expect(state.gateway.health().deployment).toMatchObject({ productionReady: false, providerAdmissionReady: false });
    expect(state.preflight).toHaveBeenCalledOnce(); expect(state.fetch).not.toHaveBeenCalled();
    await state.authorize(); expect(state.gateway.health().deployment.productionReady).toBe(true);
    expect(state.preflight).toHaveBeenCalledTimes(2);
  });
  it("fences an older in-flight provider success after a newer TCB admission rejection", async () => {
    const state = await fixture(), older = deferred<VerifiedSession>();
    state.preflight.mockImplementationOnce(() => older.promise);
    const first = state.authorize(); await vi.waitFor(() => expect(state.preflight).toHaveBeenCalledTimes(2));
    const failure = new core.ConflictError("Model revoked");
    vi.mocked(tcbChain.verifyTcbApproval).mockRejectedValueOnce(failure);
    await expect(state.authorize()).rejects.toBe(failure);
    older.resolve(state.verified); await first;
    expect(state.gateway.health().deployment).toMatchObject({ productionReady: false, providerAdmissionReady: false });
    await state.authorize(); expect(state.gateway.health().deployment.productionReady).toBe(true);
  });
});
