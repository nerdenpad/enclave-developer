import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash.js";
import { hashesForIo, receiptDomain, receiptTypedHash, signReceipt, verifyReceiptSignature, type InferenceReceiptV2, type LegacyInferenceReceipt } from "./receipt.js";

const privateKey = `0x${"11".repeat(32)}` as const;
const signer = privateKeyToAccount(privateKey).address;
const contract = "0x0000000000000000000000000000000000000100" as const;
const anotherContract = "0x0000000000000000000000000000000000000200" as const;
const chainId = 31337;
const receipt: InferenceReceiptV2 = {
  receiptVersion: 2,
  nonce: sha256Hex("invocation nonce"),
  modelHash: sha256Hex("model weights"),
  codeHash: sha256Hex("serving image"),
  inHash: sha256Hex("input"),
  outHash: sha256Hex("output"),
  attRef: sha256Hex("attestation"),
  ts: 1_800_000_000n,
};

describe("EIP-712 inference receipts", () => {
  it("round-trips a signed receipt and preserves the unsigned input", async () => {
    const signed = await signReceipt(receipt, privateKey, chainId, contract);
    expect(signed).toMatchObject(receipt);
    expect(signed.sig).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(receipt).not.toHaveProperty("sig");
    expect(await verifyReceiptSignature(signed, signer, chainId, contract)).toBe(true);
    expect(await verifyReceiptSignature(signed, signer.toLowerCase() as `0x${string}`, chainId, contract)).toBe(true);
    expect(receiptDomain(chainId, contract)).toEqual({ name: "ENCLAVE", version: "2", chainId, verifyingContract: contract });
    expect(receiptTypedHash(signed, chainId, contract)).toBe(receiptTypedHash(receipt, chainId, contract));
  });

  it.each(["modelHash", "codeHash", "inHash", "outHash", "attRef", "nonce"] as const)("binds signed %s", async (field) => {
    const signed = await signReceipt(receipt, privateKey, chainId, contract);
    const tampered = { ...signed, [field]: sha256Hex("tampered") };
    expect(await verifyReceiptSignature(tampered, signer, chainId, contract)).toBe(false);
    expect(receiptTypedHash(tampered, chainId, contract)).not.toBe(receiptTypedHash(receipt, chainId, contract));
  });

  it("binds the timestamp", async () => {
    const signed = await signReceipt(receipt, privateKey, chainId, contract);
    const tampered = { ...signed, ts: signed.ts + 1n };
    expect(await verifyReceiptSignature(tampered, signer, chainId, contract)).toBe(false);
    expect(receiptTypedHash(tampered, chainId, contract)).not.toBe(receiptTypedHash(receipt, chainId, contract));
  });

  it("prevents replay on another chain or verifier contract", async () => {
    const signed = await signReceipt(receipt, privateKey, chainId, contract);
    expect(await verifyReceiptSignature(signed, signer, chainId + 1, contract)).toBe(false);
    expect(await verifyReceiptSignature(signed, signer, chainId, anotherContract)).toBe(false);
    expect(receiptTypedHash(receipt, chainId + 1, contract)).not.toBe(receiptTypedHash(receipt, chainId, contract));
    expect(receiptTypedHash(receipt, chainId, anotherContract)).not.toBe(receiptTypedHash(receipt, chainId, contract));
  });

  it("rejects a different signer and malformed signatures", async () => {
    const signed = await signReceipt(receipt, privateKey, chainId, contract);
    const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`).address;
    expect(await verifyReceiptSignature(signed, stranger, chainId, contract)).toBe(false);
    await expect(verifyReceiptSignature({ ...signed, sig: "0x00" }, signer, chainId, contract)).rejects.toThrow();
  });

  it("hashes the original input and output bytes independently", () => {
    const io = hashesForIo(Buffer.from("abc"), Buffer.alloc(0));
    expect(io).toEqual({
      inHash: "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      outHash: "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
  });

  it("verifies explicitly versioned legacy receipts under domain v1 only", async () => {
    const { nonce: _nonce, receiptVersion: _version, ...fields } = receipt;
    const legacy: LegacyInferenceReceipt = { ...fields, receiptVersion: 1 };
    const signed = await signReceipt(legacy, privateKey, chainId, contract);
    expect(await verifyReceiptSignature(signed, signer, chainId, contract)).toBe(true);
    expect(receiptDomain(chainId, contract, 1).version).toBe("1");
    expect(receiptTypedHash(legacy, chainId, contract)).not.toBe(receiptTypedHash(receipt, chainId, contract));
    expect(await verifyReceiptSignature({ ...signed, receiptVersion: 2, nonce: receipt.nonce }, signer, chainId, contract)).toBe(false);
    const current = await signReceipt(receipt, privateKey, chainId, contract);
    expect(await verifyReceiptSignature({ ...legacy, sig: current.sig }, signer, chainId, contract)).toBe(false);
  });

  it("rejects unsupported receipt versions instead of interpreting them as v2", () => {
    expect(() => receiptDomain(chainId, contract, 3 as 2)).toThrow("Unsupported receipt version");
  });
});
