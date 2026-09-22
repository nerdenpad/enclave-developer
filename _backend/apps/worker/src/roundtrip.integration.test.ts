import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue, QueueEvents, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import pino from "pino";
import { createPublicClient, createTestClient, decodeEventLog, http, type Hex } from "viem";
import { foundry } from "viem/chains";
import { z } from "zod";
import { chainEvents, createDb, receipts, recoverSignerTransactions } from "@enclave/db";
import { anchorReceipt } from "./anchorer.js";
import { recoverReceiptJobs } from "./jobs.js";
import { reconcileAnchoredReceipts } from "./receipt-recovery.js";
import { getIndexerScope, indexChainOnce, resetChainIndexer, VERIFIED, type IndexerOpts } from "./indexer.js";

// The integration runner supplies disposable Postgres, Redis, Anvil and signed API fixtures.
const envSchema = z.object({
  ENCLAVE_INTEGRATION: z.literal("1"),
  DATABASE_URL: z.string().url(), REDIS_URL: z.string().url(), ARC_RPC_URL: z.string().url(),
  ARC_CHAIN_ID: z.coerce.number().int().positive(),
  ATTESTATION_VERIFIER_ADDRESS: z.string(), USAGE_METER_ADDRESS: z.string(),
  FEE_VAULT_ADDRESS: z.string(), MODEL_REGISTRY_ADDRESS: z.string(),
  DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value): Hex => `0x${value.slice(2)}`),
});

describe.skipIf(process.env.ENCLAVE_INTEGRATION !== "1")("Postgres → Redis → receipt anchoring → Anvil → indexer", () => {
  const log = pino({ enabled: false });
  let db: ReturnType<typeof createDb>["db"];
  let sql: ReturnType<typeof createDb>["sql"];
  let queue: Queue;
  let events: QueueEvents;
  let worker: Worker;
  let indexerOpts: IndexerOpts;
  let env: z.infer<typeof envSchema>;
  let createWorker: () => Worker;

  beforeAll(async () => {
    env = envSchema.parse(process.env);
    ({ db, sql } = createDb(env.DATABASE_URL));
    const name = `worker-roundtrip-${randomUUID()}`;
    const connection = { url: env.REDIS_URL };
    queue = new Queue(name, { connection });
    events = new QueueEvents(name, { connection });
    await events.waitUntilReady();
    createWorker = () => new Worker(name, (job) => anchorReceipt({
      db, log, verifier: env.ATTESTATION_VERIFIER_ADDRESS, rpcUrl: env.ARC_RPC_URL,
      chainId: env.ARC_CHAIN_ID, privateKey: env.DEPLOYER_PRIVATE_KEY,
    }, job.data), { connection });
    worker = createWorker();
    worker.on("error", (err) => { log.error({ err }, "integration_worker_error"); });
    indexerOpts = {
      db, log, rpcUrl: env.ARC_RPC_URL, chainId: env.ARC_CHAIN_ID,
      verifier: env.ATTESTATION_VERIFIER_ADDRESS, meter: env.USAGE_METER_ADDRESS,
      feeVault: env.FEE_VAULT_ADDRESS, registry: env.MODEL_REGISTRY_ADDRESS,
    };
  });

  afterAll(async () => {
    await worker?.close();
    await events?.close();
    // Only the random queue owned by this test is removed.
    if (queue) { await queue.obliterate({ force: true }); await queue.close(); }
    await sql?.end({ timeout: 5 });
  });

  it("recovers a committed receipt without an enqueue, confirms it, and indexes without duplicate replay", async () => {
    const [fixture] = await db.select().from(receipts).where(eq(receipts.status, "pending")).limit(1);
    expect(fixture, "API integration must leave a signed pending receipt").toBeDefined();
    if (!fixture) throw new Error("Signed receipt fixture missing");
    const testChain = createTestClient({ chain: foundry, transport: http(env.ARC_RPC_URL), mode: "anvil" });
    const snapshot = await testChain.snapshot();
    expect(await queue.getJob(fixture.typedHash)).toBeUndefined();
    expect(await recoverReceiptJobs(db, queue)).toBeGreaterThan(0);
    const job = await queue.getJob(fixture.typedHash);
    expect(job).toBeDefined();
    await job!.waitUntilFinished(events, 45_000);
    const [anchored] = await db.select().from(receipts).where(eq(receipts.typedHash, fixture.typedHash));
    expect(anchored?.status).toBe("anchored");
    expect(anchored?.anchoredTx).toMatch(/^0x[0-9a-fA-F]{64}$/);
    const client = createPublicClient({ chain: foundry, transport: http(env.ARC_RPC_URL) });
    // REASON: the transaction hash is validated by the assertion above and persisted by viem.
    const confirmation = await client.getTransactionReceipt({ hash: anchored!.anchoredTx as Hex });
    expect(confirmation.status).toBe("success");
    const verified = confirmation.logs.find((event) => event.address.toLowerCase() === env.ATTESTATION_VERIFIER_ADDRESS.toLowerCase());
    expect(verified).toBeDefined();
    expect(decodeEventLog({ abi: [VERIFIED], data: verified!.data, topics: verified!.topics }).args.receiptHash).toBe(fixture.typedHash);

    // Drain the active submission before taking the chain snapshot used for replay.
    await worker.close();
    await indexChainOnce(indexerOpts);
    const scope = await getIndexerScope(indexerOpts);
    const recorded = await db.select().from(chainEvents).where(eq(chainEvents.scope, scope));
    expect(recorded.some((event) => event.source === "AttestationVerifier.Verified" && event.txHash === anchored!.anchoredTx)).toBe(true);
    expect(recorded.some((event) => event.source === "UsageMeter.Settled")).toBe(true);
    expect(new Set(recorded.map((event) => `${event.txHash}:${event.logIndex}`)).size).toBe(recorded.length);
    // This is the disposable integration database, and this cursor was created by this test.
    await resetChainIndexer(indexerOpts);
    await indexChainOnce(indexerOpts);
    expect(await db.select().from(chainEvents).where(eq(chainEvents.scope, scope))).toHaveLength(recorded.length);

    // A real fork invalidates the previously completed queue job and its SQL status.
    await testChain.revert({ id: snapshot });
    await testChain.mine({ blocks: 2, interval: 1 });
    const reconciled = await reconcileAnchoredReceipts({ db, log, rpcUrl: env.ARC_RPC_URL, chainId: env.ARC_CHAIN_ID, verifier: env.ATTESTATION_VERIFIER_ADDRESS });
    expect(reconciled.changed).toBeGreaterThan(0);
    expect((await db.select().from(receipts).where(eq(receipts.typedHash, fixture.typedHash)))[0]?.status).toBe("anchoring");
    expect(await job!.getState()).toBe("completed");
    await recoverReceiptJobs(db, queue);
    expect(await job!.getState()).toBe("waiting");
    await recoverSignerTransactions({ db, rpcUrl: env.ARC_RPC_URL, chainId: env.ARC_CHAIN_ID, privateKey: env.DEPLOYER_PRIVATE_KEY });
    worker = createWorker();
    await job!.waitUntilFinished(events, 45_000);
    const [repaired] = await db.select().from(receipts).where(eq(receipts.typedHash, fixture.typedHash));
    expect(repaired).toMatchObject({ status: "anchored", anchoredTx: anchored!.anchoredTx });
    const newProof = await client.getTransactionReceipt({ hash: repaired!.anchoredTx as Hex });
    expect(newProof.blockHash).not.toBe(confirmation.blockHash);
    await worker.close();
    await indexChainOnce(indexerOpts);
    const rebuilt = await db.select().from(chainEvents).where(eq(chainEvents.scope, scope));
    expect(rebuilt.filter((event) => event.txHash === repaired!.anchoredTx)).toHaveLength(1);
    expect(rebuilt.find((event) => event.txHash === repaired!.anchoredTx)?.blockHash).toBe(newProof.blockHash);
  }, 90_000);
});
