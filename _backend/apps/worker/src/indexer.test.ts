import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { chainEvents, indexCursors, models } from "@enclave/db";
import { createPublicClient } from "viem";
import { APPROVED, LISTED, REVOKED, SETTLED, VERIFIED, addressReady, getIndexerScope, indexChainOnce, resetChainIndexer, startChainIndexer, type IndexerOpts } from "./indexer.js";
import { indexerScope, serializeCheckpoints } from "./reorg.js";
import { sqlQuery, testDb } from "./test-db.js";

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBlockNumber: vi.fn(), getBlock: vi.fn(), getLogs: vi.fn() }));
vi.mock("viem", async (importOriginal) => ({ ...await importOriginal<typeof import("viem")>(), createPublicClient: vi.fn(() => rpc) }));
const address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const hash = `0x${"11".repeat(32)}`;
const blockHash = (number: bigint, branch = 0): `0x${string}` => `0x${(number + 1n + BigInt(branch) * 100_000n).toString(16).padStart(64, "0")}`;
const header = (number: bigint) => ({ number, hash: blockHash(number), parentHash: number === 0n ? `0x${"0".repeat(64)}` : blockHash(number - 1n) });
function log(blockNumber = 10n, logIndex = 0, args: object = {}) {
  return { address, blockNumber, blockHash: blockHash(blockNumber), logIndex, args, transactionHash: hash, topics: [hash], data: "0x", removed: false };
}
function setup(overrides: Partial<IndexerOpts> = {}) {
  const mock = testDb();
  const opts: IndexerOpts = { db: mock.db, rpcUrl: "http://rpc.test", verifier: address, meter: undefined, log: pino({ enabled: false }), ...overrides };
  const scope = indexerScope({ ...opts, chainId: opts.chainId ?? 31337, genesisHash: blockHash(0n) });
  return { mock, opts, scope };
}
function saved(number: bigint, first = 0n, status = "active") {
  const checkpoints = Array.from({ length: Number(number - first + 1n) }, (_, index) => ({ number: first + BigInt(index), hash: blockHash(first + BigInt(index)) }));
  return { blockNumber: number, blockHash: blockHash(number), checkpoints: serializeCheckpoints(checkpoints), status };
}
beforeEach(() => {
  vi.clearAllMocks();
  rpc.getChainId.mockResolvedValue(31337);
  rpc.getBlockNumber.mockResolvedValue(10n);
  rpc.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => header(blockNumber));
  rpc.getLogs.mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); });

describe("confirmed chain indexing", () => {
  it("uses complete contract event shapes", () => {
    expect(VERIFIED.name).toBe("Verified");
    expect(SETTLED.inputs.some((input) => input.name === "confidentialPath")).toBe(true);
    expect([LISTED.name, APPROVED.name, REVOKED.name]).toEqual(["Listed", "Approved", "Revoked"]);
  });
  it.each([undefined, "invalid", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000004"])("ignores placeholder address %s", (value) => {
    expect(addressReady(value)).toBe(false);
    expect(addressReady(address)).toBe(true);
  });
  it("does no RPC or SQL work when every contract is unconfigured", async () => {
    const { mock, opts } = setup({ verifier: undefined });
    expect(await indexChainOnce(opts)).toBeUndefined();
    expect(createPublicClient).not.toHaveBeenCalled();
    expect(mock.select).not.toHaveBeenCalled();
  });
  it("holds the cross-process advisory lock before reading or advancing the scoped cursor", async () => {
    const { mock, opts, scope } = setup();
    rpc.getBlockNumber.mockResolvedValue(5000n);
    expect(await indexChainOnce(opts)).toEqual({ fromBlock: 0n, toBlock: 1999n });
    expect(sqlQuery(mock.sqlExecute.mock.calls[0]![0]).sql).toContain("pg_advisory_xact_lock");
    expect(sqlQuery(mock.sqlExecute.mock.calls[0]![0]).params).toEqual([scope]);
    expect(mock.sqlExecute.mock.invocationCallOrder[0]).toBeLessThan(mock.select.mock.invocationCallOrder[0]!);
    expect(mock.values).toHaveBeenLastCalledWith(expect.objectContaining({ name: scope, blockNumber: 1999n, blockHash: blockHash(1999n), status: "catching_up" }));
  });
  it("indexes only confirmed blocks and defaults nonlocal chains to twelve confirmations", async () => {
    const { opts } = setup({ chainId: 5042002 });
    rpc.getChainId.mockResolvedValue(5042002);
    expect(await indexChainOnce(opts)).toEqual({ fromBlock: 0n, toBlock: -1n });
    expect(rpc.getLogs).not.toHaveBeenCalled();
    expect(await indexChainOnce({ ...opts, confirmations: 2 })).toEqual({ fromBlock: 0n, toBlock: 8n });
    expect(rpc.getLogs).toHaveBeenCalledWith(expect.objectContaining({ toBlock: 8n }));
  });
  it("rejects wrong networks and invalid finality options before querying logs", async () => {
    const { opts } = setup({ chainId: 1 });
    await expect(indexChainOnce(opts)).rejects.toThrow("does not match");
    for (const override of [{ confirmations: -1 }, { confirmations: 0.5 }, { reorgWindow: 1 }, { batchSize: 2001 }]) {
      await expect(indexChainOnce({ ...opts, chainId: 31337, ...override })).rejects.toThrow("must be an integer");
    }
    expect(rpc.getLogs).not.toHaveBeenCalled();
  });
  it("resumes after genesis and validates caught-up headers without replaying logs", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([saved(0n)]);
    expect(await indexChainOnce(opts)).toEqual({ fromBlock: 1n, toBlock: 10n });
    mock.rows.mockResolvedValueOnce([saved(10n)]);
    rpc.getLogs.mockClear();
    expect(await indexChainOnce(opts)).toEqual({ fromBlock: 11n, toBlock: 10n });
    expect(rpc.getLogs).not.toHaveBeenCalled();
  });
  it("stores canonical mined logs idempotently with scope and block hashes", async () => {
    const { mock, opts, scope } = setup({ meter: address, feeVault: address });
    rpc.getLogs.mockResolvedValueOnce([log(), { ...log(), blockNumber: null }, { ...log(), transactionHash: null }, { ...log(), logIndex: null }, { ...log(), removed: true }])
      .mockResolvedValueOnce([log(10n, 1)]).mockResolvedValueOnce([log(10n, 2)]);
    await indexChainOnce(opts);
    expect(mock.insert.mock.calls.filter(([table]) => table === chainEvents)).toHaveLength(3);
    expect(mock.onConflictDoNothing).toHaveBeenCalledTimes(3);
    expect(mock.values).toHaveBeenCalledWith(expect.objectContaining({ scope, source: "AttestationVerifier.Verified", blockNumber: 10n, blockHash: blockHash(10n) }));
    expect(mock.insert).toHaveBeenLastCalledWith(indexCursors);
  });
  it("applies registry events in block/log order and preserves local catalog metadata", async () => {
    const { mock, opts, scope } = setup({ verifier: undefined, registry: address });
    rpc.getLogs.mockImplementation(async ({ event }: { event: { name: string } }) => {
      if (event.name === "Listed") return [log(8n, 0, { id: 1n, modelHash: hash, codeHash: hash, provider: address })];
      if (event.name === "Approved") return [log(10n, 2, { id: 1n }), log(8n, 1, { id: 1n })];
      return [log(10n, 1, { id: 1n })];
    });
    await indexChainOnce(opts);
    expect(mock.set.mock.calls.map(([value]) => value)).toEqual([{ approved: true, revoked: false }, { approved: false, revoked: true }, { approved: true, revoked: false }]);
    expect(mock.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({ set: { listingId: 1, chainScope: scope, approved: false, revoked: false } }));
  });
  it("never publishes historical approvals during a partial catch-up", async () => {
    const { mock, opts } = setup({ verifier: undefined, registry: address, batchSize: 2 });
    rpc.getLogs.mockResolvedValueOnce([log(0n, 0, { id: 1n, modelHash: hash, codeHash: hash, provider: address })])
      .mockResolvedValueOnce([log(1n, 0, { id: 1n })]).mockResolvedValueOnce([]);
    await indexChainOnce(opts);
    expect(mock.set).not.toHaveBeenCalledWith({ approved: true, revoked: false });
    expect(mock.set).toHaveBeenCalledWith({ approved: false, revoked: true });
  });
  it.each(["rpc", "foreign-block", "out-of-range", "malformed-listing", "oversized-id", "changing-head"])("does not checkpoint an inconsistent batch: %s", async (failure) => {
    const { mock, opts } = setup({ verifier: undefined, registry: address });
    if (failure === "rpc") rpc.getLogs.mockRejectedValue(new Error("RPC unavailable"));
    if (failure === "foreign-block") rpc.getLogs.mockResolvedValue([ { ...log(), blockHash: blockHash(10n, 1), args: { id: 1n, modelHash: hash, codeHash: hash, provider: address } } ]);
    if (failure === "out-of-range") rpc.getLogs.mockResolvedValue([log(11n, 0, { id: 1n, modelHash: hash, codeHash: hash, provider: address })]);
    if (failure === "malformed-listing") rpc.getLogs.mockResolvedValue([log()]);
    if (failure === "oversized-id") rpc.getLogs.mockResolvedValueOnce([]).mockResolvedValueOnce([log(10n, 0, { id: 2n ** 60n })]).mockResolvedValueOnce([]);
    if (failure === "changing-head") {
      let headReads = 0;
      rpc.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => ({ ...header(blockNumber), hash: blockNumber === 10n && ++headReads >= 3 ? blockHash(10n, 1) : blockHash(blockNumber) }));
    }
    await expect(indexChainOnce(opts)).rejects.toThrow();
    expect(mock.insert).not.toHaveBeenCalledWith(indexCursors);
  });
  it("leaves the prior checkpoint intact after a database batch failure", async () => {
    const { mock, opts } = setup();
    rpc.getLogs.mockResolvedValue([log()]);
    mock.onConflictDoNothing.mockRejectedValueOnce(new Error("DB offline"));
    await expect(indexChainOnce(opts)).rejects.toThrow("DB offline");
    expect(mock.insert).not.toHaveBeenCalledWith(indexCursors);
  });
  it("logs failed polls and retries the next interval", async () => {
    vi.useFakeTimers();
    const { opts } = setup();
    const warn = vi.spyOn(opts.log, "warn");
    rpc.getChainId.mockRejectedValueOnce(new Error("network"));
    const task = startChainIndexer({ ...opts, pollMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), "indexer_tick_failed");
    expect(rpc.getChainId).toHaveBeenCalledTimes(2);
    await task.stop();
  });
});

describe("reorg quarantine and recovery", () => {
  function forkAfter(ancestor: bigint) {
    rpc.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => ({
      ...header(blockNumber), hash: blockHash(blockNumber, blockNumber > ancestor ? 1 : 0),
      parentHash: blockHash(blockNumber - 1n, blockNumber - 1n > ancestor ? 1 : 0),
    }));
  }
  it("rewinds orphaned events and rebuilds only chain-owned policy from canonical history", async () => {
    const { mock, opts, scope } = setup({ verifier: undefined, registry: address });
    mock.rows.mockResolvedValueOnce([saved(4n)]).mockResolvedValueOnce([
      { payload: JSON.stringify({ registryEvent: { type: "Listed", listingId: 1, modelHash: hash, codeHash: hash, provider: address } }) },
      { payload: JSON.stringify({ registryEvent: { type: "Approved", listingId: 1 } }) },
    ]);
    forkAfter(2n);
    await indexChainOnce(opts);
    expect(mock.delete).toHaveBeenCalledWith(chainEvents);
    expect(mock.update).toHaveBeenCalledWith(models);
    expect(mock.set).toHaveBeenCalledWith({ approved: false, revoked: true, listingId: null });
    expect(mock.set).toHaveBeenLastCalledWith({ approved: true, revoked: false });
    expect(mock.values).toHaveBeenLastCalledWith(expect.objectContaining({ name: scope, blockNumber: 10n, blockHash: blockHash(10n, 1), status: "active" }));
  });
  it("commits fail-closed rewind even if the replacement branch RPC is unavailable", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([saved(4n)]);
    forkAfter(2n);
    rpc.getLogs.mockRejectedValue(new Error("replacement unavailable"));
    await expect(indexChainOnce(opts)).rejects.toThrow("replacement unavailable");
    expect(mock.set).toHaveBeenCalledWith({ approved: false, revoked: true });
    expect(mock.values).toHaveBeenLastCalledWith(expect.objectContaining({ blockNumber: 2n, status: "catching_up" }));
  });
  it("requires explicit reset when a fork exceeds retained history", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([saved(4n, 3n)]);
    forkAfter(1n);
    await expect(indexChainOnce(opts)).rejects.toThrow("INDEXER_REBUILD_REQUIRED");
    expect(mock.set).toHaveBeenCalledWith({ approved: false, revoked: true });
    expect(mock.set).toHaveBeenCalledWith(expect.objectContaining({ status: "rebuild_required" }));
    expect(mock.delete).not.toHaveBeenCalled();
    expect(rpc.getLogs).not.toHaveBeenCalled();
  });
  it("keeps a deep fork blocked on subsequent ticks", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([saved(4n, 3n, "rebuild_required")]);
    await expect(indexChainOnce(opts)).rejects.toThrow("explicitly reset");
    expect(rpc.getLogs).not.toHaveBeenCalled();
  });
  it("fails closed if saved checkpoint history is corrupt or cannot be checked", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([{ ...saved(4n), checkpoints: "broken" }]);
    await expect(indexChainOnce(opts)).rejects.toThrow("invalid checkpoint history");
    expect(mock.set).toHaveBeenCalledWith({ approved: false, revoked: true });
    mock.rows.mockResolvedValueOnce([saved(4n)]);
    rpc.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => { if (blockNumber === 4n) throw new Error("RPC down"); return header(blockNumber); });
    await expect(indexChainOnce(opts)).rejects.toThrow("RPC down");
    expect(mock.set).toHaveBeenLastCalledWith(expect.objectContaining({ status: "catching_up" }));
  });
  it("explicit reset only deletes the selected scoped journal and starts a fail-closed genesis replay", async () => {
    const { mock, opts, scope } = setup();
    expect(await getIndexerScope(opts)).toBe(scope);
    expect(await resetChainIndexer(opts)).toEqual({ scope });
    expect(mock.delete).toHaveBeenCalledExactlyOnceWith(chainEvents);
    expect(mock.values).toHaveBeenCalledWith(expect.objectContaining({ name: scope, blockNumber: -1n, status: "catching_up", checkpoints: "[]" }));
    expect(mock.set).toHaveBeenCalledWith({ approved: false, revoked: true });
  });
  it("rebuilds saved canonical policy even when a rewind needs no new blocks", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([saved(10n, 0n, "catching_up")]).mockResolvedValueOnce([]);
    await indexChainOnce(opts);
    expect(mock.set).toHaveBeenCalledWith({ approved: false, revoked: true, listingId: null });
    expect(mock.values).toHaveBeenLastCalledWith(expect.objectContaining({ status: "active" }));
  });
});
