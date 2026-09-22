import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalEvidenceJson, providerEvidenceHash, signProviderProof, verifyProviderProof, type ProviderProof } from "./provider-proof.js";
import { signReceipt, receiptTypedHash, type SignedReceipt } from "./receipt.js";
import { sha256Hex } from "./hash.js";
import { verifyNearTranscript, type NearInferenceEvidence } from "./near-inference.js";

const privateKey = `0x${"42".repeat(32)}` as const;
const signer = privateKeyToAccount(privateKey);
const otherKey = `0x${"43".repeat(32)}` as const;
const chain = 31337;
const contract = "0x0000000000000000000000000000000000000100" as const;
const otherContract = "0x0000000000000000000000000000000000000200" as const;

function evidence(): NearInferenceEvidence {
  return { schemaVersion: 1, provider: "near", signatureKind: "provider_tee", endpoint: "https://test.completions.near.ai",
    model: "Qwen/Test", completionId: "completion-1", requestHash: sha256Hex("raw request"), responseHash: sha256Hex("raw response"),
    outputHash: sha256Hex("answer"), signatureText: "not hardware evidence", signature: "0x00", signingAddress: signer.address,
    attestationRef: sha256Hex("attestation"), verifiedAt: new Date(1000).toISOString(), expiresAt: new Date(2000).toISOString(), tlsBound: true };
}

async function receipt(overrides: Partial<SignedReceipt> = {}): Promise<SignedReceipt> {
  return signReceipt({ receiptVersion: 2, modelHash: sha256Hex("model:Qwen/Test"), codeHash: sha256Hex("development code"),
    inHash: sha256Hex("prompt"), outHash: sha256Hex("answer"), attRef: sha256Hex("software quote"), nonce: sha256Hex("nonce1"), ts: 1000n,
    ...overrides }, privateKey, chain, contract);
}

describe("canonical provider evidence", () => {
  it("orders nested object keys while retaining array order and exact JSON strings", () => {
    const value = { z: [true, null, "\n\"🔐", { b: 2, a: 1 }], a: { y: false, x: 1.25 } };
    const canonical = canonicalEvidenceJson(value);
    expect(canonical).toBe('{"a":{"x":1.25,"y":false},"z":[true,null,"\\n\\\"🔐",{"a":1,"b":2}]}');
    expect(JSON.parse(canonical)).toEqual(value);
    expect(canonicalEvidenceJson({ a: [1, 2] })).not.toBe(canonicalEvidenceJson({ a: [2, 1] }));
  });

  it("hashes semantically identical JSON independent of property insertion order", () => {
    const data = evidence();
    const reordered = Object.fromEntries(Object.entries(data).reverse()) as NearInferenceEvidence;
    expect(providerEvidenceHash(reordered)).toBe(providerEvidenceHash(data));
    expect(providerEvidenceHash(data)).toBe(sha256Hex(canonicalEvidenceJson(data)));
  });

  it.each([undefined, NaN, Infinity, -Infinity, 1n, Symbol("value"), () => 1, new Date(), new Map(), new Set(), Buffer.from("bytes"),
    { invalid: undefined }, [undefined], Array(2), Object.create(null)])("rejects non-JSON value %#", (value) => {
    expect(() => canonicalEvidenceJson(value)).toThrow("JSON values only");
  });

  it("rejects cycles, hidden metadata and accessors without invoking getters", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const array: unknown[] = []; array.push(array);
    const getter = { get data() { throw new Error("must never run"); } };
    const withSymbol = { [Symbol("hidden")]: 1 };
    const withHidden = Object.defineProperty({}, "hidden", { value: 1 });
    const extraArray = Object.assign([1], { extra: "ignored" });
    const disguisedHole = Object.assign(Array(1), { extra: "must not replace a missing index" });
    for (const value of [cycle, array, getter, withSymbol, withHidden, extraArray, disguisedHole]) {
      expect(() => canonicalEvidenceJson(value)).toThrow("JSON values only");
    }
  });

  it("allows repeated references without confusing them with cycles and bounds depth", () => {
    const shared = { value: 1 };
    expect(canonicalEvidenceJson([shared, shared])).toBe('[{"value":1},{"value":1}]');
    let nested: unknown = 1;
    for (let i = 0; i < 130; i++) nested = [nested];
    expect(() => canonicalEvidenceJson(nested)).toThrow("JSON values only");
  });
});

describe("receipt/provider evidence association", () => {
  it("signs and recovers the receipt/evidence pair in its own EIP-712 domain", async () => {
    const signed = await receipt();
    const data = evidence();
    const proof = await signProviderProof(signed, data, privateKey, chain, contract);
    expect(proof).toMatchObject({ version: 1, receiptHash: receiptTypedHash(signed, chain, contract), evidenceHash: providerEvidenceHash(data), evidence: data });
    expect(await verifyProviderProof(proof, signed, signer.address, chain, contract)).toBe(true);
    expect(await verifyProviderProof(proof, signed, signer.address.toLowerCase() as `0x${string}`, chain, contract)).toBe(true);
  });

  it("snapshots evidence so later caller mutations do not corrupt a signed proof", async () => {
    const signed = await receipt();
    const data = evidence();
    const proof = await signProviderProof(signed, data, privateKey, chain, contract);
    data.completionId = "mutated";
    expect(proof.evidence.completionId).toBe("completion-1");
    expect(await verifyProviderProof(proof, signed, signer.address, chain, contract)).toBe(true);
  });

  it("rejects an output hash that differs from the signed receipt", async () => {
    await expect(signProviderProof(await receipt(), { ...evidence(), outputHash: sha256Hex("other") }, privateKey, chain, contract)).rejects.toThrow("output does not match");
  });

  it("rejects non-JSON evidence during signing and fails verification without throwing", async () => {
    const signed = await receipt();
    const bad = { ...evidence(), invalid: undefined } as NearInferenceEvidence;
    await expect(signProviderProof(signed, bad, privateKey, chain, contract)).rejects.toThrow("JSON values only");
    const proof = await signProviderProof(signed, evidence(), privateKey, chain, contract);
    expect(await verifyProviderProof({ ...proof, evidence: bad }, signed, signer.address, chain, contract)).toBe(false);
  });

  it.each(["input", "output", "nonce", "attestation", "model", "code", "timestamp", "signature"])("rejects changed receipt %s", async (field) => {
    const signed = await receipt();
    const proof = await signProviderProof(signed, evidence(), privateKey, chain, contract);
    const changes: Record<string, Partial<SignedReceipt>> = {
      input: { inHash: sha256Hex("changed") }, output: { outHash: sha256Hex("changed") }, nonce: { nonce: sha256Hex("changed") },
      attestation: { attRef: sha256Hex("changed") }, model: { modelHash: sha256Hex("changed") }, code: { codeHash: sha256Hex("changed") },
      timestamp: { ts: 999n }, signature: { sig: "0x00" },
    };
    expect(await verifyProviderProof(proof, { ...signed, ...changes[field] } as SignedReceipt, signer.address, chain, contract)).toBe(false);
  });

  it.each(["hash", "evidence", "rehashed-evidence", "output", "signature", "version"])("rejects changed proof %s", async (field) => {
    const signed = await receipt();
    const proof = await signProviderProof(signed, evidence(), privateKey, chain, contract);
    if (field === "hash") proof.evidenceHash = sha256Hex("other");
    if (field === "evidence" || field === "rehashed-evidence") proof.evidence.completionId = "changed";
    if (field === "rehashed-evidence") proof.evidenceHash = providerEvidenceHash(proof.evidence);
    if (field === "output") proof.evidence.outputHash = sha256Hex("other");
    if (field === "signature") proof.sig = "0x00";
    if (field === "version") (proof as { version: number }).version = 2;
    expect(await verifyProviderProof(proof, signed, signer.address, chain, contract)).toBe(false);
  });

  it("rejects replay under another chain, verifying contract, or signer", async () => {
    const signed = await receipt();
    const proof = await signProviderProof(signed, evidence(), privateKey, chain, contract);
    expect(await verifyProviderProof(proof, signed, signer.address, chain + 1, contract)).toBe(false);
    expect(await verifyProviderProof(proof, signed, signer.address, chain, otherContract)).toBe(false);
    expect(await verifyProviderProof(proof, signed, privateKeyToAccount(otherKey).address, chain, contract)).toBe(false);
  });

  it("requires the receipt and evidence binding to have the same signer", async () => {
    const signed = await receipt();
    const proof = await signProviderProof(signed, evidence(), otherKey, chain, contract);
    expect(await verifyProviderProof(proof, signed, signer.address, chain, contract)).toBe(false);
    expect(await verifyProviderProof(proof, signed, privateKeyToAccount(otherKey).address, chain, contract)).toBe(false);
  });

  it("cannot attach a valid proof to a second valid receipt with a new invocation nonce", async () => {
    const first = await receipt();
    const second = await receipt({ nonce: sha256Hex("second invocation") });
    const proof = await signProviderProof(first, evidence(), privateKey, chain, contract);
    expect(await verifyProviderProof(proof, second, signer.address, chain, contract)).toBe(false);
    // This pure verifier is intentionally stateless: repeat reads of the same proof remain valid.
    expect(await verifyProviderProof(proof, first, signer.address, chain, contract)).toBe(true);
    expect(await verifyProviderProof(proof, first, signer.address, chain, contract)).toBe(true);
  });

  it("only verifies an association and does not claim independent hardware or provider verification", async () => {
    const signed = await receipt();
    const proof = await signProviderProof(signed, evidence(), privateKey, chain, contract);
    expect(await verifyProviderProof(proof, signed, signer.address, chain, contract)).toBe(true);
    expect(await verifyNearTranscript(proof.evidence, { requestBody: Buffer.from("raw request"), responseBody: Buffer.from("raw response") })).toBe(false);
  });

  it("returns false for malformed external proof values", async () => {
    expect(await verifyProviderProof(null as unknown as ProviderProof, await receipt(), signer.address, chain, contract)).toBe(false);
  });
});
