import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockNotFoundError, TransactionReceiptNotFoundError, createWalletClient, encodeFunctionData, keccak256, parseAbi, type Hex } from "viem";
import { confirmDurableTransaction, recoverSignerTransactions, sendDurableTransaction, SignerNonceConflictError, TransactionProofError, TransactionRevertedError, type Database, type SignerOptions } from "@enclave/db";
import { sqlQuery, testDb } from "./test-db.js";

const rpc = vi.hoisted(() => ({
  account: { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
  getChainId: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn(), getTransactionCount: vi.fn(),
  getTransactionReceipt: vi.fn(), waitForTransactionReceipt: vi.fn(), getTransaction: vi.fn(),
  prepareTransactionRequest: vi.fn(), signTransaction: vi.fn(), sendRawTransaction: vi.fn(),
}));
vi.mock("viem", async (original) => ({ ...await original<typeof import("viem")>(), createWalletClient: vi.fn(() => ({ extend: () => rpc })) }));
const hash = (number: number): Hex => `0x${number.toString(16).padStart(64, "0")}`;
const raw: Hex = "0xdeadbeef";
const txHash = keccak256(raw);
const address: Hex = "0x000000000000000000000000000000000000abcd";
const abi = parseAbi(["function mint(address to, uint256 amount)"]);
const call = { address, abi, functionName: "mint", args: [address, 7n] };
const scope = `31337:${hash(0)}`;
const signer = rpc.account.address.toLowerCase();
const requestHash = keccak256(new TextEncoder().encode(`${address}:0:${encodeFunctionData({ abi, functionName: "mint", args: [address, 7n] })}`));
function row(overrides: Record<string, unknown> = {}) {
  return { id: "journal-row", scope, operationKey: "operation", requestHash, signer, nonce: 7n,
    rawTransaction: raw, txHash, status: "prepared", confirmedBlockNumber: null, confirmedBlockHash: null,
    error: null, createdAt: new Date(), updatedAt: new Date(), ...overrides };
}
function receipt(overrides: Record<string, unknown> = {}) {
  return { transactionHash: txHash, blockNumber: 10n, blockHash: hash(10), status: "success", logs: [], ...overrides };
}
function setup() {
  const mock = testDb();
  const opts: SignerOptions = { db: mock.db, rpcUrl: "http://rpc.test", chainId: 31337, privateKey: `0x${"11".repeat(32)}` };
  mock.returning.mockResolvedValue([row()]);
  return { mock, opts };
}
beforeEach(() => {
  vi.clearAllMocks();
  rpc.getChainId.mockResolvedValue(31337);
  rpc.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: hash(Number(blockNumber)) }));
  rpc.getBlockNumber.mockResolvedValue(20n);
  rpc.getTransactionCount.mockResolvedValue(7);
  rpc.getTransactionReceipt.mockResolvedValue(receipt());
  rpc.waitForTransactionReceipt.mockResolvedValue(receipt());
  rpc.getTransaction.mockResolvedValue({ hash: txHash });
  rpc.prepareTransactionRequest.mockResolvedValue({ nonce: 7 });
  rpc.signTransaction.mockResolvedValue(raw);
  rpc.sendRawTransaction.mockResolvedValue(txHash);
});

describe("durable signer commit and nonce safety", () => {
  it("rejects excessive Arc fees before signing or persisting a new transaction", async () => {
    const { mock, opts } = setup();
    opts.chainId = 5042;
    rpc.getChainId.mockResolvedValue(5042);
    rpc.prepareTransactionRequest.mockResolvedValue({ gas: 100_000n, maxFeePerGas: 101_000_000_000n });
    await expect(sendDurableTransaction(opts, "operation", call)).rejects.toThrow("ARC_RELAY_GAS_LIMIT");
    expect(rpc.signTransaction).not.toHaveBeenCalled();
    expect(mock.values).not.toHaveBeenCalled();
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("commits signed bytes before broadcasting and reserves the network nonce under the shared lock", async () => {
    const { mock, opts } = setup();
    let committed = false;
    mock.transaction.mockImplementation(async (run: (tx: Database) => Promise<unknown>) => { const result = await run(mock.db); committed = true; return result; });
    rpc.sendRawTransaction.mockImplementation(async () => { expect(committed).toBe(true); return txHash; });
    expect(await sendDurableTransaction(opts, "operation", call)).toBe(txHash);
    expect(sqlQuery(mock.sqlExecute.mock.calls[0]![0]).params).toEqual([`signer:${scope}:${signer}`]);
    expect(mock.values).toHaveBeenCalledWith(expect.objectContaining({ rawTransaction: raw, txHash, nonce: 7n, scope, signer }));
    expect(rpc.prepareTransactionRequest).toHaveBeenCalledWith(expect.objectContaining({ nonce: 7 }));
    expect(sqlQuery(mock.writeWhere.mock.calls.at(-1)![0]).params).toEqual(["journal-row", "prepared", "broadcast"]);
  });
  it("does not broadcast if committing the signed transaction fails", async () => {
    const { mock, opts } = setup();
    mock.transaction.mockImplementation(async (run: (tx: Database) => Promise<unknown>) => { await run(mock.db); throw new Error("commit failed"); });
    await expect(sendDurableTransaction(opts, "operation", call)).rejects.toThrow("commit failed");
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("rejects reuse of an operation key with a different call or signer", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([row({ requestHash: hash(99) })]);
    await expect(sendDurableTransaction(opts, "operation", call)).rejects.toThrow("different parameters");
    expect(rpc.signTransaction).not.toHaveBeenCalled();
  });
  it("returns a still-canonical confirmed operation without rebroadcast or status downgrade", async () => {
    const { mock, opts } = setup();
    const confirmed = row({ status: "confirmed", confirmedBlockNumber: 10n, confirmedBlockHash: hash(10) });
    mock.rows.mockResolvedValueOnce([confirmed]).mockResolvedValueOnce([confirmed]);
    expect(await sendDurableTransaction(opts, "operation", call)).toBe(txHash);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(mock.update).not.toHaveBeenCalled();
    expect(rpc.signTransaction).not.toHaveBeenCalled();
  });
  it("does not retry a canonically reverted operation with a new nonce", async () => {
    const { mock, opts } = setup();
    const reverted = row({ status: "reverted", confirmedBlockNumber: 10n, confirmedBlockHash: hash(10) });
    mock.rows.mockResolvedValueOnce([reverted]).mockResolvedValueOnce([reverted]);
    await expect(sendDurableTransaction(opts, "operation", call)).rejects.toBeInstanceOf(TransactionRevertedError);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("accepts a lost send response only when the exact transaction hash is observable", async () => {
    const { opts } = setup();
    rpc.sendRawTransaction.mockRejectedValue(new Error("timeout"));
    expect(await sendDurableTransaction(opts, "operation", call)).toBe(txHash);
    expect(rpc.getTransaction).toHaveBeenCalledWith({ hash: txHash });
  });
  it("keeps the committed bytes recoverable when neither broadcast nor lookup proves acceptance", async () => {
    const { mock, opts } = setup();
    rpc.sendRawTransaction.mockRejectedValue(new Error("unavailable"));
    rpc.getTransaction.mockRejectedValue(new Error("not found"));
    await expect(sendDurableTransaction(opts, "operation", call)).rejects.toThrow("unavailable");
    expect(mock.values).toHaveBeenCalled();
    expect(mock.update).not.toHaveBeenCalled();
  });
  it("halts allocation when an external transaction consumed an orphaned journal nonce", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([]).mockResolvedValueOnce([row({ nonce: 6n, status: "confirmed", confirmedBlockNumber: 10n, confirmedBlockHash: hash(99) })]);
    rpc.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: txHash }));
    await expect(sendDurableTransaction(opts, "new-operation", call)).rejects.toBeInstanceOf(SignerNonceConflictError);
    expect(rpc.signTransaction).not.toHaveBeenCalled();
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("does not allocate above an unresolved nonce gap", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([]).mockResolvedValueOnce([row({ nonce: 9n })]);
    rpc.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: txHash }));
    await expect(sendDurableTransaction(opts, "new-operation", call)).rejects.toThrow("nonce gap");
    expect(rpc.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: raw });
    expect(rpc.signTransaction).not.toHaveBeenCalled();
  });
  it("propagates an RPC outage instead of assuming a transaction was orphaned", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);
    rpc.getTransactionReceipt.mockRejectedValue(new Error("provider offline"));
    await expect(sendDurableTransaction(opts, "new-operation", call)).rejects.toThrow("provider offline");
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("refuses an unexpected broadcast hash when lookup also identifies a foreign transaction", async () => {
    const { opts } = setup();
    rpc.sendRawTransaction.mockResolvedValue(hash(99));
    rpc.getTransaction.mockResolvedValue({ hash: hash(99) });
    await expect(sendDurableTransaction(opts, "operation", call)).rejects.toBeInstanceOf(TransactionProofError);
  });
  it("persists the explicit payable amount as part of the immutable request", async () => {
    const { mock, opts } = setup();
    await sendDurableTransaction(opts, "payable-operation", { ...call, value: 8n });
    expect(rpc.prepareTransactionRequest).toHaveBeenCalledWith(expect.objectContaining({ value: 8n }));
    expect(mock.values.mock.calls[0]![0].requestHash).not.toBe(requestHash);
  });
  it("refuses network nonce values outside the signing library safe integer range", async () => {
    const { opts } = setup();
    rpc.getTransactionCount.mockResolvedValue(Number.MAX_SAFE_INTEGER + 1);
    await expect(sendDurableTransaction(opts, "operation", call)).rejects.toThrow("safe integer");
    expect(rpc.signTransaction).not.toHaveBeenCalled();
  });
  it("does not broadcast when the journal insert did not return a persisted row", async () => {
    const { mock, opts } = setup();
    mock.returning.mockResolvedValue([]);
    await expect(sendDurableTransaction(opts, "operation", call)).rejects.toThrow("persist signed transaction");
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("canonical transaction confirmation", () => {
  it("persists canonical block proof only for this network, signer and hash", async () => {
    const { mock, opts } = setup();
    expect(await confirmDurableTransaction(opts, txHash)).toEqual(receipt());
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: txHash, confirmations: 1, timeout: 60_000 });
    expect(mock.set).toHaveBeenCalledWith(expect.objectContaining({ status: "confirmed", confirmedBlockNumber: 10n, confirmedBlockHash: hash(10) }));
    expect(sqlQuery(mock.writeWhere.mock.calls[0]![0]).params).toEqual([scope, signer, txHash]);
  });
  it("uses twelve descendant blocks by default on a nonlocal chain", async () => {
    const { opts } = setup();
    rpc.getChainId.mockResolvedValue(5042002);
    rpc.getBlockNumber.mockResolvedValue(30n);
    await confirmDurableTransaction({ ...opts, chainId: 5042002 }, txHash);
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledWith(expect.objectContaining({ confirmations: 13 }));
  });
  it.each(["replacement", "foreign-rpc-hash", "orphan", "missing-block", "insufficient-depth"])("rejects an invalid confirmation proof: %s", async (failure) => {
    const { mock, opts } = setup();
    if (failure === "replacement") rpc.waitForTransactionReceipt.mockResolvedValue(receipt({ transactionHash: hash(99) }));
    if (failure === "foreign-rpc-hash") rpc.getTransactionReceipt.mockResolvedValue(receipt({ transactionHash: hash(99) }));
    if (failure === "orphan") rpc.getTransactionReceipt.mockResolvedValue(receipt({ blockHash: hash(99) }));
    if (failure === "missing-block") rpc.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => { if (blockNumber === 10n) throw new BlockNotFoundError({ blockNumber }); return { hash: hash(0) }; });
    if (failure === "insufficient-depth") rpc.getBlockNumber.mockResolvedValue(14n);
    await expect(confirmDurableTransaction({ ...opts, confirmations: 5 }, txHash)).rejects.toBeInstanceOf(TransactionProofError);
    expect(mock.update).not.toHaveBeenCalled();
  });
  it("validates the RPC chain and depth before confirming anything", async () => {
    const { opts } = setup();
    rpc.getChainId.mockResolvedValue(1);
    await expect(confirmDurableTransaction(opts, txHash)).rejects.toThrow("chain ID");
    await expect(confirmDurableTransaction({ ...opts, confirmations: -1 }, txHash)).rejects.toThrow("confirmation depth");
    expect(rpc.waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(createWalletClient).toHaveBeenCalledOnce();
  });
  it("records a canonical reverted proof before returning the typed failure", async () => {
    const { mock, opts } = setup();
    rpc.getTransactionReceipt.mockResolvedValue(receipt({ status: "reverted" }));
    await expect(confirmDurableTransaction(opts, txHash)).rejects.toBeInstanceOf(TransactionRevertedError);
    expect(mock.set).toHaveBeenCalledWith(expect.objectContaining({ status: "reverted", confirmedBlockNumber: 10n, confirmedBlockHash: hash(10) }));
  });
  it("refuses an RPC without canonical genesis and does not query its journal", async () => {
    const { mock, opts } = setup();
    rpc.getBlock.mockResolvedValue({ hash: null });
    await expect(confirmDurableTransaction(opts, txHash)).rejects.toThrow("canonical genesis");
    expect(mock.transaction).not.toHaveBeenCalled();
  });
  it("propagates a block RPC outage without recording a misleading orphan state", async () => {
    const { mock, opts } = setup();
    rpc.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => {
      if (blockNumber === 10n) throw new Error("header service down");
      return { hash: hash(0) };
    });
    await expect(confirmDurableTransaction(opts, txHash)).rejects.toThrow("header service down");
    expect(mock.update).not.toHaveBeenCalled();
  });
});

describe("signer journal recovery", () => {
  it("replays previously confirmed bytes after a fork and records the new canonical proof", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([row({ status: "confirmed", confirmedBlockNumber: 10n, confirmedBlockHash: hash(99) })]);
    rpc.getTransactionReceipt.mockRejectedValueOnce(new TransactionReceiptNotFoundError({ hash: txHash })).mockResolvedValue(receipt({ blockNumber: 11n, blockHash: hash(11) }));
    rpc.waitForTransactionReceipt.mockResolvedValue(receipt({ blockNumber: 11n, blockHash: hash(11) }));
    expect(await recoverSignerTransactions(opts)).toBe(1);
    expect(rpc.sendRawTransaction).toHaveBeenCalledExactlyOnceWith({ serializedTransaction: raw });
    expect(mock.set).toHaveBeenLastCalledWith(expect.objectContaining({ status: "confirmed", confirmedBlockNumber: 11n, confirmedBlockHash: hash(11) }));
  });
  it("finalizes an accepted operation after its process died before saving confirmation", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([row({ status: "broadcast" })]);
    expect(await recoverSignerTransactions(opts)).toBe(1);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(mock.set).toHaveBeenCalledWith(expect.objectContaining({ status: "confirmed" }));
  });
  it("continues after a proven revert but propagates uncertain confirmation failures", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([row()]);
    rpc.getTransactionReceipt.mockResolvedValue(receipt({ status: "reverted" }));
    expect(await recoverSignerTransactions(opts)).toBe(1);
    mock.rows.mockResolvedValueOnce([row()]);
    rpc.waitForTransactionReceipt.mockRejectedValue(new Error("confirmation timeout"));
    await expect(recoverSignerTransactions(opts)).rejects.toThrow("confirmation timeout");
  });
  it("does not preserve an earlier low-depth confirmation when the required depth increases", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([row({ status: "confirmed", confirmedBlockNumber: 10n, confirmedBlockHash: hash(10) })]);
    rpc.getBlockNumber.mockResolvedValueOnce(12n).mockResolvedValue(20n);
    expect(await recoverSignerTransactions({ ...opts, confirmations: 5 })).toBe(1);
    expect(mock.set).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: "broadcast", confirmedBlockNumber: null, confirmedBlockHash: null }));
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledWith(expect.objectContaining({ confirmations: 6 }));
    expect(mock.set).toHaveBeenLastCalledWith(expect.objectContaining({ status: "confirmed" }));
  });
  it("rechecks historical confirmations in one block with a shared canonical header", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValueOnce([
      row({ status: "confirmed", confirmedBlockNumber: 10n, confirmedBlockHash: hash(10) }),
      row({ id: "other", nonce: 8n, status: "reverted", confirmedBlockNumber: 10n, confirmedBlockHash: hash(10) }),
    ]);
    expect(await recoverSignerTransactions(opts)).toBe(0);
    expect(rpc.getBlock).toHaveBeenCalledTimes(2);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
});
