import { describe, expect, it } from "vitest";
import {
  AttestationFailedError,
  DevCvm,
  KeyNotReleasedError,
  MandateBreachError,
  createVendorRoots,
  decryptAesGcm,
  encryptAesGcm,
  fromHex,
  issueQuote,
  nextTcbVersion,
  paymentRequiredBody,
  reserveMandate,
  sha256Hex,
  usdcToUnits,
  verifyQuote,
  type TcbPolicy,
} from "./index.js";

const policy: TcbPolicy = {
  version: 1,
  servingImageId: "enclave-echo-v1",
  requireCpuTee: true,
  requireGpuCc: true,
};
const config = {
  policy,
  modelId: "echo",
  chainId: 31337,
  verifyingContract: "0x0000000000000000000000000000000000000100" as const,
};
const now = 1_800_000_000_000;

describe("security regressions", () => {
  it("pins key release to the CVM vendor root, even with a valid attacker-signed quote", async () => {
    const trusted = await createVendorRoots();
    const attacker = await createVendorRoots();
    const cvm = await DevCvm.create(config, trusted);
    const malicious = await issueQuote(attacker, policy, now);
    await expect(cvm.releaseKeys(malicious, attacker.address, now)).rejects.toBeInstanceOf(AttestationFailedError);
    expect(cvm.keysReleased()).toBe(false);
    await expect(cvm.infer(Buffer.from("private"), { attRef: sha256Hex(malicious.signature) }, now)).rejects.toBeInstanceOf(KeyNotReleasedError);
    expect(() => cvm.sessionSecret("session")).toThrow(KeyNotReleasedError);
  });

  it("keeps persisted sealed memory confidential until the new CVM attests", async () => {
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create(config, vendor);
    const memory = cvm.sealMemory(Buffer.from("private agent memory"));
    expect(() => cvm.openMemory(memory)).toThrow(KeyNotReleasedError);
    await cvm.releaseKeys(await cvm.quote(now), vendor.address, now);
    expect(cvm.openMemory(memory).toString()).toBe("private agent memory");
  });

  it.each([NaN, Infinity, -Infinity, -1, 1.5])("rejects a signed quote with invalid timestamp %s", async (timestamp) => {
    const vendor = await createVendorRoots();
    const quote = await issueQuote(vendor, policy, timestamp);
    await expect(verifyQuote(quote, policy, vendor.address, now)).rejects.toBeInstanceOf(AttestationFailedError);
  });

  it("rejects an invalid verifier clock instead of bypassing expiration", async () => {
    const vendor = await createVendorRoots();
    const quote = await issueQuote(vendor, policy, now);
    await expect(verifyQuote(quote, policy, vendor.address, NaN)).rejects.toBeInstanceOf(AttestationFailedError);
  });

  it.each([4, 8, 12, 13, 14, 15])("rejects a shortened %i-byte GCM authentication tag", (length) => {
    const key = Buffer.alloc(32, 7);
    const blob = encryptAesGcm(key, Buffer.from("authenticated private input"));
    const truncated = { ...blob, tag: Buffer.from(blob.tag, "base64").subarray(0, length).toString("base64") };
    expect(() => decryptAesGcm(key, truncated)).toThrow();
  });

  it.each(["zz", "0x12gg", "0x12 3", "0x12\n", "0x0g", "0x123"])("rejects invalid hex instead of partially decoding %j", (value) => {
    expect(() => fromHex(value)).toThrow();
  });

  it("does not let negative reservations replenish the daily mandate", () => {
    const row = { dailyLimitUnits: 100n, spentTodayUnits: 90n, dayKey: "2026-09-16" };
    expect(() => reserveMandate(row, row.dayKey, -50n)).toThrow(MandateBreachError);
    expect(row.spentTodayUnits).toBe(90n);
  });

  it.each([
    { dailyLimitUnits: -1n, spentTodayUnits: 0n },
    { dailyLimitUnits: 100n, spentTodayUnits: -10n },
  ])("rejects corrupted mandate balances %#", (balance) => {
    expect(() => reserveMandate({ ...balance, dayKey: "2026-09-16" }, "2026-09-16", 1n)).toThrow(MandateBreachError);
  });

  it.each([-1, -0.0000001, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER])("rejects invalid or imprecise USDC amount %s", (amount) => {
    expect(() => usdcToUnits(amount)).toThrow();
  });

  it("rejects a negative x402 payment challenge", () => {
    expect(() => paymentRequiredBody({
      amountUnits: -1n,
      network: "arc-31337",
      payTo: config.verifyingContract,
      asset: config.verifyingContract,
      paymentId: "payment",
    })).toThrow();
  });

  it.each([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])("rejects a TCB version that cannot be safely incremented: %s", (version) => {
    expect(() => nextTcbVersion(version)).toThrow();
  });
});
