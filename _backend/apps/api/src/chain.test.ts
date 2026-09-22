import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, maxUint256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  addressConfigured,
  createFacilitator,
  createFeeOps,
  createMandator,
  createMarketplace,
  createStaking,
  mandateConfigured,
  marketplaceConfigured,
  meterConfigured,
  paymentIdToBytes32,
  stakingConfigured,
} from "./chain.js";
import { loadConfig, type Config } from "./config.js";

const rpc = vi.hoisted(() => ({
  writeContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  readContract: vi.fn(),
}));
const publicRpc = vi.hoisted(() => ({ readContract: vi.fn() }));

vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createWalletClient: vi.fn(() => ({ extend: () => rpc })),
  createPublicClient: vi.fn(() => publicRpc),
  http: vi.fn(() => ({ name: "mock-transport" })),
}));

const tx = `0x${"ab".repeat(32)}` as Hex;
const mintTx = `0x${"01".repeat(32)}` as Hex;
const approveTx = `0x${"02".repeat(32)}` as Hex;
const modelHash = `0x${"11".repeat(32)}` as Hex;
const codeHash = `0x${"22".repeat(32)}` as Hex;
const anotherAccount = "0x0000000000000000000000000000000000000900" as Hex;
const placeholder = "0x0000000000000000000000000000000000000001";

function config(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://unit.invalid/enclave" }),
    ARC_CHAIN_ID: 5042002,
    ARC_RPC_URL: "http://unit.invalid/rpc",
    DEPLOYER_PRIVATE_KEY: `0x${"12".repeat(32)}`,
    USAGE_METER_ADDRESS: "0x0000000000000000000000000000000000000100",
    USDC_ADDRESS: "0x0000000000000000000000000000000000000200",
    ENCL_TOKEN_ADDRESS: "0x0000000000000000000000000000000000000300",
    INSURANCE_STAKING_ADDRESS: "0x0000000000000000000000000000000000000400",
    MODEL_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000500",
    AGENT_MANDATE_ADDRESS: "0x0000000000000000000000000000000000000600",
    FEE_VAULT_ADDRESS: "0x0000000000000000000000000000000000000700",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.writeContract.mockReset().mockImplementation(async (request) => {
    // Encode against the real compiled artifact ABI: a wrong method or argument is a test failure.
    encodeFunctionData(request);
    return tx;
  });
  rpc.waitForTransactionReceipt.mockReset().mockResolvedValue({ status: "success", transactionHash: tx });
  rpc.readContract.mockReset().mockImplementation(async (request) => {
    encodeFunctionData(request);
    return 0n;
  });
  publicRpc.readContract.mockReset().mockImplementation(async (request) => {
    encodeFunctionData(request);
    return 0n;
  });
});

describe("chain configuration", () => {
  it.each([["test", 25], ["development", 4_000]] as const)("uses an appropriate polling interval in %s", (environment, pollingInterval) => {
    createFacilitator(config({ NODE_ENV: environment }));
    expect(createWalletClient).toHaveBeenCalledWith(expect.objectContaining({ pollingInterval }));
  });

  it.each([
    ["facilitator", createFacilitator],
    ["staking", createStaking],
    ["marketplace", createMarketplace],
    ["mandator", createMandator],
    ["fee operations", createFeeOps],
  ] as const)("uses the configured chain and RPC for %s", (_name, createAdapter) => {
    const settings = config();
    createAdapter(settings);
    expect(createWalletClient).toHaveBeenCalledWith(expect.objectContaining({
      account: expect.objectContaining({ address: privateKeyToAccount(settings.DEPLOYER_PRIVATE_KEY).address }),
      chain: expect.objectContaining({ id: settings.ARC_CHAIN_ID }),
    }));
    expect(http).toHaveBeenCalledWith(settings.ARC_RPC_URL);
    for (const [options] of vi.mocked(createPublicClient).mock.calls) {
      expect(options).toEqual(expect.objectContaining({ chain: expect.objectContaining({ id: settings.ARC_CHAIN_ID }) }));
    }
    expect(rpc.writeContract).not.toHaveBeenCalled();
  });

  it("hashes payment identifiers as UTF-8 keccak256 with full bytes32 output", () => {
    expect(paymentIdToBytes32("payment-1")).toBe(keccak256(stringToHex("payment-1")));
    expect(paymentIdToBytes32("payment-1")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(paymentIdToBytes32("payment-1")).not.toBe(paymentIdToBytes32("payment-2"));
    expect(paymentIdToBytes32("платёж")).toBe(keccak256(stringToHex("платёж")));
  });

  it("rejects placeholder addresses and requires both staking contracts", () => {
    const settings = config();
    expect(addressConfigured(placeholder)).toBe(false);
    expect(addressConfigured("0x0000000000000000000000000000000000000000")).toBe(false);
    expect(addressConfigured("malformed")).toBe(false);
    expect(meterConfigured(settings)).toBe(true);
    expect(meterConfigured(config({ USAGE_METER_ADDRESS: placeholder }))).toBe(false);
    expect(stakingConfigured(settings)).toBe(true);
    expect(stakingConfigured(config({ ENCL_TOKEN_ADDRESS: placeholder }))).toBe(false);
    expect(stakingConfigured(config({ INSURANCE_STAKING_ADDRESS: placeholder }))).toBe(false);
    expect(marketplaceConfigured(settings)).toBe(true);
    expect(marketplaceConfigured(config({ MODEL_REGISTRY_ADDRESS: placeholder }))).toBe(false);
    expect(mandateConfigured(settings)).toBe(true);
    expect(mandateConfigured(config({ AGENT_MANDATE_ADDRESS: placeholder }))).toBe(false);
  });
});

describe("shared signer transaction serialization", () => {
  it("keeps concurrent settlement mint/approve/settle actions together across adapter instances", async () => {
    const settings = config();
    const first = createFacilitator(settings);
    const second = createFacilitator(settings);
    await Promise.all([first.settle("first-payment", 11n), second.settle("second-payment", 22n)]);
    expect(rpc.writeContract.mock.calls.map(([request]) => request.functionName))
      .toEqual(["mint", "approve", "settle", "mint", "approve", "settle"]);
    expect(rpc.writeContract).toHaveBeenNthCalledWith(3, expect.objectContaining({
      functionName: "settle", args: [first.payer, 11n, paymentIdToBytes32("first-payment")],
    }));
    expect(rpc.writeContract).toHaveBeenNthCalledWith(6, expect.objectContaining({
      functionName: "settle", args: [second.payer, 22n, paymentIdToBytes32("second-payment")],
    }));
  });

  it("coordinates different adapters using the same funded signer", async () => {
    const settings = config();
    await Promise.all([
      createFacilitator(settings).settle("payment", 10n),
      createStaking(settings).stake(20n),
      createMandator(settings).open("agent", 30n),
    ]);
    expect(rpc.writeContract.mock.calls.map(([request]) => request.functionName))
      .toEqual(["mint", "approve", "settle", "approve", "stake", "open"]);
  });

  it("continues queued actions after a previous transaction reverts", async () => {
    rpc.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });
    const settings = config();
    const results = await Promise.allSettled([
      createFacilitator(settings).settle("failed-payment", 10n),
      createMandator(settings).open("next-agent", 30n),
    ]);
    expect(results[0]).toEqual({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("reverted") }) });
    expect(results[1]).toEqual({ status: "fulfilled", value: tx });
    expect(rpc.writeContract.mock.calls.map(([request]) => request.functionName)).toEqual(["mint", "open"]);
  });

  it("does not block an independent signer while another waits for confirmation", async () => {
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    const firstConfirmation = new Promise<void>((resolve) => { releaseFirst = resolve; });
    rpc.waitForTransactionReceipt.mockImplementationOnce(async () => {
      signalFirstStarted();
      await firstConfirmation;
      return { status: "success", transactionHash: tx };
    });
    const first = createFeeOps(config()).distribute();
    await firstStarted;
    const independent = config({ DEPLOYER_PRIVATE_KEY: `0x${"13".repeat(32)}` });
    const second = createMandator(independent).open("independent-agent", 10n);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Independent signer was blocked")), 1_000);
      });
      expect(await Promise.race([second, timedOut])).toBe(tx);
      expect(rpc.writeContract.mock.calls.map(([request]) => request.functionName)).toEqual(["distribute", "open"]);
    } finally {
      clearTimeout(timeout);
      releaseFirst();
      await Promise.allSettled([first, second]);
    }
  }, 5_000);
});

describe("USDC facilitator", () => {
  it("confirms mint and approval before submitting clear settlement", async () => {
    const settings = config();
    const facilitator = createFacilitator(settings);
    const amount = 123_456n;
    const order: string[] = [];
    const hashes = [mintTx, approveTx, tx];
    rpc.writeContract.mockImplementation(async (request) => {
      encodeFunctionData(request);
      order.push(request.functionName);
      return hashes.shift();
    });
    rpc.waitForTransactionReceipt.mockImplementation(async ({ hash }) => {
      order.push(`confirmed:${hash}`);
      return { status: "success", transactionHash: hash };
    });
    expect(await facilitator.settle("payment-1", amount)).toBe(tx);
    expect(facilitator.payer).toBe(privateKeyToAccount(settings.DEPLOYER_PRIVATE_KEY).address);
    expect(rpc.writeContract).toHaveBeenNthCalledWith(1, expect.objectContaining({
      address: settings.USDC_ADDRESS, functionName: "mint", args: [facilitator.payer, amount],
    }));
    expect(rpc.writeContract).toHaveBeenNthCalledWith(2, expect.objectContaining({
      address: settings.USDC_ADDRESS, functionName: "approve", args: [settings.USAGE_METER_ADDRESS, maxUint256],
    }));
    expect(rpc.writeContract).toHaveBeenNthCalledWith(3, expect.objectContaining({
      address: settings.USAGE_METER_ADDRESS, functionName: "settle", args: [facilitator.payer, amount, paymentIdToBytes32("payment-1")],
    }));
    expect(order).toEqual(["mint", `confirmed:${mintTx}`, "approve", `confirmed:${approveTx}`, "settle", `confirmed:${tx}`]);
  });

  it("uses the confidential stub method without clear mint, approval or amount calldata", async () => {
    const settings = config();
    const facilitator = createFacilitator(settings);
    expect(await facilitator.settle("private-payment", 777n, true)).toBe(tx);
    expect(rpc.writeContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      address: settings.USAGE_METER_ADDRESS,
      functionName: "settleConfidential",
      args: [facilitator.payer, stringToHex("shielded"), paymentIdToBytes32("private-payment")],
    }));
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledExactlyOnceWith({ hash: tx });
  });

  it.each([1, 2, 3])("stops settlement after transaction %i reverts", async (failedStage) => {
    for (let stage = 1; stage < failedStage; stage++) {
      rpc.waitForTransactionReceipt.mockResolvedValueOnce({ status: "success", transactionHash: tx });
    }
    rpc.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted", transactionHash: tx });
    await expect(createFacilitator(config()).settle("payment", 1n)).rejects.toThrow("Transaction reverted");
    expect(rpc.writeContract).toHaveBeenCalledTimes(failedStage);
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledTimes(failedStage);
  });

  it("rejects a reverted confidential settlement", async () => {
    rpc.waitForTransactionReceipt.mockResolvedValue({ status: "reverted", transactionHash: tx });
    await expect(createFacilitator(config()).settle("payment", 1n, true)).rejects.toThrow("Transaction reverted");
    expect(rpc.writeContract).toHaveBeenCalledOnce();
  });

  it("propagates confirmation timeouts without issuing the next transfer", async () => {
    rpc.waitForTransactionReceipt.mockRejectedValue(new Error("RPC timeout"));
    await expect(createFacilitator(config()).settle("payment", 1n)).rejects.toThrow("RPC timeout");
    expect(rpc.writeContract).toHaveBeenCalledOnce();
  });
});

describe("staking adapter", () => {
  it("approves the trusted staking contract before staking and confirms both transactions", async () => {
    const settings = config();
    const staking = createStaking(settings);
    expect(staking.address).toBe(privateKeyToAccount(settings.DEPLOYER_PRIVATE_KEY).address);
    expect(await staking.stake(42n)).toBe(tx);
    expect(rpc.writeContract).toHaveBeenNthCalledWith(1, expect.objectContaining({
      address: settings.ENCL_TOKEN_ADDRESS, functionName: "approve", args: [settings.INSURANCE_STAKING_ADDRESS, maxUint256],
    }));
    expect(rpc.writeContract).toHaveBeenNthCalledWith(2, expect.objectContaining({
      address: settings.INSURANCE_STAKING_ADDRESS, functionName: "stake", args: [42n],
    }));
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledTimes(2);
  });

  it("unstakes and reads either the configured wallet's stake or the requested account", async () => {
    const settings = config();
    const staking = createStaking(settings);
    expect(await staking.unstake(9n)).toBe(tx);
    expect(rpc.writeContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      address: settings.INSURANCE_STAKING_ADDRESS, functionName: "unstake", args: [9n],
    }));
    publicRpc.readContract.mockResolvedValueOnce(31n).mockResolvedValueOnce(99n);
    expect(await staking.stakedOf()).toBe(31n);
    expect(await staking.stakedOf(anotherAccount)).toBe(99n);
    expect(publicRpc.readContract).toHaveBeenNthCalledWith(1, expect.objectContaining({
      address: settings.INSURANCE_STAKING_ADDRESS, functionName: "staked", args: [staking.address],
    }));
    expect(publicRpc.readContract).toHaveBeenNthCalledWith(2, expect.objectContaining({ functionName: "staked", args: [anotherAccount] }));
    expect(createPublicClient).toHaveBeenCalledWith(expect.objectContaining({ chain: expect.objectContaining({ id: settings.ARC_CHAIN_ID }) }));
  });

  it.each([1, 2])("rejects stake when transaction %i reverts", async (failedStage) => {
    if (failedStage === 2) rpc.waitForTransactionReceipt.mockResolvedValueOnce({ status: "success" });
    rpc.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });
    await expect(createStaking(config()).stake(42n)).rejects.toThrow("Transaction reverted");
    expect(rpc.writeContract).toHaveBeenCalledTimes(failedStage);
  });

  it("rejects a reverted unstake", async () => {
    rpc.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    await expect(createStaking(config()).unstake(1n)).rejects.toThrow("Transaction reverted");
  });
});

describe("model marketplace adapter", () => {
  it("reads the required stake, approves it and submits the requested model/code tuple", async () => {
    const settings = config();
    rpc.readContract.mockResolvedValueOnce(100n).mockResolvedValueOnce(7n);
    expect(await createMarketplace(settings).list(modelHash, codeHash, 250)).toEqual({ tx, id: 7n });
    expect(rpc.readContract).toHaveBeenNthCalledWith(1, expect.objectContaining({
      address: settings.MODEL_REGISTRY_ADDRESS, functionName: "listingStake",
    }));
    expect(rpc.readContract).toHaveBeenNthCalledWith(2, expect.objectContaining({
      address: settings.MODEL_REGISTRY_ADDRESS, functionName: "idByHashes", args: [modelHash, codeHash],
    }));
    expect(rpc.writeContract).toHaveBeenNthCalledWith(1, expect.objectContaining({
      address: settings.ENCL_TOKEN_ADDRESS, functionName: "approve", args: [settings.MODEL_REGISTRY_ADDRESS, maxUint256],
    }));
    expect(rpc.writeContract).toHaveBeenNthCalledWith(2, expect.objectContaining({
      address: settings.MODEL_REGISTRY_ADDRESS, functionName: "list", args: [modelHash, codeHash, 250],
    }));
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledTimes(2);
  });

  it("returns this tuple's ID when another provider has already increased listingCount", async () => {
    rpc.readContract.mockImplementation(async (request) => {
      encodeFunctionData(request);
      if (request.functionName === "listingStake") return 0n;
      if (request.functionName === "idByHashes") return 7n;
      if (request.functionName === "listingCount") return 99n;
      throw new Error(`Unexpected registry read: ${request.functionName}`);
    });
    expect(await createMarketplace(config()).list(modelHash, codeHash, 0)).toEqual({ tx, id: 7n });
    expect(rpc.readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: "listingCount" }));
    expect(rpc.readContract).toHaveBeenLastCalledWith(expect.objectContaining({
      functionName: "idByHashes", args: [modelHash, codeHash],
    }));
  });

  it.each([
    { stake: 0n, token: config().ENCL_TOKEN_ADDRESS },
    { stake: 100n, token: placeholder },
  ])("skips token approval when no stake or configured token is available %#", async ({ stake, token }) => {
    rpc.readContract.mockResolvedValueOnce(stake).mockResolvedValueOnce(9n);
    expect(await createMarketplace(config({ ENCL_TOKEN_ADDRESS: token })).list(modelHash, codeHash, 0)).toEqual({ tx, id: 9n });
    expect(rpc.writeContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ functionName: "list" }));
  });

  it.each(["bootstrapApprove", "bootstrapRestore", "revoke"] as const)("submits and confirms %s for the exact listing", async (operation) => {
    const settings = config();
    expect(await createMarketplace(settings)[operation](12n)).toBe(tx);
    expect(rpc.writeContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      address: settings.MODEL_REGISTRY_ADDRESS, functionName: operation, args: [12n],
    }));
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledExactlyOnceWith({ hash: tx });
  });

  it.each(["bootstrapApprove", "bootstrapRestore", "revoke"] as const)("rejects a reverted %s", async (operation) => {
    rpc.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    await expect(createMarketplace(config())[operation](12n)).rejects.toThrow("Transaction reverted");
  });

  it.each([1, 2])("stops listing when transaction %i reverts", async (failedStage) => {
    rpc.readContract.mockResolvedValueOnce(100n);
    if (failedStage === 2) rpc.waitForTransactionReceipt.mockResolvedValueOnce({ status: "success" });
    rpc.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });
    await expect(createMarketplace(config()).list(modelHash, codeHash, 250)).rejects.toThrow("Transaction reverted");
    expect(rpc.writeContract).toHaveBeenCalledTimes(failedStage);
    expect(rpc.readContract).toHaveBeenCalledOnce();
  });

  it.each([true, false])("returns live registry approval %s for both model and code hashes", async (approved) => {
    publicRpc.readContract.mockResolvedValue(approved);
    const settings = config();
    expect(await createMarketplace(settings).isApproved(modelHash, codeHash)).toBe(approved);
    expect(publicRpc.readContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      address: settings.MODEL_REGISTRY_ADDRESS, functionName: "isApproved", args: [modelHash, codeHash],
    }));
    expect(rpc.writeContract).not.toHaveBeenCalled();
  });
});

describe("agent mandate adapter", () => {
  it.each(["open", "spend"] as const)("hashes the agent identifier and confirms %s", async (operation) => {
    const settings = config();
    expect(await createMandator(settings)[operation]("agent-1", 123n)).toBe(tx);
    expect(rpc.writeContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      address: settings.AGENT_MANDATE_ADDRESS,
      functionName: operation,
      args: [paymentIdToBytes32("agent-1"), 123n],
    }));
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledExactlyOnceWith({ hash: tx });
  });

  it.each(["open", "spend"] as const)("rejects a reverted mandate %s", async (operation) => {
    rpc.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    await expect(createMandator(config())[operation]("agent-1", 123n)).rejects.toThrow("Transaction reverted");
  });
});

describe("fee-vault adapter", () => {
  it("submits and confirms distribution", async () => {
    const settings = config();
    expect(await createFeeOps(settings).distribute()).toBe(tx);
    expect(rpc.writeContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      address: settings.FEE_VAULT_ADDRESS, functionName: "distribute",
    }));
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledExactlyOnceWith({ hash: tx });
  });

  it("queues the exact buyback bigint amount", async () => {
    const settings = config();
    const amount = 10n ** 25n + 1n;
    expect(await createFeeOps(settings).queueBuyback(amount)).toBe(tx);
    expect(rpc.writeContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      address: settings.FEE_VAULT_ADDRESS, functionName: "queueBuyback", args: [amount],
    }));
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledExactlyOnceWith({ hash: tx });
  });

  it.each(["distribute", "queueBuyback"] as const)("rejects a reverted %s", async (operation) => {
    rpc.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    const fees = createFeeOps(config());
    await expect(operation === "distribute" ? fees.distribute() : fees.queueBuyback(1n)).rejects.toThrow("Transaction reverted");
  });

  it("reads the vault USDC balance and all configured recipient addresses", async () => {
    const settings = config();
    const recipients = {
      treasury: "0x0000000000000000000000000000000000001001",
      stakers: "0x0000000000000000000000000000000000001002",
      providers: "0x0000000000000000000000000000000000001003",
      ecosystem: "0x0000000000000000000000000000000000001004",
    };
    publicRpc.readContract.mockImplementation(async (request) => {
      encodeFunctionData(request);
      if (request.functionName === "balanceOf") return 123_000_000n;
      return recipients[request.functionName as keyof typeof recipients];
    });
    expect(await createFeeOps(settings).balances()).toEqual({ vaultBal: 123_000_000n, ...recipients });
    expect(publicRpc.readContract).toHaveBeenCalledTimes(5);
    expect(publicRpc.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: settings.USDC_ADDRESS, functionName: "balanceOf", args: [settings.FEE_VAULT_ADDRESS],
    }));
    for (const recipient of Object.keys(recipients)) {
      expect(publicRpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: settings.FEE_VAULT_ADDRESS, functionName: recipient }));
    }
    expect(rpc.writeContract).not.toHaveBeenCalled();
  });

  it("propagates contract submission failures without waiting for a transaction", async () => {
    rpc.writeContract.mockRejectedValue(new Error("insufficient funds"));
    await expect(createFeeOps(config()).distribute()).rejects.toThrow("insufficient funds");
    expect(rpc.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("propagates failed balance reads instead of returning incomplete accounting", async () => {
    publicRpc.readContract.mockRejectedValue(new Error("RPC unavailable"));
    await expect(createFeeOps(config()).balances()).rejects.toThrow("RPC unavailable");
  });
});
