import { isConfiguredAddress } from "@enclave/core";
import { and, eq, gt, sql } from "drizzle-orm";
import { createPublicClient, http, parseAbiItem, type Address, type Log } from "viem";
import { foundry } from "viem/chains";
import { chainEvents, indexCursors, type Database } from "@enclave/db";
import type { Logger } from "pino";
import { applyRegistrySync, quarantineRegistryScope, rebuildRegistryPolicy, type RegistrySyncEvent } from "./policy-sync.js";
import { checkpointTail, findCommonAncestor, indexerScope, parseCheckpoints, serializeCheckpoints, type ChainHeader, type Checkpoint } from "./reorg.js";
import { startPolling, type PollingTask } from "./polling.js";

export const VERIFIED = parseAbiItem("event Verified(bytes32 indexed receiptHash, bytes32 modelHash, bytes32 codeHash, bytes32 inHash, bytes32 outHash, bytes32 attRef, address signer)");
export const SETTLED = parseAbiItem("event Settled(address indexed payer, uint256 amount, bytes32 indexed receiptHash, bool confidentialPath)");
export const BUYBACK = parseAbiItem("event BuybackQueued(address indexed caller, uint256 usdcAmount, uint64 queuedAt)");
export const LISTED = parseAbiItem("event Listed(uint256 indexed id, bytes32 modelHash, bytes32 codeHash, address provider)");
export const APPROVED = parseAbiItem("event Approved(uint256 indexed id)");
export const REVOKED = parseAbiItem("event Revoked(uint256 indexed id)");

export function addressReady(value: string | undefined): value is Address { return isConfiguredAddress(value); }

export type IndexerOpts = {
  db: Database;
  rpcUrl: string;
  verifier: string | undefined;
  meter: string | undefined;
  feeVault?: string | undefined;
  registry?: string | undefined;
  log: Logger;
  chainId?: number;
  confirmations?: number;
  deploymentId?: string;
  reorgWindow?: number;
  batchSize?: number;
};
type Writer = Pick<Database, "insert" | "update">;
type Result = { fromBlock: bigint; toBlock: bigint };
type DeferredResult = { result: Result; error?: never } | { error: unknown; result?: never };
type Batch = { source: string; entries: { log: Log; registryEvent?: RegistrySyncEvent }[] };

function positiveOption(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

async function context(opts: IndexerOpts) {
  const client = createPublicClient({ chain: { ...foundry, id: opts.chainId ?? foundry.id }, transport: http(opts.rpcUrl), cacheTime: 0 });
  const chainId = await client.getChainId();
  if (opts.chainId !== undefined && opts.chainId !== chainId) throw new Error(`RPC chain ${chainId} does not match configured chain ${opts.chainId}`);
  const confirmations = positiveOption("confirmations", opts.confirmations ?? ([31337, 1337].includes(chainId) ? 0 : 12), 0, 100_000);
  const window = positiveOption("reorgWindow", opts.reorgWindow ?? 128, 2, 4096);
  const batchSize = positiveOption("batchSize", opts.batchSize ?? 2000, 1, 2000);
  async function readHeader(number: bigint): Promise<ChainHeader> {
    const block = await client.getBlock({ blockNumber: number });
    if (block.number !== number || block.hash === null) throw new Error(`Missing canonical header ${number}`);
    return { number, hash: block.hash, parentHash: block.parentHash };
  }
  const genesis = await readHeader(0n);
  const scope = indexerScope({ ...opts, chainId, genesisHash: genesis.hash });
  return { client, readHeader, scope, confirmations, window, batchSize };
}

export async function getIndexerScope(opts: IndexerOpts): Promise<string> { return (await context(opts)).scope; }

async function saveCursor(db: Writer, name: string, blockNumber: bigint, checkpoints: Checkpoint[], status = "active"): Promise<void> {
  const state = { blockNumber, blockHash: checkpoints.at(-1)?.hash ?? null, checkpoints: serializeCheckpoints(checkpoints), status, updatedAt: new Date() };
  await db.insert(indexCursors).values({ name, ...state }).onConflictDoUpdate({ target: indexCursors.name, set: state });
}

function isMined(log: Log): boolean {
  return log.transactionHash != null && log.logIndex != null && log.blockNumber != null && log.blockHash != null && !log.removed;
}

function listingId(id: bigint | undefined): number {
  if (id === undefined || id < 1n || id > 2_147_483_647n) throw new RangeError("Registry listing id is outside the supported database range");
  return Number(id);
}

async function readBatch(opts: IndexerOpts, ctx: Awaited<ReturnType<typeof context>>, fromBlock: bigint, toBlock: bigint, previous: Checkpoint[]) {
  const { client, readHeader } = ctx;
  const before = await readHeader(toBlock);
  const batches: Batch[] = [];
  if (addressReady(opts.verifier)) {
    const logs = await client.getLogs({ address: opts.verifier, event: VERIFIED, fromBlock, toBlock });
    batches.push({ source: "AttestationVerifier.Verified", entries: logs.filter(isMined).map((log) => ({ log })) });
  }
  if (addressReady(opts.meter)) {
    const logs = await client.getLogs({ address: opts.meter, event: SETTLED, fromBlock, toBlock });
    batches.push({ source: "UsageMeter.Settled", entries: logs.filter(isMined).map((log) => ({ log })) });
  }
  if (addressReady(opts.feeVault)) {
    const logs = await client.getLogs({ address: opts.feeVault, event: BUYBACK, fromBlock, toBlock });
    batches.push({ source: "FeeVault.BuybackQueued", entries: logs.filter(isMined).map((log) => ({ log })) });
  }
  if (addressReady(opts.registry)) {
    const listed = await client.getLogs({ address: opts.registry, event: LISTED, fromBlock, toBlock });
    const approved = await client.getLogs({ address: opts.registry, event: APPROVED, fromBlock, toBlock });
    const revoked = await client.getLogs({ address: opts.registry, event: REVOKED, fromBlock, toBlock });
    batches.push({ source: "ModelRegistry.Listed", entries: listed.filter(isMined).map((log) => {
      const { modelHash, codeHash, provider } = log.args;
      if (!modelHash || !codeHash || !provider) throw new Error("Malformed confirmed registry listing");
      return { log, registryEvent: { type: "Listed", listingId: listingId(log.args.id), modelHash, codeHash, provider } };
    }) });
    batches.push({ source: "ModelRegistry.Approved", entries: approved.filter(isMined).map((log) => ({ log, registryEvent: { type: "Approved", listingId: listingId(log.args.id) } })) });
    batches.push({ source: "ModelRegistry.Revoked", entries: revoked.filter(isMined).map((log) => ({ log, registryEvent: { type: "Revoked", listingId: listingId(log.args.id) } })) });
  }
  const headerCache = new Map<bigint, ChainHeader>();
  const tailStart = toBlock - BigInt(ctx.window) + 1n;
  const firstHeader = tailStart > fromBlock ? tailStart : fromBlock;
  const headers: ChainHeader[] = [];
  for (let number = firstHeader; number <= toBlock; number++) {
    const header = await readHeader(number);
    headerCache.set(number, header);
    headers.push(header);
  }
  for (const batch of batches) {
    for (const { log } of batch.entries) {
      if (log.blockNumber === null || log.blockNumber < fromBlock || log.blockNumber > toBlock) throw new Error("RPC returned an event outside the requested block range");
      let header = headerCache.get(log.blockNumber);
      if (!header) { header = await readHeader(log.blockNumber); headerCache.set(log.blockNumber, header); }
      if (log.blockHash?.toLowerCase() !== header.hash.toLowerCase()) throw new Error("RPC event belongs to a noncanonical block");
    }
  }
  const after = await readHeader(toBlock);
  if (after.hash.toLowerCase() !== before.hash.toLowerCase()) throw new Error("Chain reorganized while fetching events");
  const checkpoints = checkpointTail(previous, headers, ctx.window);
  return { batches, checkpoints };
}

async function store(db: Writer, scope: string, batches: Batch[]): Promise<void> {
  for (const batch of batches) {
    for (const { log, registryEvent } of batch.entries) {
      // REASON: readBatch only returns mined logs, checked against canonical headers.
      await db.insert(chainEvents).values({
        scope, source: batch.source, txHash: log.transactionHash!, logIndex: log.logIndex!,
        blockNumber: log.blockNumber!, blockHash: log.blockHash,
        payload: JSON.stringify({ address: log.address, topics: log.topics, data: log.data, blockNumber: log.blockNumber!.toString(), blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex, registryEvent }),
      }).onConflictDoNothing();
    }
  }
}

/** Index a confirmed snapshot under a database-wide lock shared by every worker instance. */
export async function indexChainOnce(opts: IndexerOpts): Promise<Result | undefined> {
  if (![opts.verifier, opts.meter, opts.feeVault, opts.registry].some(addressReady)) return undefined;
  const ctx = await context(opts);
  const outcome = await opts.db.transaction(async (db): Promise<DeferredResult> => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.scope}, 0))`);
    const [saved] = await db.select().from(indexCursors).where(eq(indexCursors.name, ctx.scope)).limit(1);
    const latest = await ctx.client.getBlockNumber({ cacheTime: 0 });
    const confirmed = latest >= BigInt(ctx.confirmations) ? latest - BigInt(ctx.confirmations) : -1n;
    let cursor = saved?.blockNumber ?? -1n;
    let checkpoints: Checkpoint[] = [];
    let rebuild = saved?.status === "catching_up";
    if (saved?.status === "rebuild_required") return { error: new Error(`INDEXER_REBUILD_REQUIRED: explicitly reset ${ctx.scope} to replay from genesis`) };
    if (cursor >= 0n) {
      try {
        checkpoints = parseCheckpoints(saved?.checkpoints ?? "[]");
        if (checkpoints.at(-1)?.number !== cursor || checkpoints.at(-1)?.hash !== saved?.blockHash) throw new Error("Indexer cursor has no matching checkpoint");
      } catch (err) {
        await quarantineRegistryScope(db, ctx.scope);
        await db.update(indexCursors).set({ status: "rebuild_required", updatedAt: new Date() }).where(eq(indexCursors.name, ctx.scope));
        return { error: new Error(`INDEXER_REBUILD_REQUIRED: invalid checkpoint history for ${ctx.scope}`, { cause: err }) };
      }
      let ancestor: Checkpoint | undefined;
      try {
        ancestor = await findCommonAncestor(checkpoints, confirmed, ctx.readHeader);
      } catch (error) {
        // Do not keep serving cached approvals while canonical history cannot be checked.
        await quarantineRegistryScope(db, ctx.scope);
        await db.update(indexCursors).set({ status: "catching_up", updatedAt: new Date() }).where(eq(indexCursors.name, ctx.scope));
        return { error };
      }
      if (!ancestor) {
        await quarantineRegistryScope(db, ctx.scope);
        await db.update(indexCursors).set({ status: "rebuild_required", updatedAt: new Date() }).where(eq(indexCursors.name, ctx.scope));
        return { error: new Error(`INDEXER_REBUILD_REQUIRED: fork exceeds retained history for ${ctx.scope}; explicitly reset and replay genesis`) };
      }
      if (ancestor.number !== cursor) {
        await quarantineRegistryScope(db, ctx.scope);
        await db.delete(chainEvents).where(and(eq(chainEvents.scope, ctx.scope), gt(chainEvents.blockNumber, ancestor.number)));
        checkpoints = checkpoints.filter((block) => block.number <= ancestor.number);
        cursor = ancestor.number;
        rebuild = true;
        await saveCursor(db, ctx.scope, cursor, checkpoints, "catching_up");
        opts.log.warn({ scope: ctx.scope, ancestor: cursor.toString() }, "indexer_reorg_rewound");
      }
    }
    const fromBlock = cursor + 1n;
    if (fromBlock > confirmed) {
      if (rebuild && cursor === confirmed) {
        try {
          await db.transaction(async (stage) => {
            await rebuildRegistryPolicy(stage, ctx.scope);
            await saveCursor(stage, ctx.scope, cursor, checkpoints);
          });
        } catch (error) { return { error }; }
      }
      return { result: { fromBlock, toBlock: confirmed } };
    }
    const end = fromBlock + BigInt(ctx.batchSize) - 1n;
    const toBlock = end < confirmed ? end : confirmed;
    let batch: Awaited<ReturnType<typeof readBatch>>;
    try {
      batch = await readBatch(opts, ctx, fromBlock, toBlock, checkpoints);
    } catch (error) {
      // A known fork's quarantine and rewind must commit even when the replacement RPC fails.
      return { error };
    }
    try {
      // Savepoint: a failed replacement batch cannot undo the outer reorg quarantine.
      await db.transaction(async (stage) => {
        await store(stage, ctx.scope, batch.batches);
        const events = batch.batches.flatMap((entry) => entry.entries).sort((a, b) => {
          const left = a.log.blockNumber!; const right = b.log.blockNumber!;
          return left < right ? -1 : left > right ? 1 : a.log.logIndex! - b.log.logIndex!;
        });
        const catchingUp = toBlock < confirmed;
        if (catchingUp) {
          for (const entry of events) if (entry.registryEvent?.type === "Listed") await applyRegistrySync(stage, entry.registryEvent, ctx.scope);
          await quarantineRegistryScope(stage, ctx.scope);
        } else if (rebuild) {
          await rebuildRegistryPolicy(stage, ctx.scope);
        } else {
          for (const entry of events) if (entry.registryEvent) await applyRegistrySync(stage, entry.registryEvent, ctx.scope);
        }
        await saveCursor(stage, ctx.scope, toBlock, batch.checkpoints, catchingUp ? "catching_up" : "active");
      });
    } catch (error) { return { error }; }
    return { result: { fromBlock, toBlock } };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

/** Explicit operator recovery. Only this chain/deployment's journal and cursor are reset. */
export async function resetChainIndexer(opts: IndexerOpts): Promise<{ scope: string }> {
  const { scope } = await context(opts);
  await opts.db.transaction(async (db) => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scope}, 0))`);
    await quarantineRegistryScope(db, scope);
    await db.delete(chainEvents).where(eq(chainEvents.scope, scope));
    await saveCursor(db, scope, -1n, [], "catching_up");
  });
  return { scope };
}

export function startChainIndexer(opts: IndexerOpts & { pollMs?: number }): PollingTask {
  return startPolling(async () => {
    try { await indexChainOnce(opts); }
    catch (err) { opts.log.warn({ err }, "indexer_tick_failed"); }
  }, opts.pollMs ?? 2000);
}
