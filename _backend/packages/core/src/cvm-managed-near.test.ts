import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { DevCvm, type CvmConfig } from "./cvm.js";
import { createVendorRoots, quotePayload, type TcbPolicy } from "./attestation.js";
import * as attestation from "./attestation.js";
import * as receipts from "./receipt.js";
import { sha256Hex } from "./hash.js";
import { verifyProviderProof } from "./provider-proof.js";
import { type NearInferenceAdapter, type NearInferenceResult } from "./near-inference.js";

const provider = privateKeyToAccount(`0x${"55".repeat(32)}`);
const policy: TcbPolicy = { version: 1, servingImageId: "gateway-policy-v1", requireCpuTee: true, requireGpuCc: true };
const config = { policy, modelId: "Qwen/Test", chainId: 31337, verifyingContract: "0x0000000000000000000000000000000000000100" as const,
  gatewayMode: "managed-near" as const };
const persisted = { enclavePrivateKey: `0x${"42".repeat(32)}` as const, wrappingKey: Buffer.alloc(32, 1), modelKey: Buffer.alloc(32, 2) };
const now = 1_800_000_000_000;
const prompt = Buffer.from("Private prompt 🔐");

async function providerResult(input: Buffer = prompt): Promise<NearInferenceResult> {
  const output = Buffer.from("Verified provider answer");
  const requestBody = Buffer.from(JSON.stringify({ model: config.modelId, messages: [{ role: "user", content: input.toString("utf8") }], stream: false }));
  const responseBody = Buffer.from(JSON.stringify({ id: "completion-123", model: config.modelId, choices: [{ message: { content: output.toString("utf8") } }] }));
  const requestHash = sha256Hex(requestBody);
  const responseHash = sha256Hex(responseBody);
  const signatureText = `${config.modelId}:${requestHash.slice(2)}:${responseHash.slice(2)}`;
  return { output, evidence: { schemaVersion: 1, provider: "near", signatureKind: "provider_tee", endpoint: "https://test.completions.near.ai",
    model: config.modelId, completionId: "completion-123", requestHash, responseHash, outputHash: sha256Hex(output), signatureText,
    signature: await provider.signMessage({ message: signatureText }), signingAddress: provider.address,
    attestationRef: sha256Hex("provider hardware evidence"), verifiedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), tlsBound: true },
    transcript: { requestBody, responseBody, attestationProof: '{"public":"hardware evidence fixture"}' } };
}

async function create(verifiedInference: NearInferenceAdapter = providerResult) {
  const vendor = await createVendorRoots();
  const cvm = await DevCvm.create({ ...config, verifiedInference }, vendor, persisted);
  const quote = await cvm.quote(now);
  return { cvm, vendor, quote, context: { attRef: sha256Hex(quote.signature) } };
}

async function ready(verifiedInference: NearInferenceAdapter = providerResult) {
  const fixture = await create(verifiedInference);
  await fixture.cvm.releaseKeys(fixture.quote, fixture.vendor.address, now);
  return fixture;
}

afterEach(() => vi.restoreAllMocks());

describe("managed NEAR software gateway admission", () => {
  it("requires verified inference configuration and rejects an ordinary echo adapter", async () => {
    const vendor = await createVendorRoots();
    await expect(DevCvm.create(config, vendor)).rejects.toThrow("requires a verified inference adapter");
    const echo = vi.fn(async (input: Buffer) => input);
    await expect(DevCvm.create({ ...config, inference: echo }, vendor)).rejects.toThrow("forbids ordinary inference");
    await expect(DevCvm.create({ ...config, inference: echo, verifiedInference: providerResult }, vendor)).rejects.toThrow("Only one inference adapter");
    expect(echo).not.toHaveBeenCalled();
  });

  it("issues a signed software descriptor without invoking local hardware quote helpers", async () => {
    const issueHardware = vi.spyOn(attestation, "issueQuote");
    const verifyHardware = vi.spyOn(attestation, "verifyQuote");
    const { cvm, vendor, quote, context } = await create();
    expect(quote).toMatchObject({ cpuQuote: `gateway-session:${policy.servingImageId}`,
      gpuQuote: "near-provider:verify-before-inference", measurement: cvm.codeHash, tcbVersion: policy.version, timestamp: now });
    expect(cvm.keysReleased()).toBe(false);
    await cvm.releaseKeys(quote, vendor.address, now);
    expect(cvm.keysReleased()).toBe(true);
    expect(cvm.sessionSecret("managed-session")).toHaveLength(32);
    const result = await cvm.infer(prompt, context, now);
    expect(result.receipt.attRef).toBe(sha256Hex(quote.signature));
    expect(result.receipt.attRef).not.toBe(result.providerProof?.evidence.attestationRef);
    expect(issueHardware).not.toHaveBeenCalled();
    expect(verifyHardware).not.toHaveBeenCalled();
  });

  it.each([
    { cpuQuote: `tdx:${policy.servingImageId}` },
    { gpuQuote: `nvidia-cc:${policy.servingImageId}` },
    { measurement: sha256Hex("different gateway policy") },
    { tcbVersion: policy.version + 1 },
    { timestamp: now + 1_000 },
    { signature: "0x00" as const },
  ])("refuses a tampered software admission descriptor %# before releasing keys", async (change) => {
    const inference = vi.fn<NearInferenceAdapter>().mockImplementation(providerResult);
    const { cvm, vendor, quote, context } = await create(inference);
    await expect(cvm.releaseKeys({ ...quote, ...change }, vendor.address, now)).rejects.toMatchObject({ code: "ATTESTATION_FAILED" });
    expect(cvm.keysReleased()).toBe(false);
    await expect(cvm.infer(prompt, context, now)).rejects.toMatchObject({ code: "KEY_NOT_RELEASED" });
    expect(inference).not.toHaveBeenCalled();
  });

  it("refuses hardware-looking descriptors even when the software issuer signs them", async () => {
    const { cvm, vendor, quote } = await create();
    const descriptor = { ...quote, cpuQuote: `tdx:${policy.servingImageId}`, gpuQuote: `nvidia-cc:${policy.servingImageId}` };
    descriptor.signature = await privateKeyToAccount(vendor.privateKey!).signMessage({ message: quotePayload(descriptor) });
    await expect(cvm.releaseKeys(descriptor, vendor.address, now)).rejects.toMatchObject({ code: "ATTESTATION_FAILED" });
    expect(cvm.keysReleased()).toBe(false);
  });

  it("refuses another issuer and a malleated high-S signature", async () => {
    const { cvm, vendor, quote } = await create();
    const other = await createVendorRoots();
    await expect(cvm.releaseKeys(quote, other.address, now)).rejects.toMatchObject({ code: "ATTESTATION_FAILED" });
    const wrongSignature = await privateKeyToAccount(other.privateKey!).signMessage({ message: quotePayload(quote) });
    await expect(cvm.releaseKeys({ ...quote, signature: wrongSignature }, vendor.address, now)).rejects.toThrow("does not match its issuer");
    const curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${quote.signature.slice(66, 130)}`);
    const v = Number.parseInt(quote.signature.slice(130), 16);
    const highS: `0x${string}` = `0x${quote.signature.slice(2, 66)}${(curveOrder - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
    await expect(cvm.releaseKeys({ ...quote, signature: highS }, vendor.address, now)).rejects.toThrow("Invalid gateway session signature");
    expect(cvm.keysReleased()).toBe(false);
  });

  it.each([now + 300_001, now - 300_001, NaN, -1, Infinity, 1.5])("refuses stale or invalid verifier time %s", async (clock) => {
    const { cvm, vendor, quote } = await create();
    await expect(cvm.releaseKeys(quote, vendor.address, clock)).rejects.toMatchObject({ code: "ATTESTATION_FAILED" });
    expect(cvm.keysReleased()).toBe(false);
  });

  it("snapshots managed configuration so later mutation cannot enable ordinary fallback", async () => {
    const vendor = await createVendorRoots();
    const inference = vi.fn<NearInferenceAdapter>().mockImplementation(providerResult);
    const source: CvmConfig = { ...config, policy: { ...policy }, verifiedInference: inference };
    const cvm = await DevCvm.create(source, vendor, persisted);
    source.gatewayMode = "development";
    delete source.verifiedInference;
    source.inference = vi.fn(async (input: Buffer) => input);
    source.policy.servingImageId = "mutated-policy";
    const quote = await cvm.quote(now);
    expect(quote.cpuQuote).toBe(`gateway-session:${policy.servingImageId}`);
    await cvm.releaseKeys(quote, vendor.address, now);
    const result = await cvm.infer(prompt, { attRef: sha256Hex(quote.signature) }, now);
    expect(result.output.toString()).toBe("Verified provider answer");
    expect(inference).toHaveBeenCalledExactlyOnceWith(prompt);
    expect(source.inference).not.toHaveBeenCalled();
  });

  it("preserves managed admission on policy rotation and requires a new descriptor", async () => {
    const { cvm, vendor, quote, context } = await ready();
    const next = cvm.withPolicy({ ...policy, version: policy.version + 1 });
    expect(next.config.gatewayMode).toBe("managed-near");
    expect(next.config.verifiedInference).toBe(cvm.config.verifiedInference);
    await expect(next.releaseKeys(quote, vendor.address, now)).rejects.toMatchObject({ code: "ATTESTATION_FAILED" });
    const nextQuote = await next.quote(now);
    await next.releaseKeys(nextQuote, vendor.address, now);
    await expect(next.infer(prompt, context, now)).rejects.toMatchObject({ code: "ATTESTATION_FAILED" });
    expect(next.sessionSecret("same-session")).not.toEqual(cvm.sessionSecret("same-session"));
  });
});

describe("managed NEAR mandatory verified execution", () => {
  it("invokes the provider and signs its exact output and separate evidence binding", async () => {
    const inference = vi.fn<NearInferenceAdapter>().mockImplementation(providerResult);
    const { cvm, context } = await ready(inference);
    const result = await cvm.infer(prompt, context, now);
    expect(inference).toHaveBeenCalledExactlyOnceWith(prompt);
    expect(result.output.toString()).toBe("Verified provider answer");
    expect(result.receipt).toMatchObject({ modelHash: sha256Hex(`model:${config.modelId}`), inHash: sha256Hex(prompt), outHash: sha256Hex(result.output) });
    expect(result.providerTranscript?.requestBody).toBeInstanceOf(Buffer);
    expect(result.providerTranscript?.responseBody).toBeInstanceOf(Buffer);
    expect(result.providerProof?.evidence.signingAddress).toBe(provider.address);
    expect(await receipts.verifyReceiptSignature(result.receipt, cvm.enclaveAddress, config.chainId, config.verifyingContract)).toBe(true);
    expect(await verifyProviderProof(result.providerProof!, result.receipt, cvm.enclaveAddress, config.chainId, config.verifyingContract)).toBe(true);
  });

  it("returns no receipt or echo output when the provider verifier fails", async () => {
    const inference = vi.fn<NearInferenceAdapter>().mockRejectedValue(new Error("provider CPU/GPU attestation rejected"));
    const { cvm, context } = await ready(inference);
    const sign = vi.spyOn(receipts, "signReceipt");
    await expect(cvm.infer(prompt, context, now)).rejects.toThrow("provider CPU/GPU attestation rejected");
    expect(inference).toHaveBeenCalledExactlyOnceWith(prompt);
    expect(sign).not.toHaveBeenCalled();
  });

  it("checks new provider evidence after slow attestation completes", async () => {
    const candidate = await providerResult();
    candidate.evidence.verifiedAt = new Date(now + 40_000).toISOString();
    candidate.evidence.expiresAt = new Date(now + 100_000).toISOString();
    const { cvm, context } = await ready(async () => candidate);
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(40_000);
    const result = await cvm.infer(prompt, context, now);
    expect(result.output.toString()).toBe("Verified provider answer");
    expect(result.providerProof?.evidence.verifiedAt).toBe(candidate.evidence.verifiedAt);
  });

  it("refuses evidence that expires while inference is running", async () => {
    const candidate = await providerResult();
    candidate.evidence.expiresAt = new Date(now + 1_000).toISOString();
    const { cvm, context } = await ready(async () => candidate);
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(2_000);
    const sign = vi.spyOn(receipts, "signReceipt");
    await expect(cvm.infer(prompt, context, now)).rejects.toThrow("not fresh");
    expect(sign).not.toHaveBeenCalled();
  });

  it.each(["missing-transcript", "missing-evidence", "wrong-output", "wrong-input", "wrong-signature", "expired", "future"])(
    "rejects %s evidence before signing a receipt", async (kind) => {
      const candidate = await providerResult(kind === "wrong-input" ? Buffer.from("different input") : prompt);
      // REASON: The adapter boundary can return malformed runtime values despite its TypeScript contract.
      if (kind === "missing-transcript") Reflect.deleteProperty(candidate, "transcript");
      if (kind === "missing-evidence") Reflect.deleteProperty(candidate, "evidence");
      if (kind === "wrong-output") candidate.output = Buffer.from("echo instead of verified answer");
      if (kind === "wrong-signature") candidate.evidence.signature = "0x00";
      if (kind === "expired") candidate.evidence.expiresAt = new Date(now).toISOString();
      if (kind === "future") {
        candidate.evidence.verifiedAt = new Date(now + 60_000).toISOString();
        candidate.evidence.expiresAt = new Date(now + 120_000).toISOString();
      }
      const { cvm, context } = await ready(async () => candidate);
      const sign = vi.spyOn(receipts, "signReceipt");
      await expect(cvm.infer(prompt, context, now)).rejects.toThrow();
      expect(sign).not.toHaveBeenCalled();
    });
});
