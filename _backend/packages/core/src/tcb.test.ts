import { describe, expect, it } from "vitest";
import {
  AttestationFailedError,
  createVendorRoots,
  issueQuote,
  nextTcbVersion,
  tcbPolicyRecord,
  verifyQuote,
  canonicalTcbPolicy,
  parseTcbPolicy,
  tcbPolicyHash,
  DevCvm,
  sha256Hex,
  type TcbPolicy,
} from "./index.js";

const v1: TcbPolicy = {
  version: 1,
  servingImageId: "enclave-echo-v1",
  requireCpuTee: true,
  requireGpuCc: true,
};

describe("tcb policy versioning", () => {
  it("increments versions and records a new measurement", () => {
    expect(nextTcbVersion(1)).toBe(2);
    const next = tcbPolicyRecord({ ...v1, version: 2 });
    expect(next.version).toBe(2);
    expect(next.measurement).not.toBe(tcbPolicyRecord(v1).measurement);
  });

  it("rejects a quote whose tcbVersion does not match even when measurement is current", async () => {
    const vendor = await createVendorRoots();
    const v2 = { ...v1, version: 2 };
    const quote = await issueQuote(vendor, v2);
    await expect(verifyQuote({ ...quote, tcbVersion: 1 }, v2, vendor.address)).rejects.toBeInstanceOf(AttestationFailedError);
  });
});

describe("immutable software policy commitments", () => {
  it("commits the complete policy in a fixed order and snapshots parsed values", () => {
    expect(canonicalTcbPolicy(v1)).toBe('{"version":1,"servingImageId":"enclave-echo-v1","requireCpuTee":true,"requireGpuCc":true}');
    expect(tcbPolicyHash(v1)).toBe(sha256Hex(canonicalTcbPolicy(v1)));
    expect(tcbPolicyHash({ ...v1, version: 2 })).not.toBe(tcbPolicyHash(v1));
    expect(tcbPolicyHash({ ...v1, servingImageId: "next-image" })).not.toBe(tcbPolicyHash(v1));
    expect(parseTcbPolicy(JSON.stringify({ requireGpuCc: true, servingImageId: v1.servingImageId, requireCpuTee: true, version: 1 }))).toEqual(v1);
  });

  it.each([null, [], {}, { ...v1, version: 0 }, { ...v1, version: 1.5 }, { ...v1, version: Number.MAX_SAFE_INTEGER + 1 },
    { ...v1, servingImageId: " " }, { ...v1, servingImageId: "x".repeat(81) }, { ...v1, servingImageId: "image\n" },
    { ...v1, requireGpuCc: false }, { ...v1, requireCpuTee: false }, { ...v1, hardwareAllowlist: "override" },
  ])("rejects invalid or additional policy fields %#", (value) => {
    expect(() => parseTcbPolicy(JSON.stringify(value))).toThrow();
  });

  it("forks the full CVM boundary, preserves sealed memory and signer, and retires old session admission", async () => {
    const vendor = await createVendorRoots();
    const inference = async (input: Buffer) => Buffer.from(input);
    const cvm = await DevCvm.create({ policy: v1, modelId: "test", chainId: 31337,
      verifyingContract: `0x${"12".repeat(20)}`, inference }, vendor);
    const oldQuote = await cvm.quote();
    await cvm.releaseKeys(oldQuote, vendor.address);
    const sealed = cvm.sealMemory(Buffer.from("durable sealed memory"));
    const oldSecret = cvm.sessionSecret("same-session-id");
    const nextPolicy = { ...v1, version: 2, servingImageId: "next-image" };
    const next = cvm.withPolicy(nextPolicy);
    nextPolicy.servingImageId = "mutation";
    expect(next.config.policy.servingImageId).toBe("next-image");
    expect(next.config.inference).toBe(inference);
    expect(next.enclaveAddress).toBe(cvm.enclaveAddress);
    expect(next.modelHash).toBe(cvm.modelHash);
    expect(next.codeHash).not.toBe(cvm.codeHash);
    expect(next.keysReleased()).toBe(false);
    await expect(next.releaseKeys(oldQuote, vendor.address)).rejects.toThrow();
    const newQuote = await next.quote();
    await next.releaseKeys(newQuote, vendor.address);
    expect(next.sessionSecret("same-session-id")).not.toEqual(oldSecret);
    expect(next.openMemory(sealed).toString()).toBe("durable sealed memory");
    await expect(next.infer(Buffer.from("prompt"), { attRef: sha256Hex(oldQuote.signature) })).rejects.toThrow("not verified");
    const result = await next.infer(Buffer.from("prompt"), { attRef: sha256Hex(newQuote.signature) });
    expect(result.receipt).toMatchObject({ receiptVersion: 2, codeHash: next.codeHash, attRef: sha256Hex(newQuote.signature) });
    expect(result.output.toString()).toBe("prompt");
  });

  it("preserves the exact remote verifier adapter without rewriting its hardware policy", async () => {
    const vendor = await createVendorRoots();
    const verifiedInference = async () => { throw new Error("do not invoke remote inference"); };
    const cvm = await DevCvm.create({ policy: v1, modelId: "near-model", chainId: 31337,
      verifyingContract: `0x${"12".repeat(20)}`, verifiedInference }, vendor);
    const next = cvm.withPolicy({ ...v1, version: 2 });
    expect(next.config.verifiedInference).toBe(verifiedInference);
    expect(next.config.inference).toBeUndefined();
  });
});
