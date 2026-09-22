import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockNotFoundError, TransactionReceiptNotFoundError, encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { reconcileAnchoredReceipts, type ReceiptReconcileOptions } from "./receipt-recovery.js";
import { VERIFIED } from "./indexer.js";
import { sqlQuery, testDb } from "./test-db.js";

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn(), getTransactionReceipt: vi.fn() }));
vi.mock("viem", async (original) => ({ ...await original<typeof import("viem")>(), createPublicClient: () => rpc }));
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const verifier: Hex = "0x000000000000000000000000000000000000abcd";
const row = (overrides: Record<string, unknown> = {}) => ({ id: "receipt-id", chainId: 31337, verifierAddress: verifier, typedHash: hash(1), anchoredTx: hash(2), status: "anchored", ...overrides });
function proof(overrides: Record<string, unknown> = {}) {
  return { transactionHash: hash(2), blockHash: hash(10), blockNumber: 10n, status: "success", logs: [{
    address: verifier, topics: encodeEventTopics({ abi: [VERIFIED], eventName: "Verified", args: { receiptHash: hash(1) } }),
    data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }], [hash(3), hash(4), hash(5), hash(6), hash(7), verifier]),
  }], ...overrides };
}
function setup() {
  const mock = testDb(); const log = { warn: vi.fn() };
  mock.rows.mockResolvedValueOnce([row()]);
  mock.returning.mockResolvedValue([{ id: "receipt-id" }]);
  const opts: ReceiptReconcileOptions = { db: mock.db, rpcUrl: "http://rpc.test", chainId: 31337, verifier, log };
  return { mock, log, opts };
}
beforeEach(() => {
  vi.resetAllMocks();
  rpc.getChainId.mockResolvedValue(31337);
  rpc.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: hash(Number(blockNumber)) }));
  rpc.getBlockNumber.mockResolvedValue(20n);
  rpc.getTransactionReceipt.mockResolvedValue(proof());
});

describe("anchored receipt reconciliation", () => {
  it("retains a canonical Verified receipt, whether or not a historical journal exists", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([{ txHash: hash(2), confirmedBlockHash: hash(99), status: "confirmed" }]);
    expect(await reconcileAnchoredReceipts(opts)).toEqual({ checked: 1, changed: 0, afterId: undefined });
    expect(mock.update).not.toHaveBeenCalled();
    expect(sqlQuery(mock.query.where.mock.calls[1]![0]).params).toEqual([`31337:${hash(0)}`, `receipt:${hash(1)}`]);
  });
  it.each(["missing", "orphan", "missing-block", "depth"])("quarantines a %s proof for same-hash retry", async (kind) => {
    const { mock, opts } = setup();
    if (kind === "missing") rpc.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: hash(2) }));
    if (kind === "orphan") rpc.getTransactionReceipt.mockResolvedValue(proof({ blockHash: hash(99) }));
    if (kind === "missing-block") rpc.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => { if (blockNumber === 10n) throw new BlockNotFoundError({ blockNumber }); return { hash: hash(0) }; });
    if (kind === "depth") rpc.getBlockNumber.mockResolvedValue(12n);
    expect((await reconcileAnchoredReceipts({ ...opts, confirmations: 5 })).changed).toBe(1);
    expect(mock.set).toHaveBeenCalledWith({ status: "anchoring" });
    expect(sqlQuery(mock.writeWhere.mock.calls[0]![0]).params).toEqual(["receipt-id", "anchored", hash(2)]);
  });
  it.each(["reverted", "missing-event", "different-journal-hash", "invalid-hash", "null-hash"])("marks proven unusable anchors for operator review: %s", async (kind) => {
    const { mock, opts } = setup();
    if (kind === "reverted") rpc.getTransactionReceipt.mockResolvedValue(proof({ status: "reverted" }));
    if (kind === "missing-event") rpc.getTransactionReceipt.mockResolvedValue(proof({ logs: [] }));
    if (kind === "different-journal-hash") mock.rows.mockResolvedValueOnce([{ txHash: hash(99) }]);
    if (kind === "invalid-hash" || kind === "null-hash") mock.rows.mockReset().mockResolvedValueOnce([row({ anchoredTx: kind === "null-hash" ? null : "bad" })]);
    expect((await reconcileAnchoredReceipts(opts)).changed).toBe(1);
    expect(mock.set).toHaveBeenCalledWith({ status: "anchor_failed" });
    if (kind === "null-hash") expect(sqlQuery(mock.writeWhere.mock.calls[0]![0]).sql).toContain('"receipts"."anchored_tx" is null');
  });
  it.each(["outage", "foreign-hash"])("leaves the database untouched when RPC cannot prove a state: %s", async (kind) => {
    const { mock, log, opts } = setup();
    if (kind === "outage") rpc.getTransactionReceipt.mockRejectedValue(new Error("offline"));
    else rpc.getTransactionReceipt.mockResolvedValue(proof({ transactionHash: hash(99) }));
    expect((await reconcileAnchoredReceipts(opts)).changed).toBe(0);
    expect(mock.update).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith({ typedHash: hash(1) }, "receipt_proof_recheck_pending");
  });
  it("skips archived domains and unknown historical domains while advancing a bounded keyset", async () => {
    const { mock, opts } = setup();
    mock.rows.mockReset().mockResolvedValueOnce(Array.from({ length: 100 }, (_, id) => row({ id: String(id), chainId: id % 2 ? 1 : null })))
      .mockResolvedValueOnce([row({ verifierAddress: null }), row({ verifierAddress: "0x000000000000000000000000000000000000eeee" })]);
    expect(await reconcileAnchoredReceipts(opts)).toEqual({ checked: 100, changed: 0, afterId: "99" });
    expect(await reconcileAnchoredReceipts(opts, "99")).toEqual({ checked: 2, changed: 0, afterId: undefined });
    expect(sqlQuery(mock.query.where.mock.calls[1]![0]).params).toEqual(["anchored", "99"]);
    expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it("uses the default nonlocal depth and respects a concurrent repair CAS", async () => {
    const { mock, opts } = setup();
    rpc.getChainId.mockResolvedValue(1);
    mock.rows.mockReset().mockResolvedValueOnce([row({ chainId: 1 })]).mockResolvedValue([]);
    mock.returning.mockResolvedValue([]);
    expect((await reconcileAnchoredReceipts({ ...opts, chainId: 1 })).changed).toBe(0);
    expect(mock.set).toHaveBeenCalledWith({ status: "anchoring" });
  });
  it("skips simulated configuration and rejects unsafe RPC configuration before querying receipts", async () => {
    const { mock, opts } = setup();
    expect(await reconcileAnchoredReceipts({ ...opts, verifier: undefined })).toEqual({ checked: 0, changed: 0, afterId: undefined });
    await expect(reconcileAnchoredReceipts({ ...opts, confirmations: -1 })).rejects.toThrow("confirmation depth");
    rpc.getChainId.mockResolvedValueOnce(1);
    await expect(reconcileAnchoredReceipts(opts)).rejects.toThrow("chain mismatch");
    rpc.getBlock.mockResolvedValueOnce({ hash: null });
    await expect(reconcileAnchoredReceipts(opts)).rejects.toThrow("canonical genesis");
    expect(mock.select).not.toHaveBeenCalled();
  });
});
