import { describe, expect, it } from "vitest";
import {
  AttestationFailedError,
  KeyNotReleasedError,
  TamperedImageError,
  createVendorRoots,
  DevCvm,
  decryptAesGcm,
  encryptAesGcm,
  issueQuote,
  measurementOf,
  sha256Hex,
  verifyQuote,
  verifyReceiptSignature,
  type TcbPolicy,
} from "./index.js";

const policy: TcbPolicy = {
  version: 1,
  servingImageId: "enclave-echo-v1",
  requireCpuTee: true,
  requireGpuCc: true,
};

const verifyingContract = "0x0000000000000000000000000000000000000001" as const;

describe("attestation", () => {
  it("releases no keys when the quote signature is wrong", async () => {
    const vendor = await createVendorRoots();
    const other = await createVendorRoots();
    const cvm = await DevCvm.create(
      { policy, modelId: "echo", chainId: 31337, verifyingContract },
      vendor,
    );
    const quote = await cvm.quote();
    await expect(cvm.releaseKeys(quote, other.address)).rejects.toBeInstanceOf(AttestationFailedError);
    expect(cvm.keysReleased()).toBe(false);
    await expect(cvm.infer(Buffer.from("secret prompt"), { attRef: sha256Hex(quote.signature) })).rejects.toBeInstanceOf(KeyNotReleasedError);
  });

  it("rejects a tampered serving image measurement", async () => {
    const vendor = await createVendorRoots();
    if (!vendor.privateKey) throw new Error("expected issuer key");
    const quote = await issueQuote(vendor, policy);
    const bad = { ...quote, measurement: measurementOf({ ...policy, servingImageId: "evil-image" }) };
    await expect(verifyQuote(bad, policy, vendor.address)).rejects.toBeInstanceOf(TamperedImageError);
  });

  it("rejects GPU-CC without a CPU TEE quote", async () => {
    const vendor = await createVendorRoots();
    const quote = await issueQuote(vendor, policy);
    const broken = { ...quote, cpuQuote: "" };
    await expect(verifyQuote(broken, policy, vendor.address)).rejects.toBeInstanceOf(AttestationFailedError);
  });

  it("rejects an expired quote before keys can be released", async () => {
    const vendor = await createVendorRoots();
    const quote = await issueQuote(vendor, policy, Date.now() - 6 * 60_000);
    await expect(verifyQuote(quote, policy, vendor.address)).rejects.toBeInstanceOf(AttestationFailedError);
  });
});

describe("cvm + receipts", () => {
  it("mints a signed receipt only after attestation and never returns plaintext hashes of unreleased keys", async () => {
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create(
      { policy, modelId: "echo", chainId: 31337, verifyingContract },
      vendor,
    );
    const quote = await cvm.quote();
    await cvm.releaseKeys(quote, vendor.address);
    const prompt = Buffer.from("do not log me");
    const { output, receipt } = await cvm.infer(prompt, { attRef: sha256Hex(quote.signature) });
    expect(output).toHaveLength(32);
    expect(receipt.modelHash.startsWith("0x")).toBe(true);
    const ok = await verifyReceiptSignature(receipt, cvm.enclaveAddress, 31337, verifyingContract);
    expect(ok).toBe(true);
  });

  it("round-trips AES-GCM used for encrypted prompts", () => {
    const key = Buffer.alloc(32, 7);
    const blob = encryptAesGcm(key, Buffer.from("hello"));
    expect(decryptAesGcm(key, blob).toString("utf8")).toBe("hello");
  });

  it("never enumerates wrapping, model, or enclave keys on the CVM object", async () => {
    const vendor = await createVendorRoots();
    const wrappingKey = Buffer.alloc(32, 9);
    const modelKey = Buffer.alloc(32, 11);
    const cvm = await DevCvm.create(
      { policy, modelId: "echo", chainId: 31337, verifyingContract },
      vendor,
      { wrappingKey, modelKey, enclavePrivateKey: vendor.privateKey as `0x${string}` },
    );
    const dumped = JSON.stringify(cvm);
    expect(dumped).not.toContain("wrappingKey");
    expect(dumped).not.toContain("modelKey");
    expect(dumped).not.toContain("enclavePrivateKey");
    expect(dumped).not.toContain(wrappingKey.toString("hex"));
    expect(dumped).not.toContain(modelKey.toString("hex"));
    expect(cvm.keysReleased()).toBe(false);
  });
});
