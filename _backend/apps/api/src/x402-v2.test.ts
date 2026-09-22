import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ValidationError } from "@enclave/core";
import { caip2, createPaymentRequired, decodePaymentSignature, encodePaymentRequired, encodePaymentResponse, transferTypedData, validateExactPayload, type X402Payload, type TransferAuthorization } from "./x402-v2.js";

const account = privateKeyToAccount(`0x${"19".repeat(32)}`);
const now = 1_800_000_000;
const required = createPaymentRequired({ resourceUrl: "https://enclave.example/v2/inference", paymentId: "10000000-0000-4000-8000-000000000001",
  chainId: 31337, amount: 100_000n, asset: "0x0000000000000000000000000000000000000100", payTo: "0x0000000000000000000000000000000000000200", domainName: "USD Coin", domainVersion: "2" });
function client() { return new x402HTTPClient(new x402Client().register("eip155:31337", new ExactEvmScheme(account))
  .setSpendControls({ allowedAssets: [{ network: "eip155:31337", asset: required.accepts[0].asset, maxAmountPerPayment: required.accepts[0].amount }] })); }
async function signed(): Promise<X402Payload> {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  const httpClient = client();
  const challenge = httpClient.getPaymentRequiredResponse((name: string) => name.toLowerCase() === "payment-required" ? encodePaymentRequired(required) : null);
  const payload = await httpClient.createPaymentPayload(challenge);
  const headers = httpClient.encodePaymentSignatureHeader(payload);
  return decodePaymentSignature(headers["PAYMENT-SIGNATURE"]!);
}
afterEach(() => vi.restoreAllMocks());

describe("real x402 v2 exact EVM SDK interoperability", () => {
  it("decodes our challenge, produces a standard random-nonce Transfer authorization and decodes our receipt", async () => {
    const payload = await signed();
    expect(payload.accepted.extra.enclavePaymentId).toBe(required.accepts[0].extra.enclavePaymentId);
    expect(payload.payload.authorization.validAfter).toBe("0");
    expect(payload.payload.authorization.validBefore).toBe(String(now + 300));
    const authorization = await validateExactPayload(payload, required, { nowSeconds: now });
    expect(authorization.from).toBe(account.address);
    expect(authorization.to.toLowerCase()).toBe(required.accepts[0].payTo.toLowerCase());
    const second = await signed();
    expect(second.payload.authorization.nonce).not.toBe(authorization.nonce);
    const tx = `0x${"ab".repeat(32)}`;
    const response = encodePaymentResponse({ success: true, transaction: tx, payer: account.address, chainId: 31337 });
    expect(client().getPaymentSettleResponse((name: string) => name.toLowerCase() === "payment-response" ? response : null)).toEqual({ success: true, transaction: tx, payer: account.address, network: "eip155:31337" });
  });

  it.each([
    ["scheme", "upto"], ["network", "eip155:1"], ["network", "eip155:031337"], ["amount", "100001"],
    ["asset", "0x0000000000000000000000000000000000000300"], ["payTo", "0x0000000000000000000000000000000000000400"], ["maxTimeoutSeconds", 301],
  ])("rejects changed advertised %s (%s)", async (field, value) => {
    const payload = await signed();
    Object.assign(payload.accepted, { [field]: value });
    await expect(validateExactPayload(payload, required, { nowSeconds: now })).rejects.toBeInstanceOf(ValidationError);
  });
  it.each([["name", "Other USDC"], ["version", "1"], ["assetTransferMethod", "permit2"], ["enclavePaymentId", "10000000-0000-4000-8000-000000000002"]])("rejects changed payment domain/context %s", async (field, value) => {
    const payload = await signed(); Object.assign(payload.accepted.extra, { [field]: value });
    await expect(validateExactPayload(payload, required, { nowSeconds: now })).rejects.toBeInstanceOf(ValidationError);
  });
  it.each(["from", "to", "value", "nonce", "validAfter", "validBefore"])("authenticates signed %s", async (field) => {
    const payload = await signed();
    const replacements: Record<string, string> = { from: "0x0000000000000000000000000000000000000500", to: "0x0000000000000000000000000000000000000500", value: "100001", nonce: `0x${"ff".repeat(32)}`, validAfter: "1", validBefore: String(now + 299) };
    Object.assign(payload.payload.authorization, { [field]: replacements[field] });
    await expect(validateExactPayload(payload, required, { nowSeconds: now })).rejects.toBeInstanceOf(ValidationError);
  });
  it("requires the advertised resource when echoed, and permits the spec's optional resource omission", async () => {
    const payload = await signed();
    payload.resource!.url += "?other";
    await expect(validateExactPayload(payload, required, { nowSeconds: now })).rejects.toBeInstanceOf(ValidationError);
    delete payload.resource;
    await expect(validateExactPayload(payload, required, { nowSeconds: now })).resolves.toMatchObject({ from: account.address });
  });
  it("rejects a valid ReceiveWithAuthorization signature instead of silently relabeling it", async () => {
    const payload = await signed();
    const auth = { ...payload.payload.authorization, signature: payload.payload.signature } as TransferAuthorization;
    const data = transferTypedData(required.accepts[0], auth);
    payload.payload.signature = await account.signTypedData({ ...data, primaryType: "ReceiveWithAuthorization", types: { ReceiveWithAuthorization: data.types.TransferWithAuthorization } });
    await expect(validateExactPayload(payload, required, { nowSeconds: now })).rejects.toBeInstanceOf(ValidationError);
  });
  it("rejects expired and excessive validity but can verify an identical persisted expired authorization", async () => {
    const payload = await signed();
    await expect(validateExactPayload(payload, required, { nowSeconds: now + 300 })).rejects.toBeInstanceOf(ValidationError);
    await expect(validateExactPayload(payload, required, { nowSeconds: now - 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(validateExactPayload(payload, required, { nowSeconds: now + 300, allowExpired: true })).resolves.toBeDefined();
  });
  it("rejects noncanonical recovery IDs and high-s signatures", async () => {
    const payload = await signed();
    const original = payload.payload.signature;
    payload.payload.signature = `${original.slice(0, 130)}00`;
    await expect(validateExactPayload(payload, required, { nowSeconds: now })).rejects.toBeInstanceOf(ValidationError);
    payload.payload.signature = `${original.slice(0, 66)}${"ff".repeat(32)}${original.slice(130)}`;
    await expect(validateExactPayload(payload, required, { nowSeconds: now })).rejects.toBeInstanceOf(ValidationError);
  });
  it.each(["", "{}", "!!!!", "e30=\n", "A".repeat(24_004), Buffer.from("{broken").toString("base64"), Buffer.from([0xff]).toString("base64")])("rejects malformed or oversized transport %#", (value) => {
    expect(() => decodePaymentSignature(value)).toThrow(ValidationError);
  });
  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5])("rejects invalid chain IDs %s", (value) => expect(() => caip2(value)).toThrow(ValidationError));
  it("never emits a successful settlement header without a transaction", () => {
    expect(() => encodePaymentResponse({ success: true, transaction: "", chainId: 31337 })).toThrow(ValidationError);
  });
});
