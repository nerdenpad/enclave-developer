import { describe, expect, it } from "vitest";
import {
  AttestationFailedError,
  createVendorRoots,
  isGpuCcWithoutCpuTee,
  issueQuote,
  measurementOf,
  verifyQuote,
  type TcbPolicy,
} from "./index.js";

const policy: TcbPolicy = {
  version: 2,
  servingImageId: "signed-v2",
  requireCpuTee: true,
  requireGpuCc: true,
};
const now = 1_800_000_000_000;

describe("attestation trust and time boundaries", () => {
  it("verifies a fresh quote without requiring the verifier to possess a private key", async () => {
    const vendor = await createVendorRoots();
    const quote = await issueQuote(vendor, policy, now);
    await expect(verifyQuote(quote, policy, vendor.address, now)).resolves.toBeUndefined();
    await expect(issueQuote({ address: vendor.address }, policy, now)).rejects.toBeInstanceOf(AttestationFailedError);
  });

  it.each([-300_000, 300_000])("accepts the documented five-minute time-skew boundary %i", async (delta) => {
    const vendor = await createVendorRoots();
    const quote = await issueQuote(vendor, policy, now + delta);
    await expect(verifyQuote(quote, policy, vendor.address, now)).resolves.toBeUndefined();
  });

  it.each([-300_001, 300_001])("rejects a quote outside the permitted time window %i", async (delta) => {
    const vendor = await createVendorRoots();
    const quote = await issueQuote(vendor, policy, now + delta);
    await expect(verifyQuote(quote, policy, vendor.address, now)).rejects.toBeInstanceOf(AttestationFailedError);
  });

  it.each(["cpuQuote", "gpuQuote"] as const)("requires a nonempty %s", async (field) => {
    const vendor = await createVendorRoots();
    const quote = await issueQuote(vendor, policy, now);
    await expect(verifyQuote({ ...quote, [field]: "" }, policy, vendor.address, now)).rejects.toBeInstanceOf(AttestationFailedError);
  });

  it.each(["cpuQuote", "gpuQuote"] as const)("detects modifications to signed %s", async (field) => {
    const vendor = await createVendorRoots();
    const quote = await issueQuote(vendor, policy, now);
    await expect(verifyQuote({ ...quote, [field]: `${quote[field]}-modified` }, policy, vendor.address, now)).rejects.toBeInstanceOf(AttestationFailedError);
  });

  it.each(["requireCpuTee", "requireGpuCc"] as const)("rejects disabling %s in the policy", async (field) => {
    const vendor = await createVendorRoots();
    const quote = await issueQuote(vendor, policy, now);
    const weakened = { ...policy, [field]: false } as TcbPolicy;
    await expect(verifyQuote(quote, weakened, vendor.address, now)).rejects.toBeInstanceOf(AttestationFailedError);
  });

  it("binds measurement to both policy version and image", () => {
    expect(measurementOf(policy)).not.toBe(measurementOf({ ...policy, version: policy.version + 1 }));
    expect(measurementOf(policy)).not.toBe(measurementOf({ ...policy, servingImageId: "modified" }));
  });

  it.each(["0x00", "0x123", `0x${"00".repeat(65)}`] as const)("rejects malformed signatures as an attestation failure %#", async (signature) => {
    const vendor = await createVendorRoots();
    const quote = await issueQuote(vendor, policy, now);
    await expect(verifyQuote({ ...quote, signature }, policy, vendor.address, now)).rejects.toBeInstanceOf(AttestationFailedError);
  });

  it("recognizes GPU-only quotes without accepting empty or composite evidence as GPU-only", () => {
    expect(isGpuCcWithoutCpuTee({ cpuQuote: "", gpuQuote: "gpu" })).toBe(true);
    expect(isGpuCcWithoutCpuTee({ cpuQuote: "cpu", gpuQuote: "gpu" })).toBe(false);
    expect(isGpuCcWithoutCpuTee({ cpuQuote: "", gpuQuote: "" })).toBe(false);
    expect(isGpuCcWithoutCpuTee({ cpuQuote: "cpu", gpuQuote: "" })).toBe(false);
  });
});
