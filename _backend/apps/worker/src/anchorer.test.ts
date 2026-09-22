import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { receipts, TransactionRevertedError } from "@enclave/db";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { VERIFIED } from "./indexer.js";
import { anchorReceipt, type AnchorerOpts } from "./anchorer.js";
import { testDb } from "./test-db.js";

const rpc = vi.hoisted(() => ({ send: vi.fn(), confirm: vi.fn() }));
vi.mock("@enclave/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@enclave/db")>(),
  sendDurableTransaction: rpc.send, confirmDurableTransaction: rpc.confirm,
}));
const hash = `0x${"11".repeat(32)}`;
const tx = `0x${"22".repeat(32)}`;
const replacement = `0x${"33".repeat(32)}`;
const verifier = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const privateKey = `0x${"12".repeat(32)}` as const;
const row = {
  typedHash: hash, status: "pending", anchoredTx: null, receiptVersion: 1, nonce: null, chainId: null, verifierAddress: null,
  modelHash: hash, codeHash: hash, inHash: hash, outHash: hash, attRef: hash,
  ts: 123n, sig: `0x${"44".repeat(65)}`,
};
const verifiedLog = {
  address: verifier,
  topics: encodeEventTopics({ abi: [VERIFIED], eventName: "Verified", args: { receiptHash: `0x${"11".repeat(32)}` } }),
  data: encodeAbiParameters([
    { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" },
  ], [`0x${"11".repeat(32)}`, `0x${"11".repeat(32)}`, `0x${"11".repeat(32)}`, `0x${"11".repeat(32)}`, `0x${"11".repeat(32)}`, verifier]),
};
function setup(overrides: Partial<AnchorerOpts> = {}) {
  const mock = testDb();
  mock.rows.mockResolvedValue([{ ...row }]);
  const opts: AnchorerOpts = { db: mock.db, verifier, rpcUrl: "http://rpc.test", privateKey, log: pino({ enabled: false }), ...overrides };
  return { mock, opts };
}
beforeEach(() => {
  vi.clearAllMocks();
  rpc.send.mockResolvedValue(tx);
  rpc.confirm.mockResolvedValue({ status: "success", transactionHash: tx, logs: [verifiedLog] });
});

describe("receipt anchoring", () => {
  it.each([{}, { typedHash: "garbage" }, { typedHash: 1 }, null])("rejects malformed job data before touching the database: %j", async (data) => {
    const { mock, opts } = setup();
    await expect(anchorReceipt(opts, data)).rejects.toThrow();
    expect(mock.select).not.toHaveBeenCalled();
  });
  it("handles a missing receipt without sending a transaction", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValue([]);
    await anchorReceipt(opts, { typedHash: hash });
    expect(mock.update).not.toHaveBeenCalled();
    expect(rpc.send).not.toHaveBeenCalled();
  });
  it.each([undefined, "0x0000000000000000000000000000000000000004"])("simulates unconfigured verifier %s without sending RPC", async (address) => {
    const { mock, opts } = setup({ verifier: address });
    await anchorReceipt(opts, { typedHash: hash });
    expect(mock.update).toHaveBeenCalledWith(receipts);
    expect(mock.set).toHaveBeenCalledExactlyOnceWith({ status: "anchored-sim", anchoredTx: `sim:${hash.slice(0, 18)}` });
    expect(rpc.send).not.toHaveBeenCalled();
  });
  it.each(["anchored", "anchored-sim"])("does not repeat a completed %s job", async (status) => {
    const { mock, opts } = setup({ verifier: status === "anchored-sim" ? undefined : verifier });
    mock.rows.mockResolvedValue([{ ...row, status, anchoredTx: tx }]);
    await anchorReceipt(opts, { typedHash: hash });
    expect(mock.update).not.toHaveBeenCalled();
    expect(rpc.send).not.toHaveBeenCalled();
  });
  it("submits the persisted receipt, records the transaction before confirmation, then marks it anchored", async () => {
    const { mock, opts } = setup({ chainId: 5042002 });
    rpc.confirm.mockImplementation(async () => {
      expect(mock.set).toHaveBeenCalledExactlyOnceWith({ status: "anchoring", anchoredTx: tx });
      return { status: "success", transactionHash: replacement, logs: [verifiedLog] };
    });
    await anchorReceipt(opts, { typedHash: hash });
    expect(rpc.send).toHaveBeenCalledWith(expect.objectContaining({ chainId: 5042002 }), `receipt:${hash}`, expect.anything());
    expect(rpc.send).toHaveBeenCalledWith(expect.anything(), `receipt:${hash}`, expect.objectContaining({ address: verifier, functionName: "verifyLegacyReceipt", args: [{ modelHash: hash, codeHash: hash, inHash: hash, outHash: hash, attRef: hash, ts: 123n }, row.sig] }));
    expect(mock.set).toHaveBeenLastCalledWith({ status: "anchored", anchoredTx: replacement });
  });
  it("allows a simulated receipt to be upgraded to a real on-chain receipt", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValue([{ ...row, status: "anchored-sim", anchoredTx: "sim:old" }]);
    await anchorReceipt(opts, { typedHash: hash });
    expect(rpc.send).toHaveBeenCalledOnce();
    expect(mock.set).toHaveBeenLastCalledWith({ status: "anchored", anchoredTx: tx });
  });
  it("reuses a persisted transaction after an RPC confirmation timeout", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValue([{ ...row, status: "anchoring", anchoredTx: tx }]);
    await anchorReceipt(opts, { typedHash: hash });
    expect(rpc.send).not.toHaveBeenCalled();
    expect(rpc.confirm).toHaveBeenCalledWith(expect.anything(), tx);
    expect(mock.set).toHaveBeenCalledExactlyOnceWith({ status: "anchored", anchoredTx: tx });
  });
  it("keeps an unconfirmed transaction for the next attempt", async () => {
    const { mock, opts } = setup();
    rpc.confirm.mockRejectedValue(new Error("RPC timeout"));
    await expect(anchorReceipt(opts, { typedHash: hash })).rejects.toThrow("RPC timeout");
    expect(mock.set).toHaveBeenCalledExactlyOnceWith({ status: "anchoring", anchoredTx: tx });
  });
  it("records a proven reverted durable operation as a terminal failure", async () => {
    const { mock, opts } = setup();
    rpc.confirm.mockRejectedValue(new TransactionRevertedError(`0x${"22".repeat(32)}`));
    await expect(anchorReceipt(opts, { typedHash: hash })).rejects.toThrow("reverted");
    expect(mock.set).toHaveBeenLastCalledWith({ status: "anchor_failed", anchoredTx: tx });
    expect(mock.set).not.toHaveBeenCalledWith(expect.objectContaining({ status: "anchored" }));
  });
  it("does not change receipt state when submission fails", async () => {
    const { mock, opts } = setup();
    rpc.send.mockRejectedValue(new Error("contract rejected"));
    await expect(anchorReceipt(opts, { typedHash: hash })).rejects.toThrow("contract rejected");
    expect(mock.update).not.toHaveBeenCalled();
  });
  it.each([
    { logs: [] },
    { logs: [{ ...verifiedLog, address: "0x0000000000000000000000000000000000001234" }] },
    { logs: [{ ...verifiedLog, data: "0xinvalid" }] },
    { logs: [{ ...verifiedLog, topics: encodeEventTopics({ abi: [VERIFIED], eventName: "Verified", args: { receiptHash: `0x${"ff".repeat(32)}` } }) }] },
  ])("rejects a successful replacement transaction without the expected verifier event", async ({ logs }) => {
    const { mock, opts } = setup();
    rpc.confirm.mockResolvedValue({ status: "success", transactionHash: replacement, logs });
    await expect(anchorReceipt(opts, { typedHash: hash })).rejects.toThrow("did not verify the requested receipt");
    expect(mock.set).toHaveBeenLastCalledWith({ status: "anchor_failed", anchoredTx: replacement });
  });
  it("anchors receipt v2 with its signed nonce and an immutable operation key", async () => {
    const { mock, opts } = setup({ chainId: 31337, confirmations: 2 });
    mock.rows.mockResolvedValue([{ ...row, receiptVersion: 2, nonce: hash, chainId: 31337, verifierAddress: verifier.toLowerCase() }]);
    await anchorReceipt(opts, { typedHash: hash });
    expect(rpc.send).toHaveBeenCalledWith(expect.objectContaining({ chainId: 31337, confirmations: 2 }), `receipt:${hash}`, expect.objectContaining({
      functionName: "verifyReceipt", args: [{ modelHash: hash, codeHash: hash, inHash: hash, outHash: hash, attRef: hash, ts: 123n, nonce: hash }, row.sig],
    }));
  });
  it.each([
    { chainId: 1 }, { verifierAddress: "0x000000000000000000000000000000000000abcd" },
    { receiptVersion: 3 }, { receiptVersion: 2, nonce: null }, { codeHash: "not-a-hash" }, { ts: -1n },
  ])("rejects malformed or foreign-domain receipts before allocating a durable transaction", async (invalid) => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValue([{ ...row, ...invalid }]);
    await expect(anchorReceipt(opts, { typedHash: hash })).rejects.toThrow();
    expect(rpc.send).not.toHaveBeenCalled();
    expect(mock.update).not.toHaveBeenCalled();
  });
  it("does not automatically resubmit a proven failed receipt", async () => {
    const { mock, opts } = setup();
    mock.rows.mockResolvedValue([{ ...row, status: "anchor_failed", anchoredTx: tx }]);
    await expect(anchorReceipt(opts, { typedHash: hash })).rejects.toThrow("operator review");
    expect(rpc.send).not.toHaveBeenCalled();
  });
  it("retains the durable transaction hash if a prior attempt already proved a revert", async () => {
    const { mock, opts } = setup();
    rpc.send.mockRejectedValue(new TransactionRevertedError(`0x${"22".repeat(32)}`));
    await expect(anchorReceipt(opts, { typedHash: hash })).rejects.toThrow("reverted");
    expect(mock.set).toHaveBeenLastCalledWith({ status: "anchor_failed", anchoredTx: tx });
    expect(rpc.confirm).not.toHaveBeenCalled();
  });
});
