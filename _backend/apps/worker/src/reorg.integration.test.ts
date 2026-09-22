import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { chainEvents, createDb, indexCursors, models } from "@enclave/db";
import { createTestClient, createWalletClient, http, keccak256, publicActions, stringToHex, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import pino from "pino";
import { z } from "zod";
import { getIndexerScope, indexChainOnce, resetChainIndexer, type IndexerOpts } from "./indexer.js";

describe.skipIf(process.env.ENCLAVE_INTEGRATION !== "1")("Anvil forks and Postgres indexer isolation", () => {
  let db: ReturnType<typeof createDb>["db"];
  let sql: ReturnType<typeof createDb>["sql"];
  let opts: IndexerOpts;
  let call: (method: string, args: readonly unknown[]) => Promise<Hex>;
  let snapshot: () => Promise<Hex>;
  let revert: (id: Hex) => Promise<void>;
  let mine: (blocks: number) => Promise<void>;
  const modelHash = keccak256(stringToHex(`reorg-model-${randomUUID()}`));
  const codeHash = keccak256(stringToHex(`reorg-code-${randomUUID()}`));
  const secondHash = keccak256(stringToHex(`reorg-model-2-${randomUUID()}`));

  beforeAll(async () => {
    const env = z.object({ ENCLAVE_INTEGRATION: z.literal("1"), DATABASE_URL: z.string(), ARC_RPC_URL: z.string(), DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(process.env);
    ({ db, sql } = createDb(env.DATABASE_URL));
    const transport = http(env.ARC_RPC_URL);
    const account = privateKeyToAccount(`0x${env.DEPLOYER_PRIVATE_KEY.slice(2)}`);
    const wallet = createWalletClient({ account, chain: foundry, transport, cacheTime: 0, pollingInterval: 50 }).extend(publicActions);
    const test = createTestClient({ chain: foundry, transport, mode: "anvil" });
    expect(await wallet.getChainId()).toBe(31337);
    // REASON: these artifacts are compiled by the disposable integration runner.
    const artifact = JSON.parse(readFileSync(new URL("../../../contracts/out-solc/ModelRegistry.json", import.meta.url), "utf8")) as { abi: Abi; bytecode: Hex };
    const deployed = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: ["0x0000000000000000000000000000000000000000", 0n] });
    const deployment = await wallet.waitForTransactionReceipt({ hash: deployed });
    expect(deployment.status).toBe("success");
    const registry: Address = deployment.contractAddress!;
    call = async (functionName, args) => {
      const tx = await wallet.writeContract({ address: registry, abi: artifact.abi, functionName, args });
      expect((await wallet.waitForTransactionReceipt({ hash: tx })).status).toBe("success");
      return tx;
    };
    snapshot = () => test.snapshot();
    revert = (id) => test.revert({ id });
    mine = (blocks) => test.mine({ blocks, interval: 1 });
    opts = { db, rpcUrl: env.ARC_RPC_URL, chainId: 31337, verifier: undefined, meter: undefined, registry, log: pino({ enabled: false }), reorgWindow: 8 };
    await db.insert(models).values({ modelHash, codeHash, version: "catalog-v7", provider: "local-provider-metadata", listingBps: 321 });
    await call("list", [modelHash, codeHash, 17]);
    await call("bootstrapApprove", [1n]);
  });

  afterAll(async () => { await sql?.end({ timeout: 5 }); });
  async function model(hash = modelHash) {
    return (await db.select().from(models).where(and(eq(models.modelHash, hash), eq(models.codeHash, codeHash))).limit(1))[0];
  }

  it("rolls back an orphaned revocation and preserves local catalog metadata", async () => {
    await indexChainOnce(opts);
    const original = await model();
    expect(original).toMatchObject({ approved: true, revoked: false, version: "catalog-v7", provider: "local-provider-metadata", listingBps: 321 });
    const point = await snapshot();
    const orphanTx = await call("revoke", [1n]);
    await indexChainOnce(opts);
    expect(await model()).toMatchObject({ approved: false, revoked: true });
    await revert(point);
    await call("bootstrapRestore", [1n]);
    await indexChainOnce(opts);
    expect(await model()).toMatchObject({ approved: true, revoked: false, version: "catalog-v7", provider: "local-provider-metadata", listingBps: 321, createdAt: original!.createdAt });
    const scope = await getIndexerScope(opts);
    expect(await db.select().from(chainEvents).where(and(eq(chainEvents.scope, scope), eq(chainEvents.txHash, orphanTx)))).toHaveLength(0);
  });

  it("withholds registry approvals until the configured confirmation depth", async () => {
    const finalized = { ...opts, confirmations: 2, deploymentId: "confirmations" };
    await call("list", [secondHash, codeHash, 0]);
    await call("bootstrapApprove", [2n]);
    await indexChainOnce(finalized);
    expect(await model(secondHash)).toBeUndefined();
    await mine(2);
    await indexChainOnce(finalized);
    expect(await model(secondHash)).toMatchObject({ approved: true, chainScope: await getIndexerScope(finalized) });
  });

  it("blocks a deep fork until explicit scoped genesis replay and leaves other journals intact", async () => {
    const deep = { ...opts, reorgWindow: 2, deploymentId: "deep-fork" };
    const point = await snapshot();
    await mine(4);
    const orphanTx = await call("revoke", [1n]);
    await indexChainOnce(deep);
    const scope = await getIndexerScope(deep);
    await revert(point);
    await call("revoke", [2n]);
    await mine(6);
    await expect(indexChainOnce(deep)).rejects.toThrow("INDEXER_REBUILD_REQUIRED");
    expect(await model()).toMatchObject({ approved: false, chainScope: scope });
    expect((await db.select().from(indexCursors).where(eq(indexCursors.name, scope)))[0]?.status).toBe("rebuild_required");
    // The orphan journal remains available for diagnosis until the explicit reset.
    expect(await db.select().from(chainEvents).where(and(eq(chainEvents.scope, scope), eq(chainEvents.txHash, orphanTx)))).toHaveLength(1);
    const otherScope = await getIndexerScope(opts);
    const otherEvents = await db.select().from(chainEvents).where(eq(chainEvents.scope, otherScope));
    await resetChainIndexer(deep);
    expect(await db.select().from(chainEvents).where(eq(chainEvents.scope, scope))).toHaveLength(0);
    expect(await db.select().from(chainEvents).where(eq(chainEvents.scope, otherScope))).toHaveLength(otherEvents.length);
    await indexChainOnce(deep);
    expect(await model()).toMatchObject({ approved: true, revoked: false, provider: "local-provider-metadata" });
    expect(await model(secondHash)).toMatchObject({ approved: false, revoked: true });
    expect((await db.select().from(indexCursors).where(eq(indexCursors.name, scope)))[0]?.status).toBe("active");
  });

  it("serializes independent indexer instances on the same database cursor", async () => {
    const concurrent = { ...opts, deploymentId: "independent-instances" };
    const runs = await Promise.all([indexChainOnce(concurrent), indexChainOnce(concurrent)]);
    expect(runs.filter((run) => run?.fromBlock === 0n)).toHaveLength(1);
    expect(runs.filter((run) => run && run.fromBlock > run.toBlock)).toHaveLength(1);
    const scope = await getIndexerScope(concurrent);
    const events = await db.select().from(chainEvents).where(eq(chainEvents.scope, scope));
    expect(new Set(events.map((event) => `${event.txHash}:${event.logIndex}`)).size).toBe(events.length);
  });
});
