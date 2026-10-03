import { afterEach, describe, expect, it, vi } from "vitest";
import { DevCvm, sha256Hex } from "@enclave/core";
import type { Database } from "@enclave/db";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EnclaveGateway } from "./gateway.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { authorizationData, validateAuthorization } from "./authorization.js";
import { createApp } from "./app.js";

const paymentId = "10000000-0000-4000-8000-000000000001";
const meter = `0x${"31".repeat(20)}`, vault = `0x${"32".repeat(20)}`;
function setup(mode: "authorized" | "mock") {
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://unit.invalid/test", ARC_CHAIN_ID: "5042", PAYMENT_MODE: mode,
    DEPLOYER_PRIVATE_KEY: generatePrivateKey(),
    USDC_ADDRESS: "0x3600000000000000000000000000000000000000", USDC_EIP712_NAME: "USDC", USDC_EIP712_VERSION: "2",
    USAGE_METER_ADDRESS: meter, FEE_VAULT_ADDRESS: vault, INFERENCE_PRICE_USDC: "0.1" });
  const database = { select: vi.fn(() => { throw new Error("Challenge must not query the database"); }) };
  const gateway = new EnclaveGateway(database as unknown as Database, {} as DevCvm, config, createLogger("silent"), undefined);
  return { config, gateway, database };
}
afterEach(() => vi.restoreAllMocks());

describe("payment challenge recipient", () => {
  it("advertises the ERC-3009 receiving meter for authorized Arc payments", async () => {
    const { config, gateway, database } = setup("authorized"), challenge = gateway.paymentChallenge(paymentId);
    expect(challenge).toEqual({ x402Version: 1, accepts: [{ scheme: "exact", network: "arc-5042", maxAmountRequired: "100000",
      payTo: meter, asset: config.USDC_ADDRESS, extra: { receiptPending: true, paymentId } }] });
    const payer = privateKeyToAccount(generatePrivateKey()), validBefore = String(Math.floor(Date.now() / 1000) + 600);
    // A client signing the advertised recipient must pass the server's real signature verification.
    const advertised = authorizationData({ ...config, USAGE_METER_ADDRESS: challenge.accepts[0]!.payTo }, paymentId,
      BigInt(challenge.accepts[0]!.maxAmountRequired), payer.address, "0", validBefore);
    await expect(validateAuthorization(config, paymentId, 100000n, { from: payer.address, validAfter: "0", validBefore,
      signature: await payer.signTypedData(advertised) })).resolves.toBeUndefined();
    expect(database.select).not.toHaveBeenCalled();
  });
  it("preserves FeeVault in the simulated payment descriptor", () => {
    const { gateway } = setup("mock");
    expect(gateway.paymentChallenge(paymentId).accepts[0]).toMatchObject({ payTo: vault, network: "arc-5042", maxAmountRequired: "100000" });
  });
  it("returns the actual gateway descriptor in the HTTP 402 response", async () => {
    const { gateway } = setup("authorized");
    const { PaymentRequiredError } = await import("@enclave/core");
    vi.spyOn(gateway, "infer").mockRejectedValue(new PaymentRequiredError("Payment required", gateway.paymentChallenge(paymentId)));
    const body = { sessionId: "10000000-0000-4000-8000-000000000002", iv: Buffer.alloc(12).toString("base64"),
      tag: Buffer.alloc(16).toString("base64"), ciphertext: Buffer.from("synthetic encrypted prompt").toString("base64") };
    const response = await createApp(gateway, createLogger("silent")).request("/v1/inference", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "synthetic-owner", "idempotency-key": sha256Hex("synthetic request") }, body: JSON.stringify(body) });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ title: "PAYMENT_REQUIRED", details: { accepts: [{ payTo: meter, asset: "0x3600000000000000000000000000000000000000",
      maxAmountRequired: "100000", extra: { paymentId, receiptPending: true } }] } });
  });
});
