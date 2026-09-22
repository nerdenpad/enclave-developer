import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, encodeAbiParameters, encodeEventTopics, http, keccak256, parseAbi, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ConflictError } from "@enclave/core";
import { loadConfig } from "./config.js";
import { settlementScope, verifySettlementProof } from "./settlement-proof.js";

const rpc = vi.hoisted(() => ({
  getChainId: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn(), getTransactionReceipt: vi.fn(),
}));
vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createPublicClient: vi.fn(() => rpc),
  http: vi.fn(() => ({ name: "mock-transport" })),
}));

const config = loadConfig({
  DATABASE_URL: "postgres://unit.invalid/enclave", NODE_ENV: "test", ARC_CHAIN_ID: "5042002",
  ARC_RPC_URL: "http://unit.invalid/rpc", USDC_ADDRESS: "0x0000000000000000000000000000000000000100",
  USAGE_METER_ADDRESS: "0x0000000000000000000000000000000000000200",
});
const payer = privateKeyToAccount(config.DEPLOYER_PRIVATE_KEY).address;
const otherPayer = privateKeyToAccount(`0x${"12".repeat(32)}`).address;
const transactionHash = `0x${"ab".repeat(32)}` as Hex;
const blockHash = `0x${"cd".repeat(32)}` as Hex;
const genesisHash = `0x${"ef".repeat(32)}` as Hex;
const paymentId = "10000000-0000-4000-8000-000000000001";
const amount = 123_456n;
const abi = parseAbi(["event Settled(address indexed payer, uint256 amount, bytes32 indexed receiptHash, bool confidentialPath)"]);
const input = { paymentId, txHash: transactionHash, amount, confidential: false };

function event(overrides: { payer?: Hex; amount?: bigint; receiptHash?: Hex; confidential?: boolean; address?: string } = {}) {
  return {
    address: overrides.address ?? config.USAGE_METER_ADDRESS,
    topics: encodeEventTopics({ abi, eventName: "Settled", args: { payer: overrides.payer ?? payer, receiptHash: overrides.receiptHash ?? keccak256(stringToHex(paymentId)) } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [overrides.amount ?? amount, overrides.confidential ?? false]),
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return { transactionHash, blockHash, blockNumber: 100n, status: "success", logs: [event()], ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.getChainId.mockReset().mockResolvedValue(config.ARC_CHAIN_ID);
  rpc.getBlock.mockReset().mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: blockNumber === 0n ? genesisHash : blockHash }));
  rpc.getBlockNumber.mockReset().mockResolvedValue(112n);
  rpc.getTransactionReceipt.mockReset().mockResolvedValue(receipt());
});

describe("settlement chain scope", () => {
  it("binds chain identity, token, meter, and payer to the RPC genesis", async () => {
    await expect(settlementScope(config)).resolves.toBe([config.ARC_CHAIN_ID, genesisHash, config.USDC_ADDRESS, config.USAGE_METER_ADDRESS, payer.toLowerCase()].join(":"));
    expect(rpc.getBlock).toHaveBeenCalledExactlyOnceWith({ blockNumber: 0n });
    expect(createPublicClient).toHaveBeenCalledWith(expect.objectContaining({ chain: expect.objectContaining({ id: config.ARC_CHAIN_ID }) }));
    expect(http).toHaveBeenCalledWith(config.ARC_RPC_URL, { timeout: 15_000, retryCount: 1 });
  });

  it("rejects an RPC serving another chain before retrieving genesis", async () => {
    rpc.getChainId.mockResolvedValueOnce(1);
    await expect(settlementScope(config)).rejects.toThrow("Settlement RPC chain mismatch");
    expect(rpc.getBlock).not.toHaveBeenCalled();
  });

  it.each([
    { USDC_ADDRESS: "0x0000000000000000000000000000000000000300" },
    { USAGE_METER_ADDRESS: "0x0000000000000000000000000000000000000400" },
    { DEPLOYER_PRIVATE_KEY: `0x${"12".repeat(32)}` as Hex },
  ])("changes when an economically relevant contract or payer changes %#", async (override) => {
    expect(await settlementScope({ ...config, ...override })).not.toBe(await settlementScope(config));
  });

  it("changes on a chain reset and remains stable across RPC providers", async () => {
    const original = await settlementScope(config);
    await expect(settlementScope({ ...config, ARC_RPC_URL: "http://other.invalid/rpc" })).resolves.toBe(original);
    rpc.getBlock.mockResolvedValueOnce({ hash: `0x${"01".repeat(32)}` });
    expect(await settlementScope(config)).not.toBe(original);
  });

  it("normalizes contract address case", async () => {
    const lower = "0x000000000000000000000000000000000000abcd";
    await expect(settlementScope({ ...config, USDC_ADDRESS: lower.toUpperCase().replace("0X", "0x") })).resolves.toBe(await settlementScope({ ...config, USDC_ADDRESS: lower }));
  });
});

describe("canonical settlement proof", () => {
  it("accepts the exact payment event at the confirmation boundary", async () => {
    await expect(verifySettlementProof(config, input)).resolves.toBeUndefined();
    expect(rpc.getTransactionReceipt).toHaveBeenCalledExactlyOnceWith({ hash: transactionHash });
    expect(rpc.getBlock).toHaveBeenCalledExactlyOnceWith({ blockNumber: 100n });
    expect(rpc.getBlockNumber).toHaveBeenCalledExactlyOnceWith({ cacheTime: 0 });
  });

  it.each(["", "0x", "0x1234", `0x${"xz".repeat(32)}`, `0x${"ab".repeat(33)}`])("rejects malformed transaction hashes before RPC access %#", async (txHash) => {
    await expect(verifySettlementProof(config, { ...input, txHash })).rejects.toThrow("Payment transaction hash missing");
    expect(createPublicClient).not.toHaveBeenCalled();
  });

  it.each([
    { transactionHash: `0x${"01".repeat(32)}` },
    { status: "reverted" },
    { blockHash: `0x${"02".repeat(32)}` },
  ])("rejects a wrong transaction, reverted receipt, or orphaned block %#", async (override) => {
    rpc.getTransactionReceipt.mockResolvedValueOnce(receipt(override));
    await expect(verifySettlementProof(config, input)).rejects.toThrow("Payment is not confirmed on the canonical chain");
  });

  it("accepts case-insensitive transaction hashes", async () => {
    await expect(verifySettlementProof(config, { ...input, txHash: `0x${"AB".repeat(32)}` })).resolves.toBeUndefined();
  });

  it("waits for all twelve default external-chain confirmations", async () => {
    rpc.getBlockNumber.mockResolvedValueOnce(111n);
    await expect(verifySettlementProof(config, input)).rejects.toBeInstanceOf(ConflictError);
  });

  it.each([31337, 1337])("accepts freshly mined receipts on local chain %i", async (chainId) => {
    rpc.getBlockNumber.mockResolvedValueOnce(100n);
    await expect(verifySettlementProof({ ...config, ARC_CHAIN_ID: chainId }, input)).resolves.toBeUndefined();
  });

  it("uses configured confirmation depth, including zero on an external chain", async () => {
    rpc.getBlockNumber.mockResolvedValue(102n);
    await expect(verifySettlementProof({ ...config, CHAIN_CONFIRMATIONS: 2 }, input)).resolves.toBeUndefined();
    await expect(verifySettlementProof({ ...config, CHAIN_CONFIRMATIONS: 3 }, input)).rejects.toBeInstanceOf(ConflictError);
    rpc.getBlockNumber.mockResolvedValue(100n);
    await expect(verifySettlementProof({ ...config, CHAIN_CONFIRMATIONS: 0 }, input)).resolves.toBeUndefined();
    rpc.getBlockNumber.mockResolvedValue(99n);
    await expect(verifySettlementProof({ ...config, CHAIN_CONFIRMATIONS: 0 }, input)).rejects.toBeInstanceOf(ConflictError);
  });

  it.each([
    { address: config.USDC_ADDRESS }, { payer: otherPayer }, { amount: amount + 1n },
    { receiptHash: keccak256(stringToHex("another-payment")) }, { confidential: true },
  ])("rejects a settlement for another contract, payer, amount, payment, or path %#", async (override) => {
    rpc.getTransactionReceipt.mockResolvedValueOnce(receipt({ logs: [event(override)] }));
    await expect(verifySettlementProof(config, input)).rejects.toThrow("Transaction does not prove the requested payment");
  });

  it("uses the authorized payer instead of the service signer when supplied", async () => {
    rpc.getTransactionReceipt.mockResolvedValue(receipt({ logs: [event({ payer: otherPayer })] }));
    await expect(verifySettlementProof(config, input)).rejects.toBeInstanceOf(ConflictError);
    await expect(verifySettlementProof(config, { ...input, payer: otherPayer })).resolves.toBeUndefined();
  });

  it("requires the confidential event to hide its amount with zero", async () => {
    rpc.getTransactionReceipt.mockResolvedValueOnce(receipt({ logs: [event({ confidential: true, amount: 0n })] }));
    await expect(verifySettlementProof(config, { ...input, confidential: true })).resolves.toBeUndefined();
    rpc.getTransactionReceipt.mockResolvedValueOnce(receipt({ logs: [event({ confidential: true })] }));
    await expect(verifySettlementProof(config, { ...input, confidential: true })).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects absent or malformed event logs", async () => {
    for (const logs of [[], [{ ...event(), topics: [] }], [{ ...event(), data: "0x" }]]) {
      rpc.getTransactionReceipt.mockResolvedValueOnce(receipt({ logs }));
      await expect(verifySettlementProof(config, input)).rejects.toBeInstanceOf(ConflictError);
    }
  });

  it("ignores unrelated or malformed logs when a valid proof is present", async () => {
    rpc.getTransactionReceipt.mockResolvedValueOnce(receipt({ logs: [event({ payer: otherPayer }), { ...event(), data: "0x" }, event()] }));
    await expect(verifySettlementProof(config, input)).resolves.toBeUndefined();
  });

  it("does not interpret RPC failures as a successful payment", async () => {
    for (const method of [rpc.getTransactionReceipt, rpc.getBlock, rpc.getBlockNumber]) {
      method.mockRejectedValueOnce(new Error("RPC unavailable"));
      await expect(verifySettlementProof(config, input)).rejects.toThrow("RPC unavailable");
    }
  });
});
