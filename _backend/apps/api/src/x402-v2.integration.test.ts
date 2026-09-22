import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, http, parseSignature, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { apiKeys, chainTransactions, confirmDurableTransaction, createDb, payments, sendDurableTransaction, sessions } from "@enclave/db";
import { AppError, decryptAesGcm, encryptAesGcm, sha256Hex } from "@enclave/core";
import { loadConfig } from "./config.js";
import { EnclaveGateway } from "./gateway.js";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import { decodePaymentSignature, type X402Payload } from "./x402-v2.js";
import { paymentIdToBytes32 } from "./chain.js";
import * as chain from "./chain.js";

const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../../../contracts/out-solc/${name}.json`, import.meta.url), "utf8")).abi;

describe("official x402 SDK HTTP payment through actual Postgres + Anvil", () => {
  const cfg = { ...loadConfig(), PAYMENT_MODE: "authorized" as const };
  const { db, sql } = createDb(cfg.DATABASE_URL);
  const client = createPublicClient({ chain: foundry, transport: http(cfg.ARC_RPC_URL), cacheTime: 0 });
  const opts = { db, rpcUrl: cfg.ARC_RPC_URL, chainId: cfg.ARC_CHAIN_ID, privateKey: cfg.DEPLOYER_PRIVATE_KEY };
  const key = `x402-${randomUUID()}`;
  let gateway: EnclaveGateway;
  let app: ReturnType<typeof createApp>;
  let clock: Date;
  const log = createLogger("silent");
  const payer = privateKeyToAccount(generatePrivateKey());
  const sdk = new x402HTTPClient(new x402Client().register(`eip155:${cfg.ARC_CHAIN_ID}`, new ExactEvmScheme(payer))
    .setSpendControls({ allowedAssets: [{ network: `eip155:${cfg.ARC_CHAIN_ID}`, asset: cfg.USDC_ADDRESS, maxAmountPerPayment: "100000" }] }));
  beforeAll(async () => {
    expect(process.env.ENCLAVE_INTEGRATION).toBe("1");
    await db.insert(apiKeys).values({ keyHash: sha256Hex(key), label: "x402 SDK integration" });
    gateway = await EnclaveGateway.boot(db, cfg, log, undefined);
    app = createApp(gateway, log);
    await write("MockUSDC", cfg.USDC_ADDRESS, "mint", [payer.address, 10_000_000n]);
  });
  beforeEach(async () => {
    // Other economic suites deliberately advance Anvil. Align this SDK's clock with that chain only.
    clock = new Date(Number((await client.getBlock()).timestamp) * 1000);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(clock);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  afterAll(async () => { await sql.end({ timeout: 5 }); });
  async function write(name: string, address: string, functionName: string, args: unknown[]) {
    const tx = await sendDurableTransaction(opts, `x402-fixture:${randomUUID()}`, { address: address as Hex, abi: artifact(name), functionName, args });
    await confirmDurableTransaction(opts, tx); return tx;
  }
  async function balance(address: string) {
    return client.readContract({ address: cfg.USDC_ADDRESS as Hex, abi: artifact("MockUSDC"), functionName: "balanceOf", args: [address] }) as Promise<bigint>;
  }
  async function challenge(apiKey = key) {
    const session = await gateway.openSession(apiKey, await gateway.quote());
    // Postgres uses its wall clock for defaults; quote replay validation uses this row's creation time.
    await db.update(sessions).set({ createdAt: clock }).where(eq(sessions.id, session.sessionId));
    const secret = gateway.sessionWrapKey(session.sessionId);
    const plaintext = `x402-${randomUUID()}`;
    const blob = encryptAesGcm(secret, Buffer.from(plaintext));
    const body = { sessionId: session.sessionId, ...blob };
    const headers = { "content-type": "application/json", "x-api-key": apiKey };
    const response = await app.request("http://localhost/v2/inference", { method: "POST", headers, body: JSON.stringify(body) });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(402);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const required = sdk.getPaymentRequiredResponse((name) => response.headers.get(name));
    expect(required.accepts[0]!.payTo.toLowerCase()).toBe(cfg.USAGE_METER_ADDRESS.toLowerCase());
    const signed = await sdk.createPaymentPayload(required);
    const paymentHeader = sdk.encodePaymentSignatureHeader(signed)["PAYMENT-SIGNATURE"]!;
    const payload = decodePaymentSignature(paymentHeader);
    return { body, secret, plaintext, payload, paymentId: payload.accepted.extra.enclavePaymentId,
      send: (value = payload, url = "http://localhost/v2/inference") => app.request(url, { method: "POST", headers: { ...headers, "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(value)).toString("base64") }, body: JSON.stringify(body) }) };
  }
  async function directTransfer(payload: X402Payload) {
    const a = payload.payload.authorization; const sig = parseSignature(payload.payload.signature as Hex);
    return write("MockUSDC", cfg.USDC_ADDRESS, "transferWithAuthorization", [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(sig.v), sig.r, sig.s]);
  }
  async function row(id: string) { return (await db.select().from(payments).where(eq(payments.id, id)))[0]!; }
  function afterAdmission(action: () => Promise<unknown>) {
    const factory = chain.createX402Facilitator; let fired = false;
    return vi.spyOn(chain, "createX402Facilitator").mockImplementation((...args) => {
      const facilitator = factory(...args);
      return { ...facilitator, settle: async (...params) => {
        if (!fired) { fired = true; await action(); }
        return facilitator.settle(...params);
      } };
    });
  }

  it("performs the standard challenge/sign/retry exchange, encrypts output and never recharges a replay", async () => {
    const request = await challenge(); const before = await balance(payer.address);
    const response = await request.send(); const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    const settled = sdk.getPaymentSettleResponse((name) => response.headers.get(name));
    expect(settled).toMatchObject({ success: true, payer: payer.address, network: "eip155:31337" });
    expect(sha256Hex(decryptAesGcm(request.secret, body.output))).toBe(body.outputHash);
    expect(before - await balance(payer.address)).toBe(100000n);
    const replay = await request.send(); expect(replay.status).toBe(200);
    expect((await replay.json()).typedHash).toBe(body.typedHash);
    expect(sdk.getPaymentSettleResponse((name) => replay.headers.get(name)).transaction).toBe(settled.transaction);
    expect(before - await balance(payer.address)).toBe(100000n);
    expect((await row(request.paymentId)).status).toBe("consumed");
  });

  it("recovers a front-run direct TransferWithAuthorization without charging the payer twice", async () => {
    const request = await challenge(); const before = await balance(payer.address);
    let fundingTx: Hex | undefined;
    const race = afterAdmission(async () => { fundingTx = await directTransfer(request.payload); });
    const response = await request.send(); expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    race.mockRestore();
    const saved = await row(request.paymentId);
    expect(JSON.parse(saved.authorizationJson!).fundingTx).toBe(fundingTx);
    expect(saved.settleTx).not.toBe(fundingTx);
    expect(before - await balance(payer.address)).toBe(100000n);
    expect((await request.send()).status).toBe(200);
    expect(before - await balance(payer.address)).toBe(100000n);
  });

  it("rejects one authorization reused for another request-bound payment intent", async () => {
    const first = await challenge(); expect((await first.send()).status).toBe(200);
    const second = await challenge(); const before = await balance(payer.address);
    const reused = { ...second.payload, payload: first.payload.payload };
    const response = await second.send(reused);
    expect(response.status).toBe(409);
    expect((await response.json()).detail).toContain("already bound");
    expect(await balance(payer.address)).toBe(before);
    expect((await row(second.paymentId)).status).toBe("open");
  });

  it("never credits a canceled nonce from unrelated meter funds", async () => {
    const request = await challenge(); const nonce = request.payload.payload.authorization.nonce as Hex;
    const signature = await payer.signTypedData({ domain: { name: cfg.USDC_EIP712_NAME, version: cfg.USDC_EIP712_VERSION,
      chainId: cfg.ARC_CHAIN_ID, verifyingContract: cfg.USDC_ADDRESS as Hex }, primaryType: "CancelAuthorization",
      types: { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] }, message: { authorizer: payer.address, nonce } });
    const sig = parseSignature(signature);
    const race = afterAdmission(async () => {
      await write("MockUSDC", cfg.USDC_ADDRESS, "cancelAuthorization", [payer.address, nonce, Number(sig.v), sig.r, sig.s]);
      await write("MockUSDC", cfg.USDC_ADDRESS, "mint", [cfg.USAGE_METER_ADDRESS, 100000n]);
    });
    const before = await balance(payer.address);
    const response = await request.send(); race.mockRestore(); expect(response.status).toBeGreaterThanOrEqual(400);
    expect(sdk.getPaymentSettleResponse((name) => response.headers.get(name)).success).toBe(false);
    expect(await balance(payer.address)).toBe(before);
    expect(await client.readContract({ address: cfg.USAGE_METER_ADDRESS as Hex, abi: artifact("UsageMeter"), functionName: "settled", args: [paymentIdToBytes32(request.paymentId)] })).toBe(false);
    expect((await row(request.paymentId)).status).toBe("settlement_unknown");
    await expect(gateway.resumeX402Payment(request.paymentId)).rejects.toThrow();
    expect((await row(request.paymentId)).status).toBe("settlement_unknown");
  });

  it("rejects public prefunding claimed by a different API key even if its challenge predates the deposit", async () => {
    const victim = await challenge();
    const attackerKey = `attacker-${randomUUID()}`;
    await db.insert(apiKeys).values({ keyHash: sha256Hex(attackerKey), label: "public deposit theft regression" });
    const attacker = await challenge(attackerKey);
    await directTransfer(victim.payload);
    const stolen = { ...attacker.payload, payload: victim.payload.payload };
    const response = await attacker.send(stolen);
    expect(response.status).toBe(409);
    expect((await response.json()).detail).toContain("unused at canonical admission");
    expect((await row(attacker.paymentId)).status).toBe("open");
    expect((await row(victim.paymentId)).status).toBe("open");
  });

  it("reports successful payment despite a subsequent inference failure and retries inference for free", async () => {
    const request = await challenge(); const before = await balance(payer.address);
    const fault = vi.spyOn(gateway, "infer").mockRejectedValueOnce(new AppError("INFERENCE_UNAVAILABLE", "Injected provider failure", 503));
    const response = await request.send(); fault.mockRestore();
    expect(response.status).toBe(503);
    const settlement = sdk.getPaymentSettleResponse((name) => response.headers.get(name));
    expect(settlement.success).toBe(true);
    expect(settlement.transaction).toBe((await row(request.paymentId)).settleTx);
    expect((await row(request.paymentId)).status).toBe("settled");
    expect((await request.send()).status).toBe(200);
    expect(before - await balance(payer.address)).toBe(100000n);
  });

  it("reconciles a durable x402 settlement after database finalization fails", async () => {
    const request = await challenge(); const before = await balance(payer.address);
    const original = db.update.bind(db); let failed = false;
    const fault = vi.spyOn(db, "update").mockImplementation(((table: Parameters<typeof original>[0]) => {
      const builder = original(table);
      if (table === payments) { const set = builder.set.bind(builder); builder.set = ((values: { status?: string }) => {
        if (values.status === "settled" && !failed) { failed = true; throw new Error("Injected finalization failure"); }
        return set(values as never);
      }) as typeof builder.set; }
      return builder;
    }) as typeof db.update);
    const response = await request.send(); fault.mockRestore();
    expect(response.status).toBe(503); expect((await row(request.paymentId)).status).toBe("settlement_unknown");
    expect(sdk.getPaymentSettleResponse((name) => response.headers.get(name)).success).toBe(true);
    await gateway.resumeX402Payment(request.paymentId);
    expect((await request.send()).status).toBe(200);
    expect(before - await balance(payer.address)).toBe(100000n);
    expect(await db.select().from(chainTransactions).where(eq(chainTransactions.operationKey, `x402:${request.paymentId}:transfer:0`))).toHaveLength(1);
  });

  it("rejects legacy settlement and a different HTTP resource before charging", async () => {
    const request = await challenge(); const before = await balance(payer.address);
    await expect(gateway.settlePayment(key, request.paymentId)).rejects.toThrow("x402");
    const response = await request.send(request.payload, "http://localhost/v2/inference?different=1");
    expect(response.status).toBe(409); expect(await balance(payer.address)).toBe(before);
    expect((await row(request.paymentId)).status).toBe("open");
  });

  it("refuses to advertise x402 when an existing deployment lacks the required meter capability", async () => {
    const oldDeployment = await EnclaveGateway.boot(db, { ...cfg, USAGE_METER_ADDRESS: cfg.USDC_ADDRESS }, log, undefined);
    await expect(oldDeployment.x402Infer({ apiKey: key, sessionId: randomUUID(), blob: { iv: "", tag: "", ciphertext: "" } }, "http://localhost/v2/inference"))
      .rejects.toMatchObject({ code: "X402_UNAVAILABLE", statusCode: 503 });
  });
});
