import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, zeroAddress, zeroHash, type Hex } from "viem";
import type { Database } from "@enclave/db";
import { createEconomicOps, createFacilitator, createRegistryApproval, paymentIdToBytes32, type PaymentAuthorization } from "./chain.js";
import { loadConfig, type Config } from "./config.js";

const rpc = vi.hoisted(() => ({ writeContract: vi.fn(), waitForTransactionReceipt: vi.fn(), readContract: vi.fn() }));
const publicRpc = vi.hoisted(() => ({ readContract: vi.fn(), getBlock: vi.fn() }));
const journal = vi.hoisted(() => ({ send: vi.fn(), confirm: vi.fn() }));
vi.mock("viem", async (original) => ({
  ...await original<typeof import("viem")>(),
  // Each wallet owns its methods: wrapping a durable wallet must not mutate another client.
  createWalletClient: vi.fn(() => ({ extend: () => ({ ...rpc }) })),
  createPublicClient: vi.fn(() => publicRpc),
}));
vi.mock("@enclave/db", async (original) => ({
  ...await original<typeof import("@enclave/db")>(),
  sendDurableTransaction: journal.send,
  confirmDurableTransaction: journal.confirm,
}));

const txHash = `0x${"ab".repeat(32)}` as Hex;
const modelHash = `0x${"11".repeat(32)}` as Hex;
const provider = "0x0000000000000000000000000000000000009000" as Hex;
const paymentId = "80b56ff7-2828-44db-a379-218b24087838";
const agentId = "5107f2e5-f6ce-4278-bae5-8a1c59b93639";
const authorization: PaymentAuthorization = { from: provider, validAfter: "123", validBefore: "456", signature: `0x${"22".repeat(64)}1b` };
function config(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://unit.invalid/test" }),
    ARC_RPC_URL: "http://unit.invalid/chain-boundaries",
    USAGE_METER_ADDRESS: "0x0000000000000000000000000000000000001000",
    FEE_VAULT_ADDRESS: "0x0000000000000000000000000000000000002000",
    MODEL_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000003000",
    USDC_ADDRESS: "0x0000000000000000000000000000000000004000",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.writeContract.mockReset().mockImplementation(async (request) => { encodeFunctionData(request); return txHash; });
  rpc.waitForTransactionReceipt.mockReset().mockResolvedValue({ status: "success", transactionHash: txHash, logs: [] });
  rpc.readContract.mockReset();
  publicRpc.readContract.mockReset();
  publicRpc.getBlock.mockReset().mockResolvedValue({ timestamp: 1000n });
  journal.send.mockReset().mockImplementation(async (_options, _operation, request) => { encodeFunctionData(request); return txHash; });
  journal.confirm.mockReset().mockResolvedValue({ status: "success", transactionHash: txHash, logs: [] });
});

describe("payer authorization adapter boundaries", () => {
  it("refuses confidential authorization before sending any token transaction", async () => {
    await expect(createFacilitator(config()).settle(paymentId, 500n, true, { mode: "authorized", authorization }))
      .rejects.toThrow("Confidential authorization adapter is not configured");
    expect(rpc.writeContract).not.toHaveBeenCalled();
  });

  it("refuses missing authorization instead of falling back to operator-funded minting", async () => {
    await expect(createFacilitator(config()).settle(paymentId, 500n, false, { mode: "authorized" }))
      .rejects.toThrow("A signed USDC receive authorization is required");
    expect(rpc.writeContract).not.toHaveBeenCalled();
  });

  it("preserves the external payer and agent binding without a model listing", async () => {
    const cfg = config();
    expect(await createFacilitator(cfg).settle(paymentId, 500n, false, { mode: "authorized", authorization, agentId })).toBe(txHash);
    expect(rpc.writeContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      address: cfg.USAGE_METER_ADDRESS, functionName: "settleAuthorized",
      args: [provider, 500n, paymentIdToBytes32(paymentId), 0n, paymentIdToBytes32(agentId), 123n, 456n, authorization.signature],
    }));
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledExactlyOnceWith({ hash: txHash });
  });

  it("keeps an ordinary authorized payment's absent agent separate from its listing", async () => {
    await createFacilitator(config()).settle(paymentId, 500n, false, { mode: "authorized", authorization, listingId: 42, agentId: null });
    expect(rpc.writeContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      functionName: "settleAuthorized", args: [provider, 500n, paymentIdToBytes32(paymentId), 42n, zeroHash, 123n, 456n, authorization.signature],
    }));
  });

  it("does not report an authorized debit as successful when its transaction reverts", async () => {
    rpc.waitForTransactionReceipt.mockResolvedValue({ status: "reverted", transactionHash: txHash });
    await expect(createFacilitator(config()).settle(paymentId, 500n, false, { mode: "authorized", authorization, listingId: null }))
      .rejects.toThrow(`Transaction reverted: ${txHash}`);
    expect(rpc.writeContract).toHaveBeenCalledTimes(1);
  });
});

describe("atomic mandate routing", () => {
  it("uses settleAgent for an agent payment without a marketplace listing", async () => {
    const facilitator = createFacilitator(config());
    await facilitator.settle(paymentId, 600n, false, { agentId });
    expect(rpc.writeContract.mock.calls.map(([request]) => request.functionName)).toEqual(["mint", "approve", "settleAgent"]);
    expect(rpc.writeContract).toHaveBeenLastCalledWith(expect.objectContaining({
      args: [facilitator.payer, paymentIdToBytes32(agentId), 600n, paymentIdToBytes32(paymentId)],
    }));
  });

  it("retains the mandate when provider routing selects settleModel", async () => {
    const facilitator = createFacilitator(config());
    await facilitator.settle(paymentId, 600n, false, { agentId, listingId: 42 });
    expect(rpc.writeContract.mock.calls.map(([request]) => request.functionName)).toEqual(["mint", "approve", "settleModel"]);
    expect(rpc.writeContract).toHaveBeenLastCalledWith(expect.objectContaining({
      args: [facilitator.payer, 600n, paymentIdToBytes32(paymentId), 42n, paymentIdToBytes32(agentId)],
    }));
  });
});

describe("durable signer adapter policy", () => {
  it.each([undefined, 0, 5])("forwards configured confirmation depth %s without off-by-one changes", async (depth) => {
    const db = {} as Database;
    const cfg = config(depth === undefined ? {} : { CHAIN_CONFIRMATIONS: depth });
    await createFacilitator(cfg, db).settle(paymentId, 500n, false, { mode: "authorized", authorization });
    const options = { db, rpcUrl: cfg.ARC_RPC_URL, chainId: cfg.ARC_CHAIN_ID, privateKey: cfg.DEPLOYER_PRIVATE_KEY,
      ...(depth === undefined ? {} : { confirmations: depth }) };
    expect(journal.send).toHaveBeenCalledExactlyOnceWith(options, `payment:${paymentId}:0`, expect.objectContaining({ functionName: "settleAuthorized" }));
    expect(journal.confirm).toHaveBeenCalledExactlyOnceWith(options, txHash);
    expect(rpc.writeContract).not.toHaveBeenCalled();
    expect(rpc.waitForTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe("economic state interpretation", () => {
  it.each([
    [zeroAddress, false, false, "missing"],
    [provider, true, true, "revoked"],
    [provider, true, false, "approved"],
  ] as const)("classifies registry entry %s/%s/%s as %s before its old deadline", async (who, approved, revoked, state) => {
    publicRpc.readContract.mockImplementation(async ({ functionName }) => functionName === "TIMELOCK" ? 3600n : [modelHash, modelHash, who, 1000n, 250, 1n, approved, revoked]);
    expect(await createRegistryApproval(config()).status(42n)).toMatchObject({ state, availableAt: "4600", provider: who, listingBps: 250 });
  });

  it("reports zero new buyback reserve when distribution emits only its base split", async () => {
    const event = { type: "event", name: "Distributed", inputs: ["treasuryAmt", "stakersAmt", "providersAmt", "ecosystemAmt"].map((name) => ({ type: "uint256", name, indexed: false })) } as const;
    rpc.waitForTransactionReceipt.mockResolvedValue({ status: "success", logs: [{ address: config().FEE_VAULT_ADDRESS,
      topics: encodeEventTopics({ abi: [event], eventName: "Distributed" }), data: encodeAbiParameters(Array(4).fill({ type: "uint256" }), [800n, 100n, 50n, 50n]),
    }] });
    expect(await createEconomicOps(config()).distributeWithAccounting()).toEqual({ tx: txHash, treasury: 800n, stakers: 100n, providers: 50n, ecosystem: 50n, reserved: 0n });
  });
});
