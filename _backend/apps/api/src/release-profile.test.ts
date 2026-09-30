import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { productionProviderPolicySchema, productionReleaseManifestSchema, sha256Hex, type SignedReceipt } from "@enclave/core";
import { loadConfig } from "./config.js";
import { runNearVerifier } from "./near-provider.js";
import { assertReleaseConfiguration, releaseIsFresh, verifyAcceptedProviderEvidence, verifyReleaseChain, type AcceptedRelease } from "./release-profile.js";

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn(), getTransactionReceipt: vi.fn(), readContract: vi.fn() }));
vi.mock("viem", async (importOriginal) => ({ ...await importOriginal<typeof import("viem")>(),
  createPublicClient: vi.fn(() => rpc), http: vi.fn(() => ({ name: "mock-transport" })),
}));
vi.mock("./near-provider.js", async (importOriginal) => ({ ...await importOriginal<typeof import("./near-provider.js")>(), runNearVerifier: vi.fn() }));

// Deterministic fixture keys and syntactic acceptance data are never sent to a provider or chain.
const relayKey: Hex = `0x${"12".repeat(32)}`;
const signer = privateKeyToAccount(`0x${"42".repeat(32)}`).address;
const relay = privateKeyToAccount(relayKey).address;
const payer = privateKeyToAccount(`0x${"55".repeat(32)}`).address;
const config = loadConfig({ DATABASE_URL: "postgres://unit.invalid/db", NODE_ENV: "production", TEE_MODE: "managed-near", INFERENCE_BACKEND: "near-verified",
  INFERENCE_BASE_URL: "https://cloud-api.near.ai/v1", INFERENCE_MODEL: "Qwen/Test", INFERENCE_API_KEY: "unit-test-token", INFERENCE_ALLOW_REMOTE: "true",
  NEAR_VERIFIER_PYTHON: "python", NEAR_ATTESTATION_POLICY: "/reviewed/provider-policy.json", NEAR_ATTESTATION_POLICY_SHA256: sha256Hex("provider policy"),
  PRODUCTION_RELEASE_MANIFEST: "/accepted/release.json", ENCLAVE_CVM_PATH: process.platform === "win32" ? "C:\\accepted\\gateway.json" : "/accepted/gateway.json",
  WALLET_AUTH_ORIGIN: "https://enclaveagent.tech", ARC_CHAIN_ID: "5042", ARC_RPC_URL: "https://rpc.unit.invalid", PAYMENT_MODE: "authorized", CHAIN_CONFIRMATIONS: "12",
  USDC_ADDRESS: "0x3600000000000000000000000000000000000000", USDC_EIP712_NAME: "USDC", USDC_EIP712_VERSION: "2", SERVING_IMAGE_ID: "accepted-image-v2", TCB_POLICY_VERSION: "2",
  DEPLOYER_PRIVATE_KEY: relayKey, ATTESTATION_VERIFIER_ADDRESS: `0x${"21".repeat(20)}`, MODEL_REGISTRY_ADDRESS: `0x${"22".repeat(20)}`,
  USAGE_METER_ADDRESS: `0x${"23".repeat(20)}`, FEE_VAULT_ADDRESS: `0x${"24".repeat(20)}`, ENCL_TOKEN_ADDRESS: `0x${"25".repeat(20)}`,
  INSURANCE_STAKING_ADDRESS: `0x${"26".repeat(20)}`, AGENT_MANDATE_ADDRESS: `0x${"27".repeat(20)}`,
});
const now = 1_800_000_000_000;
const iso = (offset: number) => new Date(now + offset).toISOString();
const signature: Hex = `0x${"11".repeat(65)}`;
const anchorHash = sha256Hex("accepted anchor transaction"), paymentHash = sha256Hex("accepted payment transaction");
const anchorBlock = sha256Hex("anchor block"), paymentBlock = sha256Hex("payment block");
const paymentId = "10000000-0000-4000-8000-000000000001";
const typedHash = sha256Hex("accepted typed receipt");
const receipt: SignedReceipt = { receiptVersion: 2, modelHash: sha256Hex("model"), codeHash: sha256Hex("application policy"),
  inHash: sha256Hex("input"), outHash: sha256Hex("output"), attRef: sha256Hex("gateway session descriptor"), nonce: sha256Hex("nonce"), ts: BigInt(now / 1000), sig: signature };
const measurements = Object.fromEntries(Object.entries({ tee_tcb_svn: 16, mr_seam: 48, mr_signer_seam: 48, seam_attributes: 8, td_attributes: 8,
  xfam: 8, mr_td: 48, mr_config_id: 48, mr_owner: 48, mr_owner_config: 48, rt_mr0: 48, rt_mr1: 48, rt_mr2: 48, rt_mr3: 48 })
  .map(([name, size]) => [name, "11".repeat(size)]));
const providerPolicy = productionProviderPolicySchema.parse({ schemaVersion: 1, version: "unit-review-v1", validFrom: iso(-10_000), validUntil: iso(86_400_000), maxSessionSeconds: 60,
  profiles: [{ model: config.INFERENCE_MODEL, appComposeSha256: "11".repeat(32), measurements, composeManagerActionsSha256: "22".repeat(32),
    composeManagerImage: `nearaidev/compose-manager@sha256:${"33".repeat(32)}`, gpuCount: 1, gpuModels: ["fixture GPU"] }],
  gatewayProfiles: [{ appComposeSha256: "44".repeat(32), measurements }], provenance: { status: "APPROVED", scope: "production", reviewedAt: iso(-5_000), reviewedBy: "Unit fixture" } });
const archiveNonce = "56".repeat(32), archiveSpki = "78".repeat(32);
const archiveReport = { gateway_attestation: { request_nonce: archiveNonce }, model_attestations: [{ model: config.INFERENCE_MODEL }] };
const release: AcceptedRelease = {
  manifest: productionReleaseManifestSchema.parse({ schemaVersion: 1, origin: config.WALLET_AUTH_ORIGIN, chainId: 5042, modelId: config.INFERENCE_MODEL,
    servingImageId: config.SERVING_IMAGE_ID, tcbVersion: config.TCB_POLICY_VERSION, modelHash: receipt.modelHash, codeHash: receipt.codeHash,
    policyHash: sha256Hex("policy"), signer, contracts: { ModelRegistry: config.MODEL_REGISTRY_ADDRESS, AttestationVerifier: config.ATTESTATION_VERIFIER_ADDRESS,
      USDC: config.USDC_ADDRESS, UsageMeter: config.USAGE_METER_ADDRESS, FeeVault: config.FEE_VAULT_ADDRESS }, acceptance: { acceptedAt: iso(0), validUntil: iso(86_400_000) },
    providerPolicy: { path: "policy.json", sha256: config.NEAR_ATTESTATION_POLICY_SHA256, version: "unit-review-v1", reviewedAt: iso(-5_000), reviewedBy: "Unit fixture", scope: "production" },
    acceptedInference: { path: "inference.json", sha256: sha256Hex("archive"), checkedAt: iso(0), anchorTx: anchorHash },
    acceptedPayment: { settleTx: paymentHash, checkedAt: iso(0), amountUnits: "100000", payer } }),
  receipt, typedHash, providerPolicy, providerAttestationFormat: "cloud", providerPolicyHash: sha256Hex("provider policy"), manifestPath: "/accepted/release.json", hardwareAttestationVerified: false,
  providerTranscript: { requestBody: Buffer.from("unit request"), responseBody: Buffer.from("unit response"),
    attestationProof: JSON.stringify({ report: archiveReport, verdict: { ok: true, tlsSpkiSha256: archiveSpki } }) },
  providerProof: { version: 1, receiptHash: typedHash, evidenceHash: sha256Hex("evidence"), sig: signature,
    evidence: { schemaVersion: 1, provider: "near", signatureKind: "provider_tee", endpoint: "https://cloud-api.near.ai", model: config.INFERENCE_MODEL,
      completionId: "unit-completion", requestHash: sha256Hex("request"), responseHash: sha256Hex("response"), outputHash: receipt.outHash,
      signatureText: "unit fixture", signature, signingAddress: payer, attestationRef: sha256Hex("hardware report"), verifiedAt: iso(0), expiresAt: iso(60_000), tlsBound: true } },
};
const hardwareVerdict = { ok: true as const, archivedHardwareVerified: true as const, signingAddress: payer, allowedSigners: [payer], tlsSpkiSha256: archiveSpki,
  attestationRef: release.providerProof.evidence.attestationRef, verifiedAt: release.providerProof.evidence.verifiedAt,
  expiresAt: release.providerProof.evidence.expiresAt };
const verifierAbi = parseAbi(["event Verified(bytes32 indexed receiptHash,bytes32 modelHash,bytes32 codeHash,bytes32 inHash,bytes32 outHash,bytes32 attRef,address signer)"]);
const meterAbi = parseAbi(["event Settled(address indexed payer,uint256 amount,bytes32 indexed receiptHash,bool confidentialPath)"]);

function anchorEvent(overrides: { address?: string; receiptHash?: Hex; signer?: Hex; outHash?: Hex } = {}) {
  return { address: overrides.address ?? config.ATTESTATION_VERIFIER_ADDRESS,
    topics: encodeEventTopics({ abi: verifierAbi, eventName: "Verified", args: { receiptHash: overrides.receiptHash ?? typedHash } }),
    data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
      [receipt.modelHash, receipt.codeHash, receipt.inHash, overrides.outHash ?? receipt.outHash, receipt.attRef, overrides.signer ?? signer]) };
}
function paymentEvent(overrides: { address?: string; receiptHash?: Hex; payer?: Hex; amount?: bigint; confidential?: boolean } = {}) {
  return { address: overrides.address ?? config.USAGE_METER_ADDRESS,
    topics: encodeEventTopics({ abi: meterAbi, eventName: "Settled", args: { payer: overrides.payer ?? payer, receiptHash: overrides.receiptHash ?? keccak256(stringToHex(paymentId)) } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [overrides.amount ?? 100_000n, overrides.confidential ?? false]) };
}
function anchorReceipt(overrides: Record<string, unknown> = {}) {
  return { transactionHash: anchorHash, blockHash: anchorBlock, blockNumber: 100n, status: "success", to: config.ATTESTATION_VERIFIER_ADDRESS, logs: [anchorEvent()], ...overrides };
}
function paymentReceipt(overrides: Record<string, unknown> = {}) {
  return { transactionHash: paymentHash, blockHash: paymentBlock, blockNumber: 101n, status: "success", to: config.USAGE_METER_ADDRESS, logs: [paymentEvent()], ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.getChainId.mockReset().mockResolvedValue(5042);
  rpc.getBlockNumber.mockReset().mockResolvedValue(113n);
  rpc.getBlock.mockReset().mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: blockNumber === 100n ? anchorBlock : paymentBlock }));
  rpc.getTransactionReceipt.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) => hash === anchorHash ? anchorReceipt() : paymentReceipt());
  rpc.readContract.mockReset().mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "registry" || functionName === "modelRegistry") return config.MODEL_REGISTRY_ADDRESS;
    if (functionName === "enclaveSigner") return signer;
    if (functionName === "usdc") return config.USDC_ADDRESS;
    if (functionName === "feeVault") return config.FEE_VAULT_ADDRESS;
    if (functionName === "relay") return relay;
    throw new Error("Unexpected contract read");
  });
  vi.mocked(runNearVerifier).mockReset().mockResolvedValue(hardwareVerdict);
});

describe("accepted production runtime configuration", () => {
  it("accepts only the reviewed runtime signer, price, policy, model and contract tuple", () => {
    expect(() => assertReleaseConfiguration(config, release, signer)).not.toThrow();
    expect(() => assertReleaseConfiguration(config, release, payer)).toThrow("Runtime settings differ");
  });
  it.each([{ ARC_CHAIN_ID: 5042002 }, { WALLET_AUTH_ORIGIN: "https://other.invalid" }, { INFERENCE_MODEL: "Different/Model" },
    { TCB_POLICY_VERSION: 3 }, { SERVING_IMAGE_ID: "other-image" }, { INFERENCE_PRICE_USDC: 0.2 }, { NEAR_ATTESTATION_POLICY_SHA256: sha256Hex("other policy") },
    { MODEL_REGISTRY_ADDRESS: `0x${"45".repeat(20)}` }, { ATTESTATION_VERIFIER_ADDRESS: `0x${"45".repeat(20)}` },
    { USDC_ADDRESS: `0x${"45".repeat(20)}` }, { USAGE_METER_ADDRESS: `0x${"45".repeat(20)}` }, { FEE_VAULT_ADDRESS: `0x${"45".repeat(20)}` }])(
    "rejects a runtime release mismatch %#", (override) => { expect(() => assertReleaseConfiguration({ ...config, ...override }, release, signer)).toThrow(); });
  it("expires admission at either release or provider policy deadline", () => {
    expect(releaseIsFresh(release, now)).toBe(true);
    expect(releaseIsFresh(release, now - 1)).toBe(false);
    expect(releaseIsFresh(release, now + 86_400_000)).toBe(false);
    expect(releaseIsFresh({ ...release, providerPolicy: { ...providerPolicy, validUntil: iso(1_000) } }, now + 1_000)).toBe(false);
  });
});

describe("canonical paid release chain acceptance", () => {
  it("accepts exact confirmed receipt and settlement events", async () => {
    await expect(verifyReleaseChain(config, release, paymentId)).resolves.toBeUndefined();
    expect(rpc.getTransactionReceipt).toHaveBeenCalledWith({ hash: anchorHash });
    expect(rpc.getTransactionReceipt).toHaveBeenCalledWith({ hash: paymentHash });
    expect(rpc.getBlock).toHaveBeenCalledTimes(4);
  });
  it("rejects a wrong RPC chain before fetching release transactions", async () => {
    rpc.getChainId.mockResolvedValueOnce(1);
    await expect(verifyReleaseChain(config, release, paymentId)).rejects.toThrow("RPC chain mismatch");
    expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it.each(["registry", "enclaveSigner", "usdc", "feeVault", "modelRegistry", "relay"])("rejects mismatched %s wiring", async (name) => {
    const original = rpc.readContract.getMockImplementation()!;
    rpc.readContract.mockImplementation(async (call: { functionName: string }) => call.functionName === name ? payer : original(call));
    await expect(verifyReleaseChain(config, release, paymentId)).rejects.toThrow("wiring or receipt signer mismatch");
  });
  it.each([{ status: "reverted" }, { transactionHash: sha256Hex("wrong transaction") }, { to: config.USDC_ADDRESS },
    { blockHash: sha256Hex("orphan block") }])("rejects noncanonical anchor receipts %#", async (override) => {
    rpc.getTransactionReceipt.mockResolvedValueOnce(anchorReceipt(override)).mockResolvedValueOnce(paymentReceipt());
    await expect(verifyReleaseChain(config, release, paymentId)).rejects.toThrow("unconfirmed or noncanonical");
  });
  it("rejects insufficient payment confirmations", async () => {
    rpc.getBlockNumber.mockResolvedValueOnce(112n);
    await expect(verifyReleaseChain(config, release, paymentId)).rejects.toThrow("unconfirmed or noncanonical");
  });
  it.each([{ address: config.USAGE_METER_ADDRESS }, { receiptHash: sha256Hex("other receipt") }, { signer: payer }, { outHash: sha256Hex("different output") }])(
    "rejects an anchor event with another contract, receipt, signer or output %#", async (override) => {
      rpc.getTransactionReceipt.mockResolvedValueOnce(anchorReceipt({ logs: [anchorEvent(override)] })).mockResolvedValueOnce(paymentReceipt());
      await expect(verifyReleaseChain(config, release, paymentId)).rejects.toThrow("exact accepted receipt or USDC settlement event");
    });
  it.each([{ address: config.USDC_ADDRESS }, { receiptHash: typedHash }, { payer: signer }, { amount: 100_001n }, { confidential: true }])(
    "rejects settlement events for another contract, payment ID, payer, amount or path %#", async (override) => {
      rpc.getTransactionReceipt.mockResolvedValueOnce(anchorReceipt()).mockResolvedValueOnce(paymentReceipt({ logs: [paymentEvent(override)] }));
      await expect(verifyReleaseChain(config, release, paymentId)).rejects.toThrow("exact accepted receipt or USDC settlement event");
    });
  it("rejects duplicate matching events instead of choosing one", async () => {
    rpc.getTransactionReceipt.mockResolvedValueOnce(anchorReceipt({ logs: [anchorEvent(), anchorEvent()] })).mockResolvedValueOnce(paymentReceipt());
    await expect(verifyReleaseChain(config, release, paymentId)).rejects.toThrow("exact accepted receipt or USDC settlement event");
  });
  it("rejects a reorg after event validation", async () => {
    rpc.getBlock.mockResolvedValueOnce({ hash: anchorBlock }).mockResolvedValueOnce({ hash: paymentBlock }).mockResolvedValueOnce({ hash: sha256Hex("reorg") });
    await expect(verifyReleaseChain(config, release, paymentId)).rejects.toThrow("changed during validation");
  });
});

describe("accepted inference hardware evidence replay", () => {
  const directConfig = { ...config, NEAR_ENDPOINT_PROFILE: "direct-experimental" as const, INFERENCE_BASE_URL: "https://test.completions.near.ai/v1" };
  const directReport = { request_nonce: archiveNonce, model_name: config.INFERENCE_MODEL, signing_address: payer };
  const directRelease: AcceptedRelease = { ...release, providerAttestationFormat: "direct", providerProof: { ...release.providerProof,
    evidence: { ...release.providerProof.evidence, endpoint: "https://test.completions.near.ai" } },
    providerTranscript: { ...release.providerTranscript, attestationProof: JSON.stringify({ report: directReport,
      verdict: { ok: true, tlsSpkiSha256: archiveSpki } }) } };
  it("replays direct evidence with the original node nonce and a singleton signer", async () => {
    await expect(verifyAcceptedProviderEvidence(directConfig, directRelease)).resolves.toBeUndefined();
    expect(runNearVerifier).toHaveBeenCalledExactlyOnceWith({ pythonPath: config.NEAR_VERIFIER_PYTHON,
      policyPath: config.NEAR_ATTESTATION_POLICY, policySha256: config.NEAR_ATTESTATION_POLICY_SHA256 },
    { nonce: archiveNonce, tlsSpkiSha256: archiveSpki, attestation: directReport,
      archivedVerdict: { ok: true, tlsSpkiSha256: archiveSpki } }, expect.any(AbortSignal), false, true);
  });
  it("rejects a direct provider archive from another configured node", async () => {
    await expect(verifyAcceptedProviderEvidence({ ...directConfig, INFERENCE_BASE_URL: "https://other.completions.near.ai/v1" }, directRelease))
      .rejects.toThrow("replayable hardware evidence archive");
    expect(runNearVerifier).not.toHaveBeenCalled();
    expect(() => assertReleaseConfiguration(config, directRelease, signer)).toThrow("Runtime settings differ");
  });
  it.each([archiveReport, { ...directReport, model_name: "Wrong/Model" }, { ...directReport, gateway_attestation: archiveReport.gateway_attestation }])(
    "rejects a mismatched or mixed direct archive %#", async (report) => {
      await expect(verifyAcceptedProviderEvidence(directConfig, { ...directRelease, providerTranscript: { ...directRelease.providerTranscript,
        attestationProof: JSON.stringify({ report, verdict: { tlsSpkiSha256: archiveSpki } }) } })).rejects.toThrow("replayable hardware evidence archive");
      expect(runNearVerifier).not.toHaveBeenCalled();
    });
  it("rejects a direct archive allowing a different model node to sign", async () => {
    vi.mocked(runNearVerifier).mockResolvedValueOnce({ ...hardwareVerdict, allowedSigners: [payer, signer] });
    await expect(verifyAcceptedProviderEvidence(directConfig, directRelease)).rejects.toThrow("not bound to replayed CPU/GPU evidence");
  });
  it("passes the archived nonce, TLS binding and model through cloud verification under the pinned policy", async () => {
    await expect(verifyAcceptedProviderEvidence(config, release)).resolves.toBeUndefined();
    expect(runNearVerifier).toHaveBeenCalledExactlyOnceWith({ pythonPath: config.NEAR_VERIFIER_PYTHON,
      policyPath: config.NEAR_ATTESTATION_POLICY, policySha256: config.NEAR_ATTESTATION_POLICY_SHA256 },
    { nonce: archiveNonce, tlsSpkiSha256: archiveSpki, model: config.INFERENCE_MODEL, attestation: archiveReport,
      archivedVerdict: { ok: true, tlsSpkiSha256: archiveSpki } }, expect.any(AbortSignal), true, true);
    expect(rpc.getChainId).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "{}", "not JSON", JSON.stringify({ report: { gateway_attestation: {} }, verdict: { tlsSpkiSha256: archiveSpki } })])(
    "rejects a missing or malformed hardware archive %# before invoking the verifier", async (attestationProof) => {
      const providerTranscript = { ...release.providerTranscript };
      // REASON: Exercise malformed runtime archive data despite the validated release type.
      if (attestationProof === undefined) Reflect.deleteProperty(providerTranscript, "attestationProof");
      else providerTranscript.attestationProof = attestationProof;
      await expect(verifyAcceptedProviderEvidence(config, { ...release, providerTranscript })).rejects.toThrow("replayable hardware evidence archive");
      expect(runNearVerifier).not.toHaveBeenCalled();
    });
  it("rejects archived evidence when independent verification reports an OutOfDate TCB", async () => {
    vi.mocked(runNearVerifier).mockRejectedValueOnce(new Error("CPU_TCB_REJECTED: OutOfDate"));
    await expect(verifyAcceptedProviderEvidence(config, release)).rejects.toThrow();
    expect(runNearVerifier).toHaveBeenCalledTimes(1);
  });
  it("never trusts a saved successful verdict after the independent verifier fails", async () => {
    vi.mocked(runNearVerifier).mockRejectedValueOnce(new Error("NVIDIA_SIGNATURE_INVALID"));
    await expect(verifyAcceptedProviderEvidence(config, release)).rejects.toThrow();
    expect(runNearVerifier).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "false"])("rejects a %s independent archive verification flag", async (kind) => {
    const { archivedHardwareVerified: _unused, ...withoutFlag } = hardwareVerdict;
    vi.mocked(runNearVerifier).mockResolvedValueOnce(kind === "missing" ? withoutFlag : { ...hardwareVerdict, archivedHardwareVerified: false });
    const providerTranscript = { ...release.providerTranscript, attestationProof: JSON.stringify({ report: archiveReport,
      verdict: { ok: true, archivedHardwareVerified: true, tlsSpkiSha256: archiveSpki } }) };
    await expect(verifyAcceptedProviderEvidence(config, { ...release, providerTranscript })).rejects.toThrow("not bound to replayed CPU/GPU evidence");
    expect(runNearVerifier).toHaveBeenCalledTimes(1);
  });
  it.each(["verifiedAt", "expiresAt"] as const)("rejects a replayed %s that differs from signed provider evidence", async (field) => {
    vi.mocked(runNearVerifier).mockResolvedValueOnce({ ...hardwareVerdict, [field]: iso(1_000) });
    await expect(verifyAcceptedProviderEvidence(config, release)).rejects.toThrow("not bound to replayed CPU/GPU evidence");
  });
  it.each(["reference", "signer-set", "fallback-signer"])("rejects replayed %s mismatch", async (kind) => {
    const verdict = { ...hardwareVerdict };
    if (kind === "reference") verdict.attestationRef = sha256Hex("unrelated hardware report");
    if (kind === "signer-set") verdict.allowedSigners = [signer];
    if (kind === "fallback-signer") verdict.signingAddress = signer;
    const { allowedSigners: _unused, ...withoutSignerSet } = verdict;
    vi.mocked(runNearVerifier).mockResolvedValueOnce(kind === "fallback-signer" ? withoutSignerSet : verdict);
    await expect(verifyAcceptedProviderEvidence(config, release)).rejects.toThrow("not bound to replayed CPU/GPU evidence");
  });
  it("accepts the signed provider only when it belongs to the independently replayed signer set", async () => {
    vi.mocked(runNearVerifier).mockResolvedValueOnce({ ...hardwareVerdict, signingAddress: signer, allowedSigners: [signer, payer] });
    await expect(verifyAcceptedProviderEvidence(config, release)).resolves.toBeUndefined();
  });
});
