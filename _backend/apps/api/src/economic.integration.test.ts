import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, http, parseEther, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { apiKeys, confirmDurableTransaction, createDb, sendDurableTransaction } from "@enclave/db";
import { sha256Hex } from "@enclave/core";
import { loadConfig, type Config } from "./config.js";
import { createApp } from "./app.js";
import { createFacilitator } from "./chain.js";
import { EnclaveGateway } from "./gateway.js";
import { createLogger } from "./logger.js";

describe("real contract economic API", () => {
  const admin = `economics-${randomUUID()}`;
  let cfg: Config;
  let db: ReturnType<typeof createDb>["db"];
  let sql: ReturnType<typeof createDb>["sql"];
  let gateway: EnclaveGateway;
  let app: ReturnType<typeof createApp>;
  const artifact = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../contracts/out-solc/${name}.json`, import.meta.url)), "utf8")).abi as Abi;
  const client = () => createPublicClient({ chain: { ...foundry, id: cfg.ARC_CHAIN_ID }, transport: http(cfg.ARC_RPC_URL) });
  const evm = () => createTestClient({ mode: "anvil", chain: { ...foundry, id: cfg.ARC_CHAIN_ID }, transport: http(cfg.ARC_RPC_URL) });
  const operator = () => privateKeyToAccount(cfg.DEPLOYER_PRIVATE_KEY).address;

  beforeAll(async () => {
    expect(process.env.ENCLAVE_INTEGRATION, "Requires the disposable test runner").toBe("1");
    cfg = loadConfig();
    ({ db, sql } = createDb(cfg.DATABASE_URL));
    await db.insert(apiKeys).values({ keyHash: sha256Hex(admin), role: "admin", label: "economic integration" });
    gateway = await EnclaveGateway.boot(db, cfg, createLogger("silent"), undefined);
    app = createApp(gateway, createLogger("silent"));
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  async function post(route: string, body: unknown = {}) {
    const response = await app.request(route, { method: "POST", headers: { "content-type": "application/json", "x-api-key": admin }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function write(name: string, address: string, functionName: string, args: unknown[], privateKey = cfg.DEPLOYER_PRIVATE_KEY) {
    const options = { db, rpcUrl: cfg.ARC_RPC_URL, chainId: cfg.ARC_CHAIN_ID, privateKey };
    const hash = await sendDurableTransaction(options, `economic:${randomUUID()}`, { address: address as Hex, abi: artifact(name), functionName, args });
    expect((await confirmDurableTransaction(options, hash)).status).toBe("success");
    return hash;
  }
  async function usdcBalance(who: string) {
    return client().readContract({ address: cfg.USDC_ADDRESS as Hex, abi: artifact("MockUSDC"), functionName: "balanceOf", args: [who] }) as Promise<bigint>;
  }

  it("stakes, checkpoints received USDC and claims the measured reward through the API", async () => {
    const previous = await gateway.stakingRewards(admin);
    if (BigInt(previous.pendingUnits) > 0n) expect((await post("/v1/stake/rewards/claim")).status).toBe(200);
    const deposit = parseEther("1");
    expect((await post("/v1/stake", { amountWei: deposit.toString() })).status).toBe(200);
    await write("MockUSDC", cfg.USDC_ADDRESS, "mint", [cfg.INSURANCE_STAKING_ADDRESS, 1_000_000n]);
    const pending = await gateway.stakingRewards(admin);
    expect(BigInt(pending.pendingUnits)).toBeGreaterThanOrEqual(999_999n);
    const before = await usdcBalance(operator());
    const claimed = await post("/v1/stake/rewards/claim");
    expect(claimed.status).toBe(200);
    expect(claimed.body.amountUnits).toBe(pending.pendingUnits);
    expect((await usdcBalance(operator())) - before).toBe(BigInt(claimed.body.amountUnits));
    expect((await gateway.stakingRewards(admin)).pendingUnits).toBe("0");
    expect((await post("/v1/unstake", { amountWei: deposit.toString() })).status).toBe(200);
  });

  it("reserves 8% and distributes the actual net 72/10/5/5 split without recycling older reserve", async () => {
    expect((await post("/v1/buyback/reserve", { treasuryBps: 1000 })).status).toBe(200);
    const initial = await gateway.buybackStatus(admin);
    const existing = BigInt(initial.availableForDistribution);
    const topUp = 10_000n - existing % 10_000n;
    await write("MockUSDC", cfg.USDC_ADDRESS, "mint", [cfg.FEE_VAULT_ADDRESS, topUp]);
    const total = existing + topUp;
    const distributed = await post("/v1/fees/distribute");
    expect(distributed.status).toBe(200);
    expect(distributed.body.split).toEqual({ treasury: (total * 72n / 100n).toString(), stakers: (total / 10n).toString(), providers: (total / 20n).toString(), ecosystem: (total / 20n).toString() });
    expect(distributed.body.buyback).toMatchObject({ status: "reserved", amountUnits: (total * 8n / 100n).toString() });
    const after = await gateway.buybackStatus(admin);
    expect(BigInt(after.reserved)).toBe(BigInt(initial.reserved) + total * 8n / 100n);
    expect(after.availableForDistribution).toBe("0");
    expect(await usdcBalance(cfg.FEE_VAULT_ADDRESS)).toBe(BigInt(after.reserved));
  });

  it("pays the approved provider's registered fraction and records per-model volume", async () => {
    const providerKey = `0x${"34".repeat(32)}` as Hex;
    const provider = privateKeyToAccount(providerKey);
    await evm().setBalance({ address: provider.address, value: parseEther("10") });
    const stake = await client().readContract({ address: cfg.MODEL_REGISTRY_ADDRESS as Hex, abi: artifact("ModelRegistry"), functionName: "listingStake" }) as bigint;
    await write("ENCL", cfg.ENCL_TOKEN_ADDRESS, "transfer", [provider.address, stake]);
    await write("ENCL", cfg.ENCL_TOKEN_ADDRESS, "approve", [cfg.MODEL_REGISTRY_ADDRESS, stake], providerKey);
    const modelHash = sha256Hex(randomUUID());
    const codeHash = sha256Hex(randomUUID());
    await write("ModelRegistry", cfg.MODEL_REGISTRY_ADDRESS, "list", [modelHash, codeHash, 2000], providerKey);
    const listing = await client().readContract({ address: cfg.MODEL_REGISTRY_ADDRESS as Hex, abi: artifact("ModelRegistry"), functionName: "idByHashes", args: [modelHash, codeHash] }) as bigint;
    expect((await post(`/v1/marketplace/${listing}/bootstrap-approve`)).status).toBe(200);
    const beforeProvider = await usdcBalance(provider.address);
    const beforeVault = await usdcBalance(cfg.FEE_VAULT_ADDRESS);
    await createFacilitator(cfg, db).settle(randomUUID(), 10_000n, false, { listingId: Number(listing) });
    expect((await usdcBalance(provider.address)) - beforeProvider).toBe(2000n);
    expect((await usdcBalance(cfg.FEE_VAULT_ADDRESS)) - beforeVault).toBe(8000n);
    expect(await client().readContract({ address: cfg.USAGE_METER_ADDRESS as Hex, abi: artifact("UsageMeter"), functionName: "providerEarned", args: [listing] })).toBe(2000n);
    expect(await client().readContract({ address: cfg.USAGE_METER_ADDRESS as Hex, abi: artifact("UsageMeter"), functionName: "listingVolume", args: [listing] })).toBe(10_000n);
  });

  it("returns 409 during the listing timelock and executes approval only after the chain deadline", async () => {
    const listed = await post("/v1/marketplace/list", { modelHash: sha256Hex(randomUUID()), codeHash: sha256Hex(randomUUID()), version: "timed-economic-v1", bps: 100 });
    expect(listed.status).toBe(201);
    const id = listed.body.listingId as number;
    const blocked = await post(`/v1/marketplace/${id}/approve`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.title).toBe("TIMELOCK_ACTIVE");
    const status = await gateway.listingApprovalStatus(id);
    expect(status.state).toBe("pending");
    await evm().increaseTime({ seconds: Number(BigInt(status.availableAt) - BigInt(status.chainTimestamp)) + 1 });
    await evm().mine({ blocks: 1 });
    const approved = await post(`/v1/marketplace/${id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.approved).toBe(true);
    expect((await gateway.listingApprovalStatus(id)).state).toBe("approved");
  });
});
