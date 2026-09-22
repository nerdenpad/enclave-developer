import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { DevCvm } from "./cvm.js";
import { createVendorRoots, type TcbPolicy } from "./attestation.js";
import { sha256Hex } from "./hash.js";
import { verifyProviderProof } from "./provider-proof.js";
import { verifyNearTranscript, type NearInferenceAdapter, type NearInferenceResult } from "./near-inference.js";
import * as receipts from "./receipt.js";

const provider = privateKeyToAccount(`0x${"55".repeat(32)}`);
const policy: TcbPolicy = { version: 1, servingImageId: "development-image", requireCpuTee: true, requireGpuCc: true };
const config = { policy, modelId: "Qwen/Test", chainId: 31337, verifyingContract: "0x0000000000000000000000000000000000000100" as const };
const persisted = { enclavePrivateKey: `0x${"42".repeat(32)}` as const, wrappingKey: Buffer.alloc(32, 1), modelKey: Buffer.alloc(32, 2) };
const now = 1_800_000_000_000;
const prompt = Buffer.from("Private prompt 🔐");

async function providerResult(input: Buffer = prompt, model = config.modelId): Promise<NearInferenceResult> {
  const output = Buffer.from("Provider answer");
  const requestBody = Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: input.toString("utf8") }], stream: false }));
  const responseBody = Buffer.from(JSON.stringify({ id: "completion-123", model, choices: [{ message: { content: output.toString("utf8") } }] }));
  const requestHash = sha256Hex(requestBody);
  const responseHash = sha256Hex(responseBody);
  const signatureText = `${model}:${requestHash.slice(2)}:${responseHash.slice(2)}`;
  return { output, evidence: { schemaVersion: 1, provider: "near", signatureKind: "provider_tee", endpoint: "https://test.completions.near.ai",
    model, completionId: "completion-123", requestHash, responseHash, outputHash: sha256Hex(output), signatureText,
    signature: await provider.signMessage({ message: signatureText }), signingAddress: provider.address,
    attestationRef: sha256Hex("separate provider hardware evidence"), verifiedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), tlsBound: true },
    transcript: { requestBody, responseBody, attestationProof: '{"public":"hardware evidence fixture"}' } };
}

async function ready(verifiedInference: NearInferenceAdapter) {
  const vendor = await createVendorRoots();
  const cvm = await DevCvm.create({ ...config, verifiedInference }, vendor, persisted);
  const quote = await cvm.quote(now);
  await cvm.releaseKeys(quote, vendor.address, now);
  return { cvm, vendor, quote, context: { attRef: sha256Hex(quote.signature) } };
}

afterEach(() => vi.restoreAllMocks());

describe("development CVM with verified provider evidence", () => {
  it("requires its session admission attestation before invoking a provider", async () => {
    const inference = vi.fn<NearInferenceAdapter>().mockImplementation((input) => providerResult(input));
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create({ ...config, verifiedInference: inference }, vendor, persisted);
    expect(cvm.vendorAddress).toBe(vendor.address);
    const quote = await cvm.quote(now);
    await expect(cvm.infer(prompt, { attRef: sha256Hex(quote.signature) }, now)).rejects.toMatchObject({ code: "KEY_NOT_RELEASED" });
    expect(inference).not.toHaveBeenCalled();
    await expect(cvm.releaseKeys(quote, provider.address, now)).rejects.toMatchObject({ code: "ATTESTATION_FAILED" });
    expect(cvm.keysReleased()).toBe(false);
    await cvm.releaseKeys(quote, vendor.address, now);
    await expect(cvm.infer(prompt, { attRef: sha256Hex("unknown session") }, now)).rejects.toMatchObject({ code: "ATTESTATION_FAILED" });
    expect(inference).not.toHaveBeenCalled();
  });

  it("rejects a missing development vendor root before provider execution", async () => {
    const vendor = await createVendorRoots();
    const inference = vi.fn<NearInferenceAdapter>().mockImplementation(providerResult);
    const cvm = await DevCvm.create({ ...config, verifiedInference: inference }, { ...vendor, address: "" as `0x${string}` });
    const quote = await cvm.quote(now);
    await expect(cvm.releaseKeys(quote, provider.address, now)).rejects.toMatchObject({ code: "ATTESTATION_FAILED" });
    await expect(cvm.infer(prompt, { attRef: sha256Hex(quote.signature) }, now)).rejects.toMatchObject({ code: "KEY_NOT_RELEASED" });
    expect(inference).not.toHaveBeenCalled();
  });

  it("retains an optional transcript without fabricating a hardware proof payload", async () => {
    const result = await providerResult();
    delete result.transcript.attestationProof;
    const { cvm, context } = await ready(async () => result);
    const actual = await cvm.infer(prompt, context, now);
    expect(actual.providerTranscript).not.toHaveProperty("attestationProof");
    expect(await verifyProviderProof(actual.providerProof!, actual.receipt, cvm.enclaveAddress, config.chainId, config.verifyingContract)).toBe(true);
  });

  it("preserves plaintext/model hashes and binds a separate provider proof to the signed receipt", async () => {
    const result = await providerResult();
    const inference = vi.fn<NearInferenceAdapter>().mockResolvedValue(result);
    const { cvm, context } = await ready(inference);
    const actual = await cvm.infer(prompt, context, now);
    expect(inference).toHaveBeenCalledExactlyOnceWith(prompt);
    expect(actual.output).toEqual(result.output);
    expect(actual.receipt).toMatchObject({ receiptVersion: 2, modelHash: sha256Hex(`model:${config.modelId}`), inHash: sha256Hex(prompt),
      outHash: sha256Hex(result.output), attRef: context.attRef, ts: BigInt(now / 1000) });
    expect(actual.receipt.inHash).not.toBe(result.evidence.requestHash);
    expect(actual.receipt.outHash).not.toBe(result.evidence.responseHash);
    expect(actual.receipt.attRef).not.toBe(result.evidence.attestationRef);
    expect(actual.providerTranscript).toEqual(result.transcript);
    expect(actual.providerProof?.evidence).toEqual(result.evidence);
    expect(actual.providerProof?.receiptHash).toBe(receipts.receiptTypedHash(actual.receipt, config.chainId, config.verifyingContract));
    expect(await receipts.verifyReceiptSignature(actual.receipt, cvm.enclaveAddress, config.chainId, config.verifyingContract)).toBe(true);
    expect(await verifyProviderProof(actual.providerProof!, actual.receipt, cvm.enclaveAddress, config.chainId, config.verifyingContract)).toBe(true);
    expect(await verifyNearTranscript(actual.providerProof!.evidence, actual.providerTranscript!)).toBe(true);
  });

  it("keeps development session attestation distinct from provider hardware evidence", async () => {
    const { cvm, quote, context } = await ready(providerResult);
    const result = await cvm.infer(prompt, context, now);
    expect(quote.cpuQuote).toBe(`tdx:${policy.servingImageId}`);
    expect(quote.gpuQuote).toBe(`nvidia-cc:${policy.servingImageId}`);
    expect(result.receipt.attRef).toBe(sha256Hex(quote.signature));
    expect(result.providerProof!.evidence.signingAddress).toBe(provider.address);
    expect(result.providerProof!.evidence.signingAddress).not.toBe(cvm.enclaveAddress);
    // Verifying a remote provider does not upgrade DevCvm or its local receipt signer.
    expect(cvm).toBeInstanceOf(DevCvm);
  });

  it("rejects simultaneous verified and unverified inference adapters", async () => {
    await expect(DevCvm.create({ ...config, verifiedInference: providerResult, inference: async () => Buffer.from("other") }, await createVendorRoots()))
      .rejects.toThrow("Only one inference adapter");
  });

  it.each([undefined, null, {}, { output: "not bytes" }, { output: Buffer.from("answer") }])("never falls back to synthetic receipts for malformed verified results %#", async (value) => {
    const inference = vi.fn<NearInferenceAdapter>().mockResolvedValue(value as NearInferenceResult);
    const { cvm, context } = await ready(inference);
    const sign = vi.spyOn(receipts, "signReceipt");
    await expect(cvm.infer(prompt, context, now)).rejects.toThrow("invalid result");
    expect(sign).not.toHaveBeenCalled();
  });

  it("does not sign a receipt when the backend fails", async () => {
    const inference = vi.fn<NearInferenceAdapter>().mockRejectedValue(new Error("attestation rejected"));
    const { cvm, context } = await ready(inference);
    const sign = vi.spyOn(receipts, "signReceipt");
    await expect(cvm.infer(prompt, context, now)).rejects.toThrow("attestation rejected");
    expect(sign).not.toHaveBeenCalled();
  });

  it.each(["signature", "request", "response", "hash", "output", "model", "input", "non-json"])("rejects invalid provider %s before receipt signing", async (kind) => {
    const result = kind === "model" ? await providerResult(prompt, "Different/Model") : kind === "input" ? await providerResult(Buffer.from("different prompt")) : await providerResult();
    if (kind === "signature") result.evidence.signature = "0x00";
    if (kind === "request") result.transcript.requestBody = Buffer.from("{}");
    if (kind === "response") result.transcript.responseBody = Buffer.from("{}");
    if (kind === "hash") result.evidence.requestHash = sha256Hex("other");
    if (kind === "output") result.output = Buffer.from("different answer");
    if (kind === "non-json") Object.assign(result.evidence, { invalid: undefined });
    const { cvm, context } = await ready(async () => result);
    const sign = vi.spyOn(receipts, "signReceipt");
    await expect(cvm.infer(prompt, context, now)).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 before making a billable provider call", async () => {
    const inference = vi.fn<NearInferenceAdapter>().mockImplementation(providerResult);
    const { cvm, context } = await ready(inference);
    await expect(cvm.infer(Buffer.from([255, 254]), context, now)).rejects.toThrow();
    expect(inference).not.toHaveBeenCalled();
  });

  it("rejects a provider that mutates the prompt and signs its mutated bytes", async () => {
    const { cvm, context } = await ready(async (input) => { input.fill(65); return providerResult(input); });
    const original = Buffer.from(prompt);
    const sign = vi.spyOn(receipts, "signReceipt");
    await expect(cvm.infer(original, context, now)).rejects.toThrow("does not match the input");
    expect(original).toEqual(prompt);
    expect(sign).not.toHaveBeenCalled();
  });

  it("snapshots provider output and transcript buffers before returning", async () => {
    const providerValue = await providerResult();
    const { cvm, context } = await ready(async () => providerValue);
    const result = await cvm.infer(prompt, context, now);
    providerValue.output.fill(0);
    providerValue.transcript.requestBody.fill(0);
    providerValue.transcript.responseBody.fill(0);
    providerValue.evidence.completionId = "mutated";
    expect(result.output.toString()).toBe("Provider answer");
    expect(await verifyNearTranscript(result.providerProof!.evidence, result.providerTranscript!)).toBe(true);
    expect(await verifyProviderProof(result.providerProof!, result.receipt, cvm.enclaveAddress, config.chainId, config.verifyingContract)).toBe(true);
  });

  it("does not reuse an evidence binding for a second receipt even with identical provider output", async () => {
    const { cvm, context } = await ready(providerResult);
    const [first, second] = await Promise.all([cvm.infer(prompt, context, now), cvm.infer(prompt, context, now)]);
    expect(first.receipt.nonce).not.toBe(second.receipt.nonce);
    expect(first.providerProof!.receiptHash).not.toBe(second.providerProof!.receiptHash);
    expect(await verifyProviderProof(first.providerProof!, second.receipt, cvm.enclaveAddress, config.chainId, config.verifyingContract)).toBe(false);
    expect(await verifyProviderProof(second.providerProof!, second.receipt, cvm.enclaveAddress, config.chainId, config.verifyingContract)).toBe(true);
  });
});
