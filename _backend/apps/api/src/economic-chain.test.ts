import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Hex } from "viem";
import { createEconomicOps, createRegistryApproval } from "./chain.js";
import { loadConfig } from "./config.js";
import { BuybackConfigBody, BuybackExecuteBody, BuybackReserveBody } from "./validation.js";

const rpc = vi.hoisted(() => ({ writeContract: vi.fn(), waitForTransactionReceipt: vi.fn(), readContract: vi.fn() }));
const publicRpc = vi.hoisted(() => ({ readContract: vi.fn(), getBlock: vi.fn() }));
vi.mock("viem", async (original) => ({
  ...await original<typeof import("viem")>(),
  createWalletClient: vi.fn(() => ({ extend: () => rpc })),
  createPublicClient: vi.fn(() => publicRpc),
}));

const config = () => ({
  ...loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://unit.invalid/test" }),
  FEE_VAULT_ADDRESS: "0x0000000000000000000000000000000000001000",
  INSURANCE_STAKING_ADDRESS: "0x0000000000000000000000000000000000002000",
  MODEL_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000003000",
  USDC_ADDRESS: "0x0000000000000000000000000000000000004000",
});
const recipient = "0x0000000000000000000000000000000000009000" as Hex;
const tx = `0x${"ab".repeat(32)}` as Hex;
const hash = `0x${"11".repeat(32)}` as Hex;

beforeEach(() => {
  vi.clearAllMocks();
  rpc.writeContract.mockReset().mockImplementation(async (request) => { encodeFunctionData(request); return tx; });
  rpc.waitForTransactionReceipt.mockReset().mockResolvedValue({ status: "success", transactionHash: tx, logs: [] });
  publicRpc.readContract.mockReset().mockResolvedValue(0n);
  publicRpc.getBlock.mockReset().mockResolvedValue({ timestamp: 1000n });
});

describe("economic adapter confirmed accounting", () => {
  it("reads pending rewards for the actual operator", async () => {
    publicRpc.readContract.mockResolvedValue(123n);
    const ops = createEconomicOps(config());
    expect(await ops.pendingRewards()).toBe(123n);
    expect(publicRpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "pendingRewards", args: [ops.address] }));
  });

  it("uses transaction events for the net split and reserve, even if balances changed before mining", async () => {
    const distributed = { type: "event", name: "Distributed", inputs: ["treasuryAmt", "stakersAmt", "providersAmt", "ecosystemAmt"].map((name) => ({ type: "uint256", name, indexed: false })) } as const;
    const reserved = { type: "event", name: "BuybackReserved", inputs: [{ type: "uint256", name: "amount", indexed: false }] } as const;
    rpc.waitForTransactionReceipt.mockResolvedValue({ status: "success", logs: [
      { address: config().FEE_VAULT_ADDRESS, topics: encodeEventTopics({ abi: [reserved], eventName: "BuybackReserved" }), data: encodeAbiParameters([{ type: "uint256" }], [80n]) },
      { address: config().FEE_VAULT_ADDRESS, topics: encodeEventTopics({ abi: [distributed], eventName: "Distributed" }), data: encodeAbiParameters(Array(4).fill({ type: "uint256" }), [720n, 100n, 50n, 50n]) },
    ] });
    expect(await createEconomicOps(config()).distributeWithAccounting()).toEqual({ tx, treasury: 720n, stakers: 100n, providers: 50n, ecosystem: 50n, reserved: 80n });
    expect(publicRpc.readContract).not.toHaveBeenCalled();
  });

  it("does not accept missing accounting events as a successful distribution", async () => {
    await expect(createEconomicOps(config()).distributeWithAccounting()).rejects.toThrow("did not emit Distributed");
  });

  it("ignores identically named events emitted by another address", async () => {
    const event = { type: "event", name: "RewardsClaimed", inputs: [{ type: "address", name: "who", indexed: true }, { type: "uint256", name: "amount", indexed: false }] } as const;
    rpc.waitForTransactionReceipt.mockResolvedValue({ status: "success", logs: [{
      address: recipient, topics: encodeEventTopics({ abi: [event], eventName: "RewardsClaimed", args: { who: recipient } }), data: encodeAbiParameters([{ type: "uint256" }], [100n]),
    }] });
    await expect(createEconomicOps(config()).claimRewards()).rejects.toThrow("did not emit RewardsClaimed");
  });

  it.each(["claimRewards", "distributeWithAccounting"] as const)("rejects a mined revert for %s", async (method) => {
    rpc.waitForTransactionReceipt.mockResolvedValue({ status: "reverted", logs: [] });
    await expect(createEconomicOps(config())[method]()).rejects.toThrow("Transaction reverted");
  });

  it("passes router settings and reserve bounds to the contract exactly", async () => {
    const ops = createEconomicOps(config());
    await ops.configureBuyback(recipient, config().USDC_ADDRESS as Hex, recipient);
    await ops.setBuybackReserve(1000);
    expect(rpc.writeContract).toHaveBeenNthCalledWith(1, expect.objectContaining({ functionName: "configureBuyback", args: [recipient, config().USDC_ADDRESS, recipient] }));
    expect(rpc.writeContract).toHaveBeenNthCalledWith(2, expect.objectContaining({ functionName: "setBuybackReserveBps", args: [1000] }));
  });
});

describe("production registry timelock", () => {
  it.each([[4599n, "pending"], [4600n, "ready"]] as const)("uses chain timestamp %s for readiness", async (timestamp, state) => {
    publicRpc.readContract.mockImplementation(async ({ functionName }) => functionName === "TIMELOCK" ? 3600n : [hash, hash, recipient, 1000n, 100, 1n, false, false]);
    publicRpc.getBlock.mockResolvedValue({ timestamp });
    expect(await createRegistryApproval(config()).status(1n)).toMatchObject({ state, availableAt: "4600", chainTimestamp: timestamp.toString() });
  });

  it("submits the timelocked approve function rather than bootstrap", async () => {
    expect(await createRegistryApproval(config()).approve(7n)).toBe(tx);
    expect(rpc.writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "approve", args: [7n] }));
  });
});

describe("buyback input boundaries", () => {
  it.each(["0", "-1", "1.5", "bad", (1n << 256n).toString()])("rejects invalid positive amount %s", (amountUnits) => {
    expect(BuybackExecuteBody.safeParse({ amountUnits, minOut: "1", deadline: "100" }).success).toBe(false);
  });
  it.each([-1, 1001, 1.5])("rejects invalid reserve bps %s", (treasuryBps) => {
    expect(BuybackReserveBody.safeParse({ treasuryBps }).success).toBe(false);
  });
  it("rejects placeholder router and token addresses", () => {
    expect(BuybackConfigBody.safeParse({ router: "0x0000000000000000000000000000000000000001", tokenOut: recipient, recipient }).success).toBe(false);
  });
});
