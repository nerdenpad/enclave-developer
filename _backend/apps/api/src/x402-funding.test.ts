import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, encodeAbiParameters, encodeEventTopics, encodeFunctionData, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sendDurableTransaction, type Database } from "@enclave/db";
import { loadConfig } from "./config.js";
import { createX402Facilitator, verifyX402FundingProof } from "./chain.js";
import { transferAuthorizationTypes, type TransferAuthorization } from "./x402-v2.js";

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getTransactionReceipt: vi.fn(), getTransaction: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn(), getCode: vi.fn(), getLogs: vi.fn() }));
vi.mock("viem", async (importOriginal) => ({ ...await importOriginal<typeof import("viem")>(),
  createPublicClient: vi.fn(() => rpc), http: vi.fn(() => ({ name: "mock-x402-rpc" })),
  createWalletClient: vi.fn(() => ({ extend: () => ({}) })),
}));
vi.mock("@enclave/db", async (importOriginal) => ({ ...await importOriginal<typeof import("@enclave/db")>(),
  sendDurableTransaction: vi.fn(),
}));

const config = loadConfig({ DATABASE_URL: "postgres://unit.invalid/x402", NODE_ENV: "test", ARC_CHAIN_ID: "5042002", ARC_RPC_URL: "http://unit.invalid/rpc",
  USDC_ADDRESS: "0x0000000000000000000000000000000000000100", USAGE_METER_ADDRESS: "0x0000000000000000000000000000000000000200" });
const payer = privateKeyToAccount(`0x${"31".repeat(32)}`);
const other = "0x0000000000000000000000000000000000000300" as const;
const txHash = `0x${"ab".repeat(32)}` as Hex;
const blockHash = `0x${"cd".repeat(32)}` as Hex;
const wrongHash = `0x${"ee".repeat(32)}` as Hex;
const tokenAbi = parseAbi([
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
  "function cancelAuthorization(address authorizer,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function transfer(address to,uint256 value)",
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
  "event AuthorizationCanceled(address indexed authorizer,bytes32 indexed nonce)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
let auth: TransferAuthorization;

beforeAll(async () => {
  const message = { from: payer.address, to: config.USAGE_METER_ADDRESS as Hex, value: 100_000n, validAfter: 0n, validBefore: 1_800_000_300n, nonce: `0x${"45".repeat(32)}` as Hex };
  const signature = await payer.signTypedData({ domain: { name: "USD Coin", version: "2", chainId: config.ARC_CHAIN_ID, verifyingContract: config.USDC_ADDRESS as Hex },
    types: transferAuthorizationTypes, primaryType: "TransferWithAuthorization", message });
  auth = { ...message, value: message.value.toString(), validAfter: "0", validBefore: message.validBefore.toString(), signature };
});

function data(overrides: Partial<TransferAuthorization> = {}, packed = false): Hex {
  const value = { ...auth, ...overrides };
  const common = [value.from as Hex, value.to as Hex, BigInt(value.value), BigInt(value.validAfter), BigInt(value.validBefore), value.nonce as Hex] as const;
  if (packed) return encodeFunctionData({ abi: tokenAbi, functionName: "transferWithAuthorization", args: [...common, value.signature] });
  const r = value.signature.slice(0, 66) as Hex;
  const s = `0x${value.signature.slice(66, 130)}` as Hex;
  const v = Number.parseInt(value.signature.slice(130), 16);
  return encodeFunctionData({ abi: tokenAbi, functionName: "transferWithAuthorization", args: [...common, v, r, s] });
}

function used(overrides: { authorizer?: Hex; nonce?: Hex; address?: string } = {}) {
  return { address: overrides.address ?? config.USDC_ADDRESS, topics: encodeEventTopics({ abi: tokenAbi, eventName: "AuthorizationUsed",
    args: { authorizer: overrides.authorizer ?? auth.from as Hex, nonce: overrides.nonce ?? auth.nonce as Hex } }), data: "0x" as Hex };
}
function paid(overrides: { from?: Hex; to?: Hex; amount?: bigint; address?: string } = {}) {
  return { address: overrides.address ?? config.USDC_ADDRESS, topics: encodeEventTopics({ abi: tokenAbi, eventName: "Transfer",
    args: { from: overrides.from ?? auth.from as Hex, to: overrides.to ?? auth.to as Hex } }), data: encodeAbiParameters([{ type: "uint256" }], [overrides.amount ?? BigInt(auth.value)]) };
}
function canceled() {
  return { address: config.USDC_ADDRESS, topics: encodeEventTopics({ abi: tokenAbi, eventName: "AuthorizationCanceled", args: { authorizer: auth.from as Hex, nonce: auth.nonce as Hex } }), data: "0x" as Hex };
}
function receipt(changes: Record<string, unknown> = {}) {
  return { transactionHash: txHash, blockHash, blockNumber: 100n, status: "success", logs: [used(), paid()], ...changes };
}
function transaction(changes: Record<string, unknown> = {}) {
  return { hash: txHash, blockHash, blockNumber: 100n, to: config.USDC_ADDRESS, value: 0n, input: data(), ...changes };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.getChainId.mockReset().mockResolvedValue(config.ARC_CHAIN_ID);
  rpc.getTransactionReceipt.mockReset().mockImplementation(async () => receipt());
  rpc.getTransaction.mockReset().mockImplementation(async () => transaction());
  rpc.getBlock.mockReset().mockResolvedValue({ number: 100n, hash: blockHash });
  rpc.getBlockNumber.mockReset().mockResolvedValue(112n);
  rpc.getCode.mockReset().mockResolvedValue(undefined);
  rpc.getLogs.mockReset().mockResolvedValue([]);
  vi.mocked(sendDurableTransaction).mockReset();
});

describe("bounded x402 recovery search", () => {
  it.each([
    { head: 10_000n, admitted: 1n, from: 9_745n },
    { head: 10_000n, admitted: 9_900n, from: 9_901n },
    { head: 100n, admitted: 1n, from: 2n },
  ])("scans only usable funding after admission at $admitted with head $head", async ({ head, admitted, from }) => {
    const failedRelay = new Error("relay unavailable");
    vi.mocked(sendDurableTransaction).mockRejectedValue(failedRelay);
    rpc.getBlock.mockResolvedValue({ number: admitted, hash: blockHash });
    rpc.getBlockNumber.mockResolvedValue(head);
    const db = {} as Database;
    await expect(createX402Facilitator(config, db).settle("bounded-recovery", auth, {
      admission: { blockNumber: admitted.toString(), blockHash },
    })).rejects.toBe(failedRelay);
    expect(sendDurableTransaction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ db }), "x402:bounded-recovery:transfer:0",
      expect.objectContaining({ functionName: "settleTransferAuthorized" }));
    expect(rpc.getLogs).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      address: config.USDC_ADDRESS, args: { authorizer: auth.from, nonce: auth.nonce }, fromBlock: from, toBlock: head,
    }));
    expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe("canonical direct-token x402 funding proof", () => {
  it.each([false, true])("accepts a complete canonical EIP-3009 transfer using packed signature=%s", async (packed) => {
    rpc.getTransaction.mockResolvedValue(transaction({ input: data({}, packed) }));
    expect(await verifyX402FundingProof(config, auth, txHash)).toEqual({ blockNumber: 100n, blockHash });
    expect(rpc.getTransaction).toHaveBeenCalledExactlyOnceWith({ hash: txHash });
    expect(rpc.getTransactionReceipt).toHaveBeenCalledExactlyOnceWith({ hash: txHash });
    expect(rpc.getBlock).toHaveBeenCalledExactlyOnceWith({ blockNumber: 100n });
    expect(createPublicClient).toHaveBeenCalledWith(expect.objectContaining({ chain: expect.objectContaining({ id: config.ARC_CHAIN_ID }), cacheTime: 0 }));
    expect(http).toHaveBeenCalledWith(config.ARC_RPC_URL, { timeout: 15_000, retryCount: 1 });
  });

  it("rejects an RPC serving a different chain before inspecting funding", async () => {
    rpc.getChainId.mockResolvedValue(1);
    await expect(verifyX402FundingProof(config, auth, txHash)).rejects.toThrow("chain mismatch");
    expect(rpc.getTransaction).not.toHaveBeenCalled();
    expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it.each([{ transactionHash: wrongHash }, { status: "reverted" }, { blockHash: wrongHash }, { blockHash: null }])("rejects mismatched, reverted or orphaned receipts %#", async (change) => {
    rpc.getTransactionReceipt.mockResolvedValue(receipt(change));
    await expect(verifyX402FundingProof(config, auth, txHash)).rejects.toThrow("canonical direct token transfer");
  });

  it.each([{ hash: wrongHash }, { blockHash: wrongHash }, { blockHash: null }, { to: other }, { to: config.USAGE_METER_ADDRESS }, { to: null }, { value: 1n }])("rejects mismatched transaction or non-direct funding %#", async (change) => {
    rpc.getTransaction.mockResolvedValue(transaction(change));
    await expect(verifyX402FundingProof(config, auth, txHash)).rejects.toThrow("canonical direct token transfer");
  });

  it("rejects a reorg even when transaction and receipt agree on the old block", async () => {
    rpc.getBlock.mockResolvedValue({ number: 100n, hash: wrongHash });
    await expect(verifyX402FundingProof(config, auth, txHash)).rejects.toThrow("canonical direct token transfer");
  });

  it("waits for external confirmation depth and refuses a chain head behind the receipt", async () => {
    rpc.getBlockNumber.mockResolvedValue(111n);
    await expect(verifyX402FundingProof(config, auth, txHash)).rejects.toThrow("canonical direct token transfer");
    rpc.getBlockNumber.mockResolvedValue(112n);
    await verifyX402FundingProof(config, auth, txHash);
    rpc.getBlockNumber.mockResolvedValue(99n);
    await expect(verifyX402FundingProof({ ...config, CHAIN_CONFIRMATIONS: 0 }, auth, txHash)).rejects.toThrow("canonical direct token transfer");
  });

  it.each([31337, 1337])("uses zero default confirmations only on local chain %s", async (chainId) => {
    rpc.getChainId.mockResolvedValue(chainId);
    rpc.getBlockNumber.mockResolvedValue(100n);
    await verifyX402FundingProof({ ...config, ARC_CHAIN_ID: chainId }, auth, txHash);
  });

  it("honors explicitly configured confirmation depth", async () => {
    rpc.getBlockNumber.mockResolvedValue(102n);
    await verifyX402FundingProof({ ...config, CHAIN_CONFIRMATIONS: 2 }, auth, txHash);
    await expect(verifyX402FundingProof({ ...config, CHAIN_CONFIRMATIONS: 3 }, auth, txHash)).rejects.toThrow("canonical direct token transfer");
    rpc.getBlockNumber.mockResolvedValue(100n);
    await verifyX402FundingProof({ ...config, CHAIN_CONFIRMATIONS: 0 }, auth, txHash);
  });

  it.each(["from", "to", "value", "validAfter", "validBefore", "nonce"])("requires exact signed calldata %s", async (field) => {
    const changes: Record<string, Partial<TransferAuthorization>> = { from: { from: other }, to: { to: other }, value: { value: "100001" },
      validAfter: { validAfter: "1" }, validBefore: { validBefore: "1800000301" }, nonce: { nonce: wrongHash } };
    rpc.getTransaction.mockResolvedValue(transaction({ input: data(changes[field]) }));
    await expect(verifyX402FundingProof(config, auth, txHash)).rejects.toThrow("authorization mismatch");
  });

  it.each([false, true])("requires identical signature bytes for packed=%s", async (packed) => {
    const changedSignature = `0x${"77".repeat(32)}${auth.signature.slice(66)}` as Hex;
    rpc.getTransaction.mockResolvedValue(transaction({ input: data({ signature: changedSignature }, packed) }));
    await expect(verifyX402FundingProof(config, auth, txHash)).rejects.toThrow("signature mismatch");
  });

  it("requires the intended meter even when authorization and transaction agree on another recipient", async () => {
    const changed = { ...auth, to: other };
    rpc.getTransaction.mockResolvedValue(transaction({ input: data(changed) }));
    rpc.getTransactionReceipt.mockResolvedValue(receipt({ logs: [used(), paid({ to: other })] }));
    await expect(verifyX402FundingProof(config, changed, txHash)).rejects.toThrow("authorization mismatch");
  });

  it("rejects plain transfers and cancellation calldata even if matching events are supplied", async () => {
    const transfer = encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [auth.to as Hex, BigInt(auth.value)] });
    const cancel = encodeFunctionData({ abi: tokenAbi, functionName: "cancelAuthorization", args: [auth.from as Hex, auth.nonce as Hex, 27, wrongHash, wrongHash] });
    for (const input of [transfer, cancel, "0x" as Hex]) {
      rpc.getTransaction.mockResolvedValueOnce(transaction({ input }));
      await expect(verifyX402FundingProof(config, auth, txHash)).rejects.toThrow();
    }
  });

  it("never treats a cancelled nonce or unrelated meter balance as proof of funding", async () => {
    rpc.getTransactionReceipt.mockResolvedValue(receipt({ logs: [canceled(), paid({ from: other })] }));
    await expect(verifyX402FundingProof(config, auth, txHash)).rejects.toThrow("both authorization and transfer events");
  });

  it.each(["none", "used-only", "transfer-only", "cancel-and-transfer"])("requires both funding events: %s", async (mode) => {
    const logs = mode === "none" ? [] : mode === "used-only" ? [used()] : mode === "transfer-only" ? [paid()] : [canceled(), paid()];
    rpc.getTransactionReceipt.mockResolvedValue(receipt({ logs }));
    await expect(verifyX402FundingProof(config, auth, txHash)).rejects.toThrow("both authorization and transfer events");
  });

  it.each(["authorizer", "nonce", "used-address", "transfer-from", "transfer-to", "transfer-amount", "transfer-address"])("rejects unrelated event %s", async (kind) => {
    const authorizationEvent = used(kind === "authorizer" ? { authorizer: other } : kind === "nonce" ? { nonce: wrongHash } : kind === "used-address" ? { address: other } : {});
    const transferEvent = paid(kind === "transfer-from" ? { from: other } : kind === "transfer-to" ? { to: other } : kind === "transfer-amount" ? { amount: 99_999n } : kind === "transfer-address" ? { address: other } : {});
    rpc.getTransactionReceipt.mockResolvedValue(receipt({ logs: [authorizationEvent, transferEvent] }));
    await expect(verifyX402FundingProof(config, auth, txHash)).rejects.toThrow("both authorization and transfer events");
  });

  it("ignores unrelated logs but rejects malformed substitutes for required events", async () => {
    rpc.getTransactionReceipt.mockResolvedValueOnce(receipt({ logs: [paid({ from: other }), used({ nonce: wrongHash }), { ...paid(), data: "0x" }, used(), paid()] }));
    await verifyX402FundingProof(config, auth, txHash);
    for (const logs of [[{ ...used(), topics: [] }, paid()], [used(), { ...paid(), data: "0x" }]]) {
      rpc.getTransactionReceipt.mockResolvedValueOnce(receipt({ logs }));
      await expect(verifyX402FundingProof(config, auth, txHash)).rejects.toThrow("both authorization and transfer events");
    }
  });

  it("does not interpret RPC outages as funded authorization", async () => {
    for (const method of [rpc.getChainId, rpc.getTransaction, rpc.getTransactionReceipt, rpc.getBlock, rpc.getBlockNumber]) {
      method.mockRejectedValueOnce(new Error("RPC unavailable"));
      await expect(verifyX402FundingProof(config, auth, txHash)).rejects.toThrow("RPC unavailable");
    }
  });
});
