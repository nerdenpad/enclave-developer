import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { apiKeys, chainTransactions, createDb, payments, sendDurableTransaction, confirmDurableTransaction, recoverSignerTransactions } from "@enclave/db";
import { encryptAesGcm, sha256Hex } from "@enclave/core";
import { createPublicClient, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { loadConfig } from "./config.js";
import { EnclaveGateway } from "./gateway.js";
import { createLogger } from "./logger.js";
import { authorizationData } from "./authorization.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const tokenAbi = JSON.parse(readFileSync(new URL("../../../contracts/out-solc/MockUSDC.json", import.meta.url), "utf8")).abi;
const meterAbi = JSON.parse(readFileSync(new URL("../../../contracts/out-solc/UsageMeter.json", import.meta.url), "utf8")).abi;
describe("durable signer and payment recovery against Postgres + Anvil", () => {
  const cfg = loadConfig();
  const { db, sql } = createDb(cfg.DATABASE_URL);
  const opts = { db, rpcUrl: cfg.ARC_RPC_URL, chainId: cfg.ARC_CHAIN_ID, privateKey: cfg.DEPLOYER_PRIVATE_KEY };
  const account = privateKeyToAccount(cfg.DEPLOYER_PRIVATE_KEY);
  const client = createPublicClient({ chain: foundry, transport: http(cfg.ARC_RPC_URL) });
  const key = randomUUID();
  const log = createLogger("silent");
  beforeAll(async () => { await db.insert(apiKeys).values({ keyHash: sha256Hex(key), label: "durable test" }); });
  afterAll(async () => { vi.restoreAllMocks(); await sql.end(); });
  const mint = (amount: bigint, to = account.address) => ({ address: cfg.USDC_ADDRESS as Hex, abi: tokenAbi, functionName: "mint", args: [to, amount] });
  const balance = () => client.readContract({ address: cfg.USDC_ADDRESS as Hex, abi: tokenAbi, functionName: "balanceOf", args: [account.address] }) as Promise<bigint>;
  const spent = () => client.readContract({ address: cfg.USAGE_METER_ADDRESS as Hex, abi: meterAbi, functionName: "spent", args: [account.address] }) as Promise<bigint>;
  const child = (operation: string, amount: string) => new Promise<Hex>((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "scripts/durable-signer-child.ts", operation, amount], { cwd: root, env: process.env, windowsHide: true });
    let out = ""; let err = "";
    proc.stdout.on("data", (v) => { out += v; }); proc.stderr.on("data", (v) => { err += v; });
    proc.on("error", reject); proc.on("exit", (code) => { if (code) reject(new Error(err)); else resolve((JSON.parse(out) as { hash: Hex }).hash); });
  });

  it("allocates distinct nonces across four independent OS processes", async () => {
    const before = await balance();
    const hashes = await Promise.all([1, 2, 3, 4].map((n) => child(`process:${randomUUID()}`, String(n))));
    expect(new Set(hashes).size).toBe(4);
    expect(await balance() - before).toBe(10n);
  });
  it("concurrent processes retry one operation with the identical transaction", async () => {
    const before = await balance(); const operation = `duplicate:${randomUUID()}`;
    const hashes = await Promise.all([child(operation, "7"), child(operation, "7")]);
    expect(hashes[0]).toBe(hashes[1]); expect(await balance() - before).toBe(7n);
  });
  it("rejects operation-key reuse for a different transfer", async () => {
    const operation = `bound:${randomUUID()}`;
    await confirmDurableTransaction(opts, await sendDurableTransaction(opts, operation, mint(1n)));
    await expect(sendDurableTransaction(opts, operation, mint(2n))).rejects.toThrow("different parameters");
  });

  async function failingProxy(afterBroadcast: boolean) {
    const server = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body) as { method: string; id: number };
      if (payload.method === "eth_sendRawTransaction" || payload.method === "eth_getTransactionByHash") {
        if (afterBroadcast && payload.method === "eth_sendRawTransaction") await fetch(cfg.ARC_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: "Injected unavailable transport" } })); return;
      }
      const upstream = await fetch(cfg.ARC_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body });
      res.setHeader("content-type", "application/json"); res.end(await upstream.text());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }
  it.each([false, true])("recovers a crash with signed bytes saved (broadcast had happened: %s)", async (afterBroadcast) => {
    const before = await balance(); const operation = `crash:${randomUUID()}`;
    const proxy = await failingProxy(afterBroadcast);
    try { await expect(sendDurableTransaction({ ...opts, rpcUrl: proxy.url }, operation, mint(13n))).rejects.toThrow(); }
    finally { await proxy.close(); }
    const [saved] = await db.select().from(chainTransactions).where(eq(chainTransactions.operationKey, operation));
    expect(saved?.rawTransaction).toMatch(/^0x/); expect(saved?.status).toBe("prepared");
    await recoverSignerTransactions(opts);
    const hash = await sendDurableTransaction(opts, operation, mint(13n));
    expect(hash).toBe(saved!.txHash);
    await confirmDurableTransaction(opts, hash);
    expect(await balance() - before).toBe(13n);
  });

  async function intent(gateway: EnclaveGateway) {
    const session = await gateway.openSession(key, await gateway.quote());
    const blob = encryptAesGcm(gateway.sessionWrapKey(session.sessionId), Buffer.from(randomUUID()));
    try { await gateway.infer({ apiKey: key, sessionId: session.sessionId, blob }); throw new Error("Expected challenge"); }
    catch (err) { const paymentId = (err as { details: { accepts: [{ extra: { paymentId: string } }] } }).details.accepts[0].extra.paymentId; return { paymentId, sessionId: session.sessionId, blob }; }
  }
  it("reconciles chain success followed by database finalization failure without charging twice", async () => {
    const gateway = await EnclaveGateway.boot(db, cfg, log, undefined);
    await gateway.reconcilePayments(); // Drain unrelated fault-injection intents from other suites first.
    const request = await intent(gateway); const before = await spent();
    const original = db.update.bind(db); let failed = false;
    const spy = vi.spyOn(db, "update").mockImplementation(((table: Parameters<typeof original>[0]) => {
      const builder = original(table);
      if (table === payments) {
        const set = builder.set.bind(builder);
        builder.set = ((values: { status?: string }) => {
          if (values.status === "settled" && !failed) { failed = true; throw new Error("Injected database outage"); }
          return set(values as never);
        }) as typeof builder.set;
      }
      return builder;
    }) as typeof db.update);
    try { await expect(gateway.settlePayment(key, request.paymentId)).rejects.toThrow("database outage"); } finally { spy.mockRestore(); }
    expect((await db.select().from(payments).where(eq(payments.id, request.paymentId)))[0]?.status).toBe("settlement_unknown");
    const restarted = await EnclaveGateway.boot(db, cfg, log, undefined);
    expect(await restarted.reconcilePayments()).toBeGreaterThanOrEqual(1);
    expect(await spent() - before).toBe(100000n);
    const result = await restarted.infer({ apiKey: key, ...request }); expect(result.receipt.receiptVersion).toBe(2);
    expect(await db.select().from(chainTransactions).where(and(eq(chainTransactions.operationKey, `payment:${request.paymentId}:2`), eq(chainTransactions.status, "confirmed")))).toHaveLength(1);
  });
  it("charges the external payer's signed USDC authorization without minting or allowance", async () => {
    const payer = privateKeyToAccount(generatePrivateKey()); const amount = 100000n;
    await confirmDurableTransaction(opts, await sendDurableTransaction(opts, `fund:${randomUUID()}`, mint(amount, payer.address)));
    const authorized = { ...cfg, PAYMENT_MODE: "authorized" as const };
    const gateway = await EnclaveGateway.boot(db, authorized, log, undefined); const request = await intent(gateway);
    const data = authorizationData(authorized, request.paymentId, amount, payer.address, "0", ((await client.getBlock()).timestamp + 1800n).toString());
    const signature = await payer.signTypedData(data);
    const auth = { from: payer.address, validAfter: "0", validBefore: data.message.validBefore.toString(), signature };
    const result = await gateway.settlePayment(key, request.paymentId, false, auth);
    expect((await gateway.settlePayment(key, request.paymentId, false, auth)).tx).toBe(result.tx);
    expect(await client.readContract({ address: cfg.USDC_ADDRESS as Hex, abi: tokenAbi, functionName: "balanceOf", args: [payer.address] })).toBe(0n);
    expect(await db.select().from(chainTransactions).where(eq(chainTransactions.operationKey, `payment:${request.paymentId}:1`))).toHaveLength(0);
    expect((await gateway.infer({ apiKey: key, ...request })).outputHash).toMatch(/^0x/);
  });
});
