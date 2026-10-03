import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "./hash.js";
import { signProviderProof } from "./provider-proof.js";
import { receiptTypedHash, signReceipt } from "./receipt.js";
import { productionInferenceArchiveSchema, productionProviderPolicySchema, productionReleaseManifestSchema, ProductionReleaseError, validateProductionRelease,
  type ProductionProviderPolicy, type ProductionReleaseManifest } from "./release-manifest.js";
import { tcbPolicyRecord } from "./tcb.js";

// Entirely synthetic fixtures. These files never constitute production acceptance or approved trust roots.
const now = Date.parse("2026-09-30T12:00:00Z");
const contract = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const image = "synthetic-gateway-test-v1";
const model = "Synthetic/OfflineTest";
type Archive = ReturnType<typeof productionInferenceArchiveSchema.parse>;
let directory: string, manifest: ProductionReleaseManifest, policy: ProductionProviderPolicy, archive: Archive;
let gatewayKey: `0x${string}`;
const path = () => join(directory, "manifest.json");
const signedReceipt = () => ({ ...archive.receipt, ts: BigInt(archive.receipt.ts) });

describe("release numeric boundaries", () => {
  it.each(["invalid", "1.2", "-1", "1e6", "0x10", "", " ", "01", "9".repeat(90)])("rejects malformed decimal units and timestamps without throwing: %s", value => {
    expect(() => productionReleaseManifestSchema.shape.acceptedPayment.shape.amountUnits.safeParse(value)).not.toThrow();
    expect(productionReleaseManifestSchema.shape.acceptedPayment.shape.amountUnits.safeParse(value).success).toBe(false);
    expect(() => productionInferenceArchiveSchema.shape.receipt.shape.ts.safeParse(value)).not.toThrow();
    expect(productionInferenceArchiveSchema.shape.receipt.shape.ts.safeParse(value).success).toBe(false);
  });
  it("keeps exact uint256 and uint64 limits", () => {
    const units = productionReleaseManifestSchema.shape.acceptedPayment.shape.amountUnits;
    const timestamp = productionInferenceArchiveSchema.shape.receipt.shape.ts;
    expect(units.safeParse(((1n << 256n) - 1n).toString()).success).toBe(true);
    expect(units.safeParse((1n << 256n).toString()).success).toBe(false);
    expect(timestamp.safeParse(((1n << 64n) - 1n).toString()).success).toBe(true);
    expect(timestamp.safeParse((1n << 64n).toString()).success).toBe(false);
  });
});

describe("explicit NVIDIA verifier policy", () => {
  const pinned = { mode: "local", sdkVersion: "1.2.2",
    binarySha256: "ef4d6b63fc898081d45f39d836848b32e9579202c7b64664aa38350649c09ff6",
    librarySha256: "088b827f0ce9f356afd4afcb27c22bfd71409268e7fc6d987b3331ca8d2a5c24" };
  it("accepts the pinned local implementation separately from the default NRAS profile", () => {
    expect(productionProviderPolicySchema.safeParse(policy).success).toBe(true);
    expect(productionProviderPolicySchema.parse({ ...policy, nvidiaVerifier: pinned }).nvidiaVerifier).toEqual(pinned);
  });
  it.each([{ mode: "auto" }, { mode: "nras" }, { sdkVersion: "unreviewed" }, { binarySha256: "00".repeat(32) },
    { librarySha256: "00".repeat(32) }, { skipOcsp: true }, { nrasUrl: "https://attacker.invalid" }])(
    "rejects verifier changes and permissive settings %#", change => {
      expect(productionProviderPolicySchema.safeParse({ ...policy, nvidiaVerifier: { ...pinned, ...change } }).success).toBe(false);
    });
});
async function save() {
  const policyBytes = Buffer.from(JSON.stringify(policy));
  manifest.providerPolicy.sha256 = sha256Hex(policyBytes);
  const attestation = JSON.parse(archive.providerTranscript.attestationProof) as Record<string, unknown>;
  attestation.policy = policy; attestation.policyHash = manifest.providerPolicy.sha256;
  archive.providerTranscript.attestationProof = JSON.stringify(attestation);
  const bytes = Buffer.from(JSON.stringify(archive));
  manifest.acceptedInference.sha256 = sha256Hex(bytes);
  await writeFile(join(directory, "policy.json"), policyBytes);
  await writeFile(join(directory, "inference.json"), bytes);
  await writeFile(path(), JSON.stringify(manifest));
}
async function rebindProof() {
  archive.providerProof = productionInferenceArchiveSchema.shape.providerProof.parse(await signProviderProof(signedReceipt(), archive.providerProof.evidence, gatewayKey, 5042, manifest.contracts.AttestationVerifier));
}
async function useDirectArchive() {
  archive.providerProof.evidence.endpoint = "https://synthetic-model.completions.near.ai";
  const attestation = JSON.parse(archive.providerTranscript.attestationProof);
  attestation.report = { model_name: model, signing_address: archive.providerProof.evidence.signingAddress,
    intel_quote: "synthetic-quote-requires-separate-hardware-verification" };
  attestation.verdict.signingAddress = archive.providerProof.evidence.signingAddress;
  delete attestation.verdict.model;
  delete attestation.verdict.allowedSigners;
  delete policy.gatewayProfiles;
  archive.providerTranscript.attestationProof = JSON.stringify(attestation);
  await rebindProof(); await save();
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "enclave-offline-release-test-"));
  gatewayKey = generatePrivateKey();
  const gateway = privateKeyToAccount(gatewayKey), provider = privateKeyToAccount(generatePrivateKey());
  const software = tcbPolicyRecord({ version: 7, servingImageId: image, requireCpuTee: true, requireGpuCc: true });
  const measurements = Object.fromEntries(Object.entries({ tee_tcb_svn: 16, mr_seam: 48, mr_signer_seam: 48, seam_attributes: 8,
    td_attributes: 8, xfam: 8, mr_td: 48, mr_config_id: 48, mr_owner: 48, mr_owner_config: 48,
    rt_mr0: 48, rt_mr1: 48, rt_mr2: 48, rt_mr3: 48 }).map(([name, bytes]) => [name, "01".repeat(bytes)]));
  policy = { schemaVersion: 1, version: "synthetic-policy-v7", validFrom: "2026-09-29T00:00:00Z", validUntil: "2026-10-07T00:00:00Z",
    maxSessionSeconds: 120, profiles: [{ model, appComposeSha256: "02".repeat(32), measurements,
      composeManagerActionsSha256: "03".repeat(32), composeManagerImage: `nearaidev/compose-manager@sha256:${"04".repeat(32)}`,
      gpuCount: 1, gpuModels: ["TEST-GPU"] }], gatewayProfiles: [{ appComposeSha256: "05".repeat(32), measurements }],
    provenance: { status: "APPROVED", scope: "production", reviewedAt: "2026-09-30T09:00:00Z", reviewedBy: "synthetic-test-only" } };
  const input = Buffer.from("Reply READY."), output = Buffer.from("READY");
  const request = Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: input.toString() }], stream: false }));
  const response = Buffer.from(JSON.stringify({ id: "synthetic-completion-1", model, choices: [{ message: { content: output.toString() } }] }));
  const text = `${model}:${sha256Hex(request).slice(2)}:${sha256Hex(response).slice(2)}`;
  const receipt = await signReceipt({ receiptVersion: 2, modelHash: sha256Hex(`model:${model}`), codeHash: software.measurement,
    inHash: sha256Hex(input), outHash: sha256Hex(output), attRef: sha256Hex("synthetic software quote"), nonce: sha256Hex("synthetic invocation"),
    ts: BigInt(Date.parse("2026-09-30T10:00:30Z") / 1000) }, gatewayKey, 5042, contract(257));
  const evidence = { schemaVersion: 1 as const, provider: "near" as const, signatureKind: "provider_tee" as const,
    endpoint: "https://cloud-api.near.ai" as const, model, completionId: "synthetic-completion-1", requestHash: sha256Hex(request),
    responseHash: sha256Hex(response), outputHash: sha256Hex(output), signatureText: text, signature: await provider.signMessage({ message: text }),
    signingAddress: provider.address, attestationRef: sha256Hex("synthetic hardware reference"),
    verifiedAt: "2026-09-30T10:00:00Z", expiresAt: "2026-09-30T10:02:00Z", tlsBound: true as const };
  const proof = await signProviderProof(receipt, evidence, gatewayKey, 5042, contract(257));
  archive = { receipt: { ...receipt, ts: receipt.ts.toString(), chainId: 5042, verifierAddress: contract(257), typedHash: receiptTypedHash(receipt, 5042, contract(257)) },
    providerProof: productionInferenceArchiveSchema.shape.providerProof.parse(proof), inputBase64: input.toString("base64"), outputBase64: output.toString("base64"),
    providerTranscript: { requestBodyBase64: request.toString("base64"), responseBodyBase64: response.toString("base64"),
      attestationProof: JSON.stringify({ report: { gateway_attestation: {}, model_attestations: [{ model_name: model, signing_address: provider.address }] },
        verdict: { ok: true, model, attestationRef: evidence.attestationRef, policyVersion: policy.version, verifiedAt: evidence.verifiedAt,
          expiresAt: evidence.expiresAt, allowedSigners: [provider.address] }, policy, policyHash: sha256Hex(JSON.stringify(policy)) }) } };
  manifest = { schemaVersion: 1, origin: "https://synthetic-release.example.test", chainId: 5042, modelId: model, servingImageId: image, tcbVersion: 7,
    modelHash: receipt.modelHash, codeHash: software.measurement, policyHash: software.policyHash, signer: gateway.address,
    contracts: { ModelRegistry: contract(256), AttestationVerifier: contract(257), USDC: contract(258), UsageMeter: contract(259), FeeVault: contract(260) },
    acceptance: { acceptedAt: "2026-09-30T10:05:00Z", validUntil: "2026-10-01T10:05:00Z" },
    providerPolicy: { path: "policy.json", sha256: sha256Hex("placeholder"), version: policy.version, reviewedAt: policy.provenance.reviewedAt,
      reviewedBy: policy.provenance.reviewedBy, scope: "production" },
    acceptedInference: { path: "inference.json", sha256: sha256Hex("placeholder"), checkedAt: "2026-09-30T10:03:00Z", anchorTx: sha256Hex("synthetic anchor") },
    acceptedPayment: { settleTx: sha256Hex("synthetic settlement"), checkedAt: "2026-09-30T10:04:00Z", amountUnits: "100000", payer: contract(261) } };
  await save();
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

describe("offline production release preflight", () => {
  it("accepts a signed direct NEAR archive with complete reviewed model policy and no Gateway profile", async () => {
    await useDirectArchive();
    const network = vi.fn(() => { throw new Error("must remain offline"); }); vi.stubGlobal("fetch", network);
    const result = await validateProductionRelease(path(), { now });
    expect(result.providerAttestationFormat).toBe("direct");
    expect(result.providerPolicy.gatewayProfiles).toBeUndefined();
    expect(result.hardwareAttestationVerified).toBe(false);
    expect(network).not.toHaveBeenCalled();
  });
  it("still requires complete Gateway profiles for Cloud evidence", async () => {
    delete policy.gatewayProfiles; await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "PROVIDER_POLICY_INVALID" });
  });
  it.each(["model", "report-signer", "verdict-signer", "ambiguous-signers", "cloud-report"])("rejects direct attestation format mismatch: %s", async field => {
    await useDirectArchive();
    const proof = JSON.parse(archive.providerTranscript.attestationProof);
    if (field === "model") proof.report.model_name = "Other/Model";
    if (field === "report-signer") proof.report.signing_address = contract(300);
    if (field === "verdict-signer") delete proof.verdict.signingAddress;
    if (field === "ambiguous-signers") proof.verdict.allowedSigners = [archive.providerProof.evidence.signingAddress, contract(300)];
    if (field === "cloud-report") proof.report.gateway_attestation = {};
    archive.providerTranscript.attestationProof = JSON.stringify(proof); await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "ATTESTATION_ARCHIVE_MISMATCH" });
  });
  it("rejects direct-shaped reports under the Cloud origin", async () => {
    await useDirectArchive(); policy.gatewayProfiles = [{ appComposeSha256: "05".repeat(32), measurements: policy.profiles[0]!.measurements }];
    archive.providerProof.evidence.endpoint = "https://cloud-api.near.ai";
    await rebindProof(); await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "ATTESTATION_ARCHIVE_MISMATCH" });
  });
  it.each(["https://evil.example", "http://synthetic-model.completions.near.ai", "https://cloud-api.near.ai/v1",
    "https://synthetic-model.completions.near.ai:8443", "https://secret@synthetic-model.completions.near.ai",
    "https://synthetic-model.completions.near.ai?token=secret", "https://-bad.completions.near.ai",
    "https://bad-.completions.near.ai"])("rejects an unapproved provider origin %s", async endpoint => {
    archive.providerProof.evidence.endpoint = endpoint; await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "INFERENCE_ARCHIVE_INVALID" });
  });
  it("keeps exact signature and production policy checks for direct archives", async () => {
    await useDirectArchive();
    archive.providerProof.evidence.completionId = "tampered"; await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "PROVIDER_PROOF_INVALID" });
    await rebindProof(); (policy.provenance as { scope: string }).scope = "development"; await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "PROVIDER_POLICY_INVALID" });
  });
  it("validates signed bindings and private transcript bytes without requests or a hardware claim", async () => {
    const network = vi.fn(() => { throw new Error("must remain offline"); }); vi.stubGlobal("fetch", network);
    const result = await validateProductionRelease(path(), { now });
    expect(result).toMatchObject({ manifest, providerPolicyHash: manifest.providerPolicy.sha256, typedHash: archive.receipt.typedHash, providerAttestationFormat: "cloud", hardwareAttestationVerified: false });
    expect(result.receipt.ts).toBe(BigInt(archive.receipt.ts));
    expect(network).not.toHaveBeenCalled();
  });
  it.each(["modelHash", "codeHash", "policyHash"] as const)("rejects a mismatched %s instead of deriving approval", async field => {
    manifest[field] = sha256Hex("changed"); await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "RELEASE_HASH_MISMATCH" });
  });
  it.each(["chain", "origin", "placeholder", "duplicate-contract", "missing-anchor", "zero-payment"])("rejects incomplete release scope: %s", async field => {
    const candidate = manifest as unknown as Record<string, unknown>;
    if (field === "chain") candidate.chainId = 31337;
    if (field === "origin") manifest.origin += "/";
    if (field === "placeholder") manifest.contracts.USDC = contract(3);
    if (field === "duplicate-contract") manifest.contracts.UsageMeter = manifest.contracts.FeeVault;
    if (field === "missing-anchor") manifest.acceptedInference.anchorTx = `0x${"00".repeat(32)}`;
    if (field === "zero-payment") manifest.acceptedPayment.amountUnits = "0";
    await save(); await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
  });
  it.each(["expired", "future", "over-thirty-days", "after-acceptance"])("rejects invalid acceptance times: %s", async field => {
    if (field === "expired") manifest.acceptance.validUntil = new Date(now).toISOString();
    if (field === "future") manifest.acceptance.acceptedAt = new Date(now + 1).toISOString();
    if (field === "over-thirty-days") manifest.acceptance.validUntil = "2026-11-01T00:00:00Z";
    if (field === "after-acceptance") manifest.acceptedPayment.checkedAt = "2026-09-30T10:06:00Z";
    await save(); await expect(validateProductionRelease(path(), { now })).rejects.toBeInstanceOf(ProductionReleaseError);
  });
  it("does not accept an acceptance lifetime beyond policy review expiry", async () => {
    manifest.acceptance.validUntil = "2026-10-08T00:00:00Z"; await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "ACCEPTANCE_EXCEEDS_POLICY" });
  });
  it.each(["empty-gateway", "development", "missing-measurement", "extra-measurement", "gpu-count", "unpinned-manager"])("rejects incompatible reviewed policy: %s", async field => {
    if (field === "empty-gateway") policy.gatewayProfiles = [];
    if (field === "development") (policy.provenance as { scope: string }).scope = "DEVELOPMENT ONLY";
    if (field === "missing-measurement") delete policy.profiles[0]!.measurements.mr_td;
    if (field === "extra-measurement") policy.profiles[0]!.measurements.unknown = "00";
    if (field === "gpu-count") policy.profiles[0]!.gpuCount = 0;
    if (field === "unpinned-manager") policy.profiles[0]!.composeManagerImage = "nearaidev/compose-manager:latest";
    await save(); await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "PROVIDER_POLICY_INVALID" });
  });
  it("rejects expired policy and mismatched review identity", async () => {
    policy.validUntil = new Date(now).toISOString(); await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "PROVIDER_POLICY_EXPIRED" });
    policy.validUntil = "2026-10-07T00:00:00Z"; manifest.providerPolicy.reviewedBy = "someone-else"; await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "PROVIDER_POLICY_REVIEW_MISMATCH" });
  });
  it.each(["policy", "inference"])("pins exact %s file bytes rather than a reformatted hash", async name => {
    await writeFile(join(directory, `${name}.json`), name === "policy" ? JSON.stringify(policy, null, 2) : JSON.stringify(archive, null, 2));
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: name === "policy" ? "PROVIDER_POLICY_HASH_MISMATCH" : "INFERENCE_ARCHIVE_HASH_MISMATCH" });
  });
  it("rejects duplicate JSON keys even when the last value is otherwise valid", async () => {
    const bytes = Buffer.from(`{"schemaVersion":9,${JSON.stringify(policy).slice(1)}`);
    await writeFile(join(directory, "policy.json"), bytes); manifest.providerPolicy.sha256 = sha256Hex(bytes);
    await writeFile(path(), JSON.stringify(manifest));
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "PROVIDER_POLICY_INVALID" });
  });
  it.each(["signer", "verifier", "typed-hash", "legacy", "invalid-signature"])("rejects an untrusted receipt %s", async field => {
    if (field === "signer") manifest.signer = contract(300);
    if (field === "verifier") archive.receipt.verifierAddress = contract(300);
    if (field === "typed-hash") archive.receipt.typedHash = sha256Hex("changed");
    if (field === "legacy") (archive.receipt as { receiptVersion: number }).receiptVersion = 1;
    if (field === "invalid-signature") archive.receipt.sig = `0x${"00".repeat(65)}`;
    await save(); await expect(validateProductionRelease(path(), { now })).rejects.toBeInstanceOf(ProductionReleaseError);
  });
  it("rejects altered provider evidence even if the archive hash is updated", async () => {
    archive.providerProof.evidence.completionId = "changed"; await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "PROVIDER_PROOF_INVALID" });
  });
  it("checks the provider's own signature in addition to the gateway evidence signature", async () => {
    archive.providerProof.evidence.signature = `0x${"00".repeat(65)}`; await rebindProof(); await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "PROVIDER_TRANSCRIPT_INVALID" });
  });
  it("checks signed provider expiry at execution while allowing historical session expiry", async () => {
    archive.providerProof.evidence.expiresAt = "2026-09-30T10:00:30Z"; await rebindProof(); await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "INFERENCE_TIME_MISMATCH" });
  });
  it("allows receipt request-start time before asynchronous attestation but bounds runtime", async () => {
    const start = Date.parse(archive.providerProof.evidence.verifiedAt) / 1000;
    const receipt = await signReceipt({ ...signedReceipt(), ts: BigInt(start - 300) }, gatewayKey, 5042, manifest.contracts.AttestationVerifier);
    archive.receipt = { ...archive.receipt, ...receipt, ts: receipt.ts.toString(), typedHash: receiptTypedHash(receipt, 5042, manifest.contracts.AttestationVerifier) };
    await rebindProof(); await save();
    expect((await validateProductionRelease(path(), { now })).receipt.ts).toBe(BigInt(start - 300));
    const tooEarly = await signReceipt({ ...signedReceipt(), ts: BigInt(start - 301) }, gatewayKey, 5042, manifest.contracts.AttestationVerifier);
    archive.receipt = { ...archive.receipt, ...tooEarly, ts: tooEarly.ts.toString(), typedHash: receiptTypedHash(tooEarly, 5042, manifest.contracts.AttestationVerifier) };
    await rebindProof(); await save();
    await expect(validateProductionRelease(path(), { now })).rejects.toMatchObject({ code: "INFERENCE_TIME_MISMATCH" });
  });
  it.each(["input", "output", "request", "base64", "attestation"])("rejects mismatched private archive %s", async field => {
    if (field === "input") archive.inputBase64 = Buffer.from("different prompt").toString("base64");
    if (field === "output") archive.outputBase64 = Buffer.from("different answer").toString("base64");
    if (field === "request") archive.providerTranscript.requestBodyBase64 = Buffer.from("{}").toString("base64");
    if (field === "base64") archive.inputBase64 = "%%%";
    if (field === "attestation") { const proof = JSON.parse(archive.providerTranscript.attestationProof); proof.verdict.allowedSigners = [contract(300)]; archive.providerTranscript.attestationProof = JSON.stringify(proof); }
    await save(); await expect(validateProductionRelease(path(), { now })).rejects.toBeInstanceOf(ProductionReleaseError);
  });
  it("redacts malicious JSON and file errors", async () => {
    await writeFile(path(), "PRIVATE_PROMPT_SHOULD_NOT_LOG");
    const error = await validateProductionRelease(path(), { now }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ProductionReleaseError); expect(String(error)).not.toContain("PRIVATE_PROMPT");
    await expect(validateProductionRelease(join(directory, "missing-secret-name.json"), { now })).rejects.toMatchObject({ code: "MANIFEST_UNREADABLE" });
  });
});
