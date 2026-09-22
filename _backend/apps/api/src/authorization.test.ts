import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ValidationError } from "@enclave/core";
import { authorizationData, authorizationTypes, validateAuthorization } from "./authorization.js";
import { loadConfig } from "./config.js";
import type { PaymentAuthorization } from "./chain.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
const paymentId = "10000000-0000-4000-8000-000000000001";
const amount = 123_456n;
const now = 1_800_000_000n;
const config = loadConfig({
  DATABASE_URL: "postgres://unit.invalid/enclave", NODE_ENV: "test", PAYMENT_MODE: "authorized",
  ARC_CHAIN_ID: "5042002", USDC_ADDRESS: "0x0000000000000000000000000000000000000100",
  USAGE_METER_ADDRESS: "0x0000000000000000000000000000000000000200",
});

async function signed(options: { after?: bigint; before?: bigint; data?: ReturnType<typeof authorizationData>; signer?: typeof account } = {}): Promise<PaymentAuthorization> {
  const validAfter = (options.after ?? now - 10n).toString();
  const validBefore = (options.before ?? now + 100n).toString();
  const data = options.data ?? authorizationData(config, paymentId, amount, account.address, validAfter, validBefore);
  return { from: account.address, validAfter, validBefore, signature: await (options.signer ?? account).signTypedData(data) };
}

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Number(now) * 1000); });
afterEach(() => { vi.restoreAllMocks(); });

describe("ERC-3009 USDC receive authorization", () => {
  it("uses the exact ERC-3009 ReceiveWithAuthorization type hash and token domain", () => {
    const signature = `ReceiveWithAuthorization(${authorizationTypes.ReceiveWithAuthorization.map((field) => `${field.type} ${field.name}`).join(",")})`;
    expect(keccak256(stringToHex(signature))).toBe("0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8");
    const data = authorizationData(config, paymentId, amount, account.address, "0", String(now + 100n));
    expect(data.domain).toEqual({ name: "USD Coin", version: "2", chainId: 5042002, verifyingContract: config.USDC_ADDRESS });
    expect(data.primaryType).toBe("ReceiveWithAuthorization");
    expect(data.message).toEqual({ from: account.address, to: config.USAGE_METER_ADDRESS, value: amount, validAfter: 0n, validBefore: now + 100n, nonce: keccak256(stringToHex(paymentId)) });
  });

  it("accepts a valid payer-signed authorization for the exact payment", async () => {
    await expect(validateAuthorization(config, paymentId, amount, await signed())).resolves.toBeUndefined();
  });

  it.each([[-100n, 0n], [-100n, -1n], [0n, 100n], [1n, 100n]])("rejects expired/not-yet-valid exact boundary %#", async (after, before) => {
    const auth = await signed({ after: now + after, before: now + before });
    await expect(validateAuthorization(config, paymentId, amount, auth)).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts the interior of a one-second validity interval", async () => {
    await expect(validateAuthorization(config, paymentId, amount, await signed({ after: now - 1n, before: now + 1n }))).resolves.toBeUndefined();
  });

  it("rejects a signature from another payer and a changed declared payer", async () => {
    await expect(validateAuthorization(config, paymentId, amount, await signed({ signer: stranger }))).rejects.toBeInstanceOf(ValidationError);
    await expect(validateAuthorization(config, paymentId, amount, { ...await signed(), from: stranger.address })).rejects.toBeInstanceOf(ValidationError);
  });

  it("binds nonce to the payment ID and value to the exact USDC amount", async () => {
    const auth = await signed();
    await expect(validateAuthorization(config, "10000000-0000-4000-8000-000000000002", amount, auth)).rejects.toBeInstanceOf(ValidationError);
    await expect(validateAuthorization(config, paymentId, amount + 1n, auth)).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    { ARC_CHAIN_ID: config.ARC_CHAIN_ID + 1 },
    { USDC_ADDRESS: "0x0000000000000000000000000000000000000300" },
    { USAGE_METER_ADDRESS: "0x0000000000000000000000000000000000000400" },
    { USDC_EIP712_NAME: "Other token" },
    { USDC_EIP712_VERSION: "1" },
  ])("rejects signatures from another chain, token, recipient or domain %#", async (overrides) => {
    const data = authorizationData({ ...config, ...overrides }, paymentId, amount, account.address, String(now - 10n), String(now + 100n));
    await expect(validateAuthorization(config, paymentId, amount, await signed({ data }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a signature that authorizes TransferWithAuthorization instead of receive", async () => {
    const data = authorizationData(config, paymentId, amount, account.address, String(now - 10n), String(now + 100n));
    const signature = await account.signTypedData({ ...data, primaryType: "TransferWithAuthorization", types: { TransferWithAuthorization: authorizationTypes.ReceiveWithAuthorization } });
    await expect(validateAuthorization(config, paymentId, amount, { from: account.address, validAfter: String(now - 10n), validBefore: String(now + 100n), signature })).rejects.toBeInstanceOf(ValidationError);
  });

  it.each(["0x", "0x00", "0x123", `0x${"00".repeat(65)}`])("rejects malformed ECDSA signatures without leaking crypto errors %#", async (signature) => {
    await expect(validateAuthorization(config, paymentId, amount, { ...await signed(), signature: signature as Hex })).rejects.toMatchObject({
      statusCode: 400, code: "VALIDATION_FAILED", details: { authorization: "Invalid, expired, or mismatched USDC receive authorization" },
    });
  });

  it("rejects a noncanonical high-s signature even if it recovers the signer", async () => {
    const auth = await signed();
    const r = auth.signature.slice(2, 66);
    const s = BigInt(`0x${auth.signature.slice(66, 130)}`);
    const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const v = Number.parseInt(auth.signature.slice(130), 16);
    const malleated = `0x${r}${(order - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    await expect(validateAuthorization(config, paymentId, amount, { ...auth, signature: malleated })).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([0, 1, 2, 26, 29, 255])("rejects a noncanonical recovery ID %i before token submission", async (v) => {
    const auth = await signed();
    const signature = `${auth.signature.slice(0, 130)}${v.toString(16).padStart(2, "0")}` as Hex;
    await expect(validateAuthorization(config, paymentId, amount, { ...auth, signature })).rejects.toBeInstanceOf(ValidationError);
  });

  it.each(["-1", "", "1.5", "0x10", "Infinity", (1n << 256n).toString()])("rejects invalid uint256 validity fields %#", async (value) => {
    const auth = await signed();
    await expect(validateAuthorization(config, paymentId, amount, { ...auth, validAfter: value })).rejects.toBeInstanceOf(ValidationError);
    await expect(validateAuthorization(config, paymentId, amount, { ...auth, validBefore: value })).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([0n, -1n, 1n << 256n])("rejects unpayable amounts %s before presenting typed data", (value) => {
    expect(() => authorizationData(config, paymentId, value, account.address, "0", String(now + 100n))).toThrow(ValidationError);
  });

  it("rejects empty payment IDs, invalid payers and inverted validity windows", () => {
    expect(() => authorizationData(config, "", amount, account.address, "0", "1")).toThrow(ValidationError);
    expect(() => authorizationData(config, paymentId, amount, "0x123", "0", "1")).toThrow(ValidationError);
    expect(() => authorizationData(config, paymentId, amount, "0x0000000000000000000000000000000000000000", "0", "1")).toThrow(ValidationError);
    expect(() => authorizationData(config, paymentId, amount, account.address, "1", "1")).toThrow(ValidationError);
  });
});
