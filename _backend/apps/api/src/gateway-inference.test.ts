import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import * as core from "@enclave/core";
import { EnclaveGateway } from "./gateway.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import * as store from "./cvm-store.js";
import * as near from "./near-provider.js";
import { TcbLifecycle } from "./tcb-lifecycle.js";
import * as releaseProfile from "./release-profile.js";
import * as tcbChain from "./tcb-chain.js";

beforeEach(() => {
  const policy = { version: 1, servingImageId: "enclave-echo-v1", requireCpuTee: true, requireGpuCc: true } as const;
  vi.spyOn(TcbLifecycle.prototype, "current").mockResolvedValue({ ...core.tcbPolicyRecord(policy), policy,
    status: "active", binding: "legacy", scope: null, activatedAt: null, createdAt: new Date(0).toISOString(), trustMode: "development-software" });
  const vendorPrivateKey = `0x${"11".repeat(32)}` as const;
  vi.spyOn(store, "loadOrCreateCvmKeys").mockResolvedValue({
    stored: { vendorPrivateKey, enclavePrivateKey: `0x${"22".repeat(32)}`, wrappingKey: `0x${"33".repeat(32)}`, modelKey: `0x${"44".repeat(32)}` },
    vendor: { privateKey: vendorPrivateKey, address: privateKeyToAccount(vendorPrivateKey).address },
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("gateway inference adapter configuration", () => {
  const productionSettings = () => ({ ...loadConfig({ DATABASE_URL: "postgres://unit.invalid/test", NODE_ENV: "test", INFERENCE_BACKEND: "near-verified",
    INFERENCE_BASE_URL: "https://cloud-api.near.ai/v1", INFERENCE_MODEL: "Qwen/Test", INFERENCE_ALLOW_REMOTE: "true",
    INFERENCE_API_KEY: "near-test-secret", NEAR_VERIFIER_PYTHON: "fixture-python", NEAR_ATTESTATION_POLICY: "fixture-policy.json" }),
    NODE_ENV: "production" as const, TEE_MODE: "managed-near" as const, NEAR_ATTESTATION_POLICY_SHA256: `0x${"ab".repeat(32)}` });
  function acceptedRelease() {
    const policy = { version: 1, servingImageId: "enclave-echo-v1", requireCpuTee: true, requireGpuCc: true } as const;
    const record = core.tcbPolicyRecord(policy);
    // Only boot control-flow is under test; manifest validation has its own file/crypto/RPC tests.
    return { manifest: { policyHash: record.policyHash, codeHash: record.measurement, tcbVersion: 1,
      acceptance: { acceptedAt: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString() } },
      providerPolicy: { validUntil: new Date(Date.now() + 60_000).toISOString() }, providerPolicyHash: `0x${"ab".repeat(32)}` } as unknown as releaseProfile.AcceptedRelease;
  }
  async function productionGateway() {
    const release = acceptedRelease(), policy = { version: 1, servingImageId: "enclave-echo-v1", requireCpuTee: true, requireGpuCc: true } as const;
    vi.spyOn(releaseProfile, "assertAcceptedRelease").mockResolvedValue(release);
    vi.spyOn(releaseProfile, "verifyAcceptedProviderEvidence").mockResolvedValue();
    vi.mocked(TcbLifecycle.prototype.current).mockResolvedValue({ ...core.tcbPolicyRecord(policy), policy,
      status: "active", binding: "onchain", scope: "fixture-scope", activatedAt: null, createdAt: new Date(0).toISOString(), trustMode: "development-software" });
    const approval = vi.spyOn(tcbChain, "verifyTcbApproval").mockResolvedValue({ mode: "onchain", scope: "fixture-scope", listingId: 1n });
    const close = vi.fn(), fetch = vi.fn<core.NearVerifiedFetch>();
    const hook = vi.fn<core.NearAttestationVerifier>().mockResolvedValue({ tlsBound: true, allowedSigners: [privateKeyToAccount(`0x${"22".repeat(32)}`).address],
      attestationRef: `0x${"45".repeat(32)}`, verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), fetch, close });
    vi.spyOn(near, "createNearAttestationVerifier").mockReturnValue(hook);
    const gateway = await EnclaveGateway.boot({} as Parameters<typeof EnclaveGateway.boot>[0], productionSettings(), createLogger("silent"), undefined);
    return { gateway, release, hook, approval, fetch, close, admission: gateway as unknown as { assertNewPaymentAdmission(): Promise<void> } };
  }
  it("requires a new hardware preflight before each new production payment admission", async () => {
    const fixture = await productionGateway();
    fixture.hook.mockRejectedValueOnce(new core.AppError("INFERENCE_ATTESTATION_FAILED", "Hardware rejected", 503));
    await expect(fixture.admission.assertNewPaymentAdmission()).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(fixture.approval).toHaveBeenCalledTimes(2); expect(fixture.hook).toHaveBeenCalledTimes(2);
    expect(fixture.fetch).not.toHaveBeenCalled(); expect(fixture.close).toHaveBeenCalledOnce();
  });
  it("stops new payments when acceptance expires before asking the provider", async () => {
    const fixture = await productionGateway();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(fixture.release.manifest.acceptance.validUntil));
    await expect(fixture.admission.assertNewPaymentAdmission()).rejects.toThrow("expired");
    expect(fixture.hook).toHaveBeenCalledOnce(); expect(fixture.gateway.health().deployment.productionReady).toBe(false);
  });
  it("stops new payments when model approval is revoked", async () => {
    const fixture = await productionGateway();
    fixture.approval.mockRejectedValueOnce(new core.ConflictError("Model revoked"));
    await expect(fixture.admission.assertNewPaymentAdmission()).rejects.toThrow("Model revoked");
    expect(fixture.hook).toHaveBeenCalledOnce(); expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("also verifies hardware before real payment admissions in a managed pilot", async () => {
    const config = loadConfig({ DATABASE_URL: "postgres://unit.invalid/test", NODE_ENV: "test", TEE_MODE: "managed-near", INFERENCE_BACKEND: "near-verified",
      NEAR_ENDPOINT_PROFILE: "direct-experimental", INFERENCE_BASE_URL: "https://test.completions.near.ai/v1", INFERENCE_MODEL: "Qwen/Test", INFERENCE_ALLOW_REMOTE: "true",
      INFERENCE_API_KEY: "near-test-secret", NEAR_VERIFIER_PYTHON: "fixture-python", NEAR_ATTESTATION_POLICY: "fixture-policy.json", PAYMENT_MODE: "authorized",
      USDC_ADDRESS: `0x${"31".repeat(20)}`, USAGE_METER_ADDRESS: `0x${"32".repeat(20)}` });
    const hook = vi.fn<core.NearAttestationVerifier>().mockRejectedValue(new core.AppError("INFERENCE_ATTESTATION_FAILED", "Hardware rejected", 503));
    vi.spyOn(near, "createNearAttestationVerifier").mockReturnValue(hook);
    const gateway = await EnclaveGateway.boot({} as Parameters<typeof EnclaveGateway.boot>[0], config, createLogger("silent"), undefined);
    const admission = gateway as unknown as { assertNewPaymentAdmission(): Promise<void> };
    await expect(admission.assertNewPaymentAdmission()).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(hook).toHaveBeenCalledOnce(); expect(gateway.health()).toMatchObject({ inferenceRoute: "near-direct-experimental", deployment: { stage: "pilot", productionReady: false } });
  });
  it("refuses legacy policy admission in production before any provider request", async () => {
    vi.spyOn(releaseProfile, "assertAcceptedRelease").mockResolvedValue(acceptedRelease());
    const hook = vi.fn<core.NearAttestationVerifier>();
    vi.spyOn(near, "createNearAttestationVerifier").mockReturnValue(hook);
    await expect(EnclaveGateway.boot({} as Parameters<typeof EnclaveGateway.boot>[0], productionSettings(), createLogger("silent"), undefined))
      .rejects.toThrow("exact accepted on-chain application policy");
    expect(hook).not.toHaveBeenCalled();
  });
  it("requires archive replay and fresh preflight before reporting an accepted production profile, without inference", async () => {
    const release = acceptedRelease(), policy = { version: 1, servingImageId: "enclave-echo-v1", requireCpuTee: true, requireGpuCc: true } as const;
    vi.spyOn(releaseProfile, "assertAcceptedRelease").mockResolvedValue(release);
    const replay = vi.spyOn(releaseProfile, "verifyAcceptedProviderEvidence").mockResolvedValue();
    vi.mocked(TcbLifecycle.prototype.current).mockResolvedValue({ ...core.tcbPolicyRecord(policy), policy,
      status: "active", binding: "onchain", scope: "fixture-scope", activatedAt: null, createdAt: new Date(0).toISOString(), trustMode: "development-software" });
    vi.spyOn(tcbChain, "verifyTcbApproval").mockResolvedValue({ mode: "onchain", scope: "fixture-scope", listingId: 1n });
    const close = vi.fn(), fetch = vi.fn<core.NearVerifiedFetch>();
    const hook = vi.fn<core.NearAttestationVerifier>().mockResolvedValue({ tlsBound: true, allowedSigners: [privateKeyToAccount(`0x${"22".repeat(32)}`).address],
      attestationRef: `0x${"45".repeat(32)}`, verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), fetch, close });
    vi.spyOn(near, "createNearAttestationVerifier").mockReturnValue(hook);
    const gateway = await EnclaveGateway.boot({} as Parameters<typeof EnclaveGateway.boot>[0], productionSettings(), createLogger("silent"), undefined);
    expect(replay).toHaveBeenCalledOnce(); expect(hook).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
    expect(gateway.health()).toMatchObject({ teeMode: "managed-near", deployment: { stage: "production", productionReady: true, gatewayKeyCustody: "software" },
      providerPolicy: { sha256: release.providerPolicyHash } });
  });
  it("wires the hardware verifier into only the verified provider adapter without a startup inference call", async () => {
    const config = loadConfig({ DATABASE_URL: "postgres://unit.invalid/test", NODE_ENV: "test", INFERENCE_BACKEND: "near-verified",
      INFERENCE_BASE_URL: "https://test.completions.near.ai/v1", INFERENCE_MODEL: "Qwen/Test", INFERENCE_ALLOW_REMOTE: "true",
      INFERENCE_API_KEY: "near-test-secret", INFERENCE_TIMEOUT_MS: "120000", NEAR_VERIFIER_PYTHON: "fixture-python",
      NEAR_ATTESTATION_POLICY: "fixture-policy.json", NEAR_MAX_TOKENS: "128" });
    const hook = vi.fn<core.NearAttestationVerifier>().mockRejectedValue(new Error("fixture does not access hardware"));
    const makeVerifier = vi.spyOn(near, "createNearAttestationVerifier").mockReturnValue(hook);
    const adapter = vi.spyOn(core, "createNearInference");
    const generic = vi.spyOn(core, "createOpenAICompatibleInference");
    const cvm = vi.spyOn(core.DevCvm, "create");
    const gateway = await EnclaveGateway.boot({} as Parameters<typeof EnclaveGateway.boot>[0], config, createLogger("silent"), undefined);
    expect(makeVerifier).toHaveBeenCalledExactlyOnceWith({ pythonPath: "fixture-python", policyPath: "fixture-policy.json", apiKey: "near-test-secret" });
    expect(adapter).toHaveBeenCalledExactlyOnceWith({ baseUrl: config.INFERENCE_BASE_URL, model: "Qwen/Test", apiKey: "near-test-secret",
      timeoutMs: 120_000, maxTokens: 128, verifyAttestation: hook });
    expect(cvm.mock.calls[0]![0].verifiedInference).toBeTypeOf("function");
    expect(cvm.mock.calls[0]![0].inference).toBeUndefined();
    expect(generic).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    await expect(cvm.mock.calls[0]![0].verifiedInference!(Buffer.from("fixture prompt"))).rejects.toMatchObject({ code: "NEAR_VERIFICATION_FAILED" });
    expect(hook).toHaveBeenCalledOnce();
    expect(gateway.health()).toMatchObject({ teeMode: "dev" });
    expect(JSON.stringify(gateway.health())).not.toContain("near-test-secret");
  });
  it("wires authenticated remote HTTPS settings into the software CVM without exposing its key", async () => {
    const config = loadConfig({ DATABASE_URL: "postgres://unit.invalid/test", NODE_ENV: "test", INFERENCE_BACKEND: "openai-compatible",
      INFERENCE_BASE_URL: "https://gpu.example.modal.run/v1", INFERENCE_MODEL: "remote-model", INFERENCE_ALLOW_REMOTE: "true",
      INFERENCE_API_KEY: "modal-test-secret", INFERENCE_TIMEOUT_MS: "300000", INFERENCE_HEALTH_PATH: "/health" });
    const adapter = vi.spyOn(core, "createOpenAICompatibleInference");
    const cvm = vi.spyOn(core.DevCvm, "create");
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: "GPU result" } }] }));
    request.mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", request);
    const gateway = await EnclaveGateway.boot({} as Parameters<typeof EnclaveGateway.boot>[0], config, createLogger("silent"), undefined);
    expect(adapter).toHaveBeenCalledExactlyOnceWith({ baseUrl: config.INFERENCE_BASE_URL, model: "remote-model", timeoutMs: 300_000, allowRemote: true, apiKey: "modal-test-secret", healthPath: "/health" });
    expect(request).not.toHaveBeenCalled();
    const inference = cvm.mock.calls[0]![0].inference!;
    expect((await inference(Buffer.from("test prompt"))).toString()).toBe("GPU result");
    expect(String(request.mock.calls[0]![0])).toBe("https://gpu.example.modal.run/health");
    expect(request.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "manual", headers: { authorization: "Bearer modal-test-secret" } });
    expect(request.mock.calls[1]![1]).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: "Bearer modal-test-secret" } });
    expect(gateway.health()).toMatchObject({ teeMode: "dev" });
    expect(JSON.stringify(gateway.health())).not.toContain("modal-test-secret");
  });

  it("preserves local inference defaults without adding an authorization header", async () => {
    const config = loadConfig({ DATABASE_URL: "postgres://unit.invalid/test", NODE_ENV: "test", INFERENCE_BACKEND: "openai-compatible" });
    const adapter = vi.spyOn(core, "createOpenAICompatibleInference");
    const cvm = vi.spyOn(core.DevCvm, "create");
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: "local result" } }] }));
    vi.stubGlobal("fetch", request);
    await EnclaveGateway.boot({} as Parameters<typeof EnclaveGateway.boot>[0], config, createLogger("silent"), undefined);
    expect(adapter).toHaveBeenCalledExactlyOnceWith({ baseUrl: "http://127.0.0.1:8000/v1", model: "echo", timeoutMs: 30_000, allowRemote: false });
    await cvm.mock.calls[0]![0].inference!(Buffer.from("test prompt"));
    expect(request.mock.calls[0]![1]?.headers).not.toHaveProperty("authorization");
  });
});
