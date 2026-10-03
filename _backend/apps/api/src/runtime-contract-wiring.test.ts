import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.js";
import { verifyRuntimeContractWiring } from "./runtime-contract-wiring.js";

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBlockNumber: vi.fn(), getBlock: vi.fn(), readContract: vi.fn() }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: vi.fn(() => rpc) }));
vi.mock("./rpc-transport.js", () => ({ apiRpcTransport: vi.fn(() => ({})) }));
const config = { ARC_CHAIN_ID: 5042, ARC_RPC_URL: "https://rpc.fixture.invalid", ARC_RPC_MAX_RPS: 2,
  DEPLOYER_PRIVATE_KEY: `0x${"23".repeat(32)}`, ATTESTATION_VERIFIER_ADDRESS: `0x${"11".repeat(20)}`,
  USAGE_METER_ADDRESS: `0x${"12".repeat(20)}`, MODEL_REGISTRY_ADDRESS: `0x${"13".repeat(20)}`,
  FEE_VAULT_ADDRESS: `0x${"14".repeat(20)}`, USDC_ADDRESS: "0x3600000000000000000000000000000000000000" } as Config;
const signer = privateKeyToAccount(`0x${"42".repeat(32)}`).address;
const values = { registry: config.MODEL_REGISTRY_ADDRESS, enclaveSigner: signer, usdc: config.USDC_ADDRESS,
  feeVault: config.FEE_VAULT_ADDRESS, modelRegistry: config.MODEL_REGISTRY_ADDRESS,
  relay: privateKeyToAccount(config.DEPLOYER_PRIVATE_KEY).address };
beforeEach(() => {
  vi.clearAllMocks();
  rpc.getChainId.mockReset().mockResolvedValue(5042); rpc.getBlockNumber.mockReset().mockResolvedValue(200n);
  rpc.getBlock.mockReset().mockResolvedValue({ hash: `0x${"55".repeat(32)}` });
  rpc.readContract.mockReset().mockImplementation(async ({ functionName }: { functionName: keyof typeof values }) => values[functionName]);
});
describe("fresh runtime contract wiring", () => {
  it("reads the complete signer/routing tuple at one canonical block", async () => {
    await expect(verifyRuntimeContractWiring(config, signer)).resolves.toBeUndefined();
    expect(rpc.readContract).toHaveBeenCalledTimes(6);
    expect(rpc.readContract.mock.calls.every(([call]) => call.blockNumber === 200n)).toBe(true);
    expect(rpc.getBlock).toHaveBeenNthCalledWith(1, { blockNumber: 200n });
    expect(rpc.getBlock).toHaveBeenNthCalledWith(2, { blockNumber: 200n });
  });
  it("checks again and rejects a signer rotated without a gateway restart", async () => {
    await verifyRuntimeContractWiring(config, signer);
    rpc.readContract.mockImplementation(async ({ functionName }: { functionName: keyof typeof values }) => functionName === "enclaveSigner" ? config.USAGE_METER_ADDRESS : values[functionName]);
    await expect(verifyRuntimeContractWiring(config, signer)).rejects.toMatchObject({ code: "PAYMENTS_RUNTIME_MISMATCH", statusCode: 409 });
    expect(rpc.getChainId).toHaveBeenCalledTimes(2);
  });
  it.each(["registry", "enclaveSigner", "usdc", "feeVault", "modelRegistry", "relay"] as const)("rejects changed %s", async name => {
    rpc.readContract.mockImplementation(async ({ functionName }: { functionName: keyof typeof values }) => functionName === name ? config.USAGE_METER_ADDRESS : values[functionName]);
    await expect(verifyRuntimeContractWiring(config, signer)).rejects.toMatchObject({ code: "PAYMENTS_RUNTIME_MISMATCH" });
  });
  it("rejects an RPC network mismatch before any contract reads", async () => {
    rpc.getChainId.mockResolvedValue(31337);
    await expect(verifyRuntimeContractWiring(config, signer)).rejects.toMatchObject({ code: "PAYMENTS_RUNTIME_MISMATCH" });
    expect(rpc.readContract).not.toHaveBeenCalled();
  });
  it("rejects a reorganization during the read", async () => {
    rpc.getBlock.mockResolvedValueOnce({ hash: "0x01" }).mockResolvedValueOnce({ hash: "0x02" });
    await expect(verifyRuntimeContractWiring(config, signer)).rejects.toMatchObject({ code: "PAYMENTS_RUNTIME_MISMATCH" });
  });
  it("rejects an unavailable RPC without leaking transport credentials", async () => {
    rpc.readContract.mockRejectedValue(new Error("private RPC bearer and endpoint"));
    await expect(verifyRuntimeContractWiring(config, signer)).rejects.toMatchObject({ code: "PAYMENTS_RUNTIME_UNAVAILABLE", statusCode: 503 });
    await expect(verifyRuntimeContractWiring(config, signer)).rejects.not.toThrow("private RPC");
  });
});
