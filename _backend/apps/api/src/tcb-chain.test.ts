import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, maxUint256, zeroHash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Database } from "@enclave/db";
import { loadConfig } from "./config.js";
import { createTcbRegistry, tcbRegistryAbi, verifyTcbApproval, type TcbChainBinding } from "./tcb-chain.js";

const mocks = vi.hoisted(() => ({ chain: vi.fn(), block: vi.fn(), read: vi.fn(), send: vi.fn(), confirm: vi.fn() }));
vi.mock("viem", async (original) => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({ getChainId: mocks.chain, getBlock: mocks.block, readContract: mocks.read }) }));
vi.mock("@enclave/db", async (original) => ({ ...await original<typeof import("@enclave/db")>(), sendDurableTransaction: mocks.send, confirmDurableTransaction: mocks.confirm }));
const cfg = loadConfig({ DATABASE_URL: "postgres://unit.invalid/tcb", ARC_CHAIN_ID: "31337", ARC_RPC_URL: "http://unit.invalid/rpc",
  MODEL_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000001100", ENCL_TOKEN_ADDRESS: "0x0000000000000000000000000000000000001200" });
const binding: TcbChainBinding = { modelHash: `0x${"11".repeat(32)}`, codeHash: `0x${"22".repeat(32)}`, policyHash: `0x${"33".repeat(32)}`, policyVersion: 7n };
const genesis = `0x${"aa".repeat(32)}` as Hex;
const approveTx = `0x${"bb".repeat(32)}` as Hex;
const listTx = `0x${"cc".repeat(32)}` as Hex;
const provider = privateKeyToAccount(cfg.DEPLOYER_PRIVATE_KEY).address;
const db = {} as Database;
const scope = `31337:${genesis}:${cfg.MODEL_REGISTRY_ADDRESS}`;
function listed(changes: Partial<{ id: bigint; modelHash: Hex; codeHash: Hex; provider: Hex; address: Hex }> = {}) {
  return { address: changes.address ?? cfg.MODEL_REGISTRY_ADDRESS, topics: encodeEventTopics({ abi: tcbRegistryAbi, eventName: "Listed", args: { id: changes.id ?? 42n } }),
    data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }], [changes.modelHash ?? binding.modelHash, changes.codeHash ?? binding.codeHash, changes.provider ?? provider]) };
}
function policy(changes: Partial<{ id: bigint; policyHash: Hex; policyVersion: bigint; address: Hex }> = {}) {
  return { address: changes.address ?? cfg.MODEL_REGISTRY_ADDRESS, topics: encodeEventTopics({ abi: tcbRegistryAbi, eventName: "PolicyBound", args: { id: changes.id ?? 42n, policyHash: changes.policyHash ?? binding.policyHash } }),
    data: encodeAbiParameters([{ type: "uint64" }], [changes.policyVersion ?? binding.policyVersion]) };
}
function read(call: { functionName: string }) {
  switch (call.functionName) {
    case "TCB_BINDING_VERSION": return 1n;
    case "listingPolicy": return [binding.policyHash, binding.policyVersion];
    case "isApprovedWithPolicy": return true;
    case "idByHashes": return 42n;
    case "listingStake": return 10n;
    case "encl": return cfg.ENCL_TOKEN_ADDRESS;
    default: throw new Error("Unexpected read");
  }
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.chain.mockResolvedValue(31337); mocks.block.mockResolvedValue({ hash: genesis });
  mocks.read.mockImplementation(read);
  mocks.send.mockImplementation(async (_opts, _operation, call) => call.functionName === "approve" ? approveTx : listTx);
  mocks.confirm.mockImplementation(async (_opts, hash) => ({ status: "success", logs: hash === listTx ? [listed(), policy()] : [] }));
});

describe("TCB registry capability and exact immutable approval", () => {
  it("returns the exact chain/genesis/registry scope and listing for the approved tuple", async () => {
    await expect(verifyTcbApproval(cfg, { ...binding, version: 7 })).resolves.toEqual({ mode: "onchain", scope, listingId: 42n });
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ functionName: "isApprovedWithPolicy", args: [binding.modelHash, binding.codeHash, binding.policyHash, 7n] }));
    expect(mocks.block).toHaveBeenCalledWith({ blockNumber: 0n });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("preserves uint64 versions beyond JavaScript's exact integer range", async () => {
    const version = (1n << 64n) - 1n;
    await verifyTcbApproval(cfg, { ...binding, version });
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ functionName: "isApprovedWithPolicy", args: [binding.modelHash, binding.codeHash, binding.policyHash, version] }));
  });
  it("returns false and rejects activation for revoked, missing, unbound or mismatched policy tuples", async () => {
    mocks.read.mockImplementation((call) => call.functionName === "isApprovedWithPolicy" ? false : read(call));
    await expect(createTcbRegistry(cfg).isApproved(binding)).resolves.toBe(false);
    await expect(createTcbRegistry(cfg).assertApproved(binding)).rejects.toMatchObject({ code: "TCB_POLICY_NOT_APPROVED", statusCode: 409 });
  });
  it("reports an explicit zero binding when reading an old listing", async () => {
    mocks.read.mockImplementation((call) => call.functionName === "listingPolicy" ? [zeroHash, 0n] : read(call));
    await expect(createTcbRegistry(cfg).readPolicy(42n)).resolves.toEqual({ policyHash: zeroHash, policyVersion: 0n });
  });
  it("reads a policy-bound listing without writing", async () => {
    await expect(createTcbRegistry(cfg).readPolicy(42n)).resolves.toEqual({ policyHash: binding.policyHash, policyVersion: 7n });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each([0n, 2n, undefined])("fails closed for missing or unsupported registry capability %s", async (capability) => {
    mocks.read.mockImplementation((call) => call.functionName === "TCB_BINDING_VERSION" ? capability : read(call));
    await expect(createTcbRegistry({ ...cfg, ALLOW_LOCAL_BOOTSTRAP: true }).assertApproved(binding)).rejects.toMatchObject({ code: "TCB_BINDING_UNAVAILABLE", statusCode: 503 });
  });
  it("rejects a wrong RPC chain even on an explicitly local profile", async () => {
    mocks.chain.mockResolvedValue(1);
    await expect(createTcbRegistry(cfg).assertSupported()).rejects.toMatchObject({ code: "TCB_BINDING_UNAVAILABLE" });
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects a missing canonical genesis or unconfigured registry", async () => {
    mocks.block.mockResolvedValue({ hash: null });
    await expect(createTcbRegistry(cfg).assertSupported()).rejects.toMatchObject({ code: "TCB_BINDING_UNAVAILABLE" });
    await expect(createTcbRegistry({ ...cfg, MODEL_REGISTRY_ADDRESS: "not-an-address" }).assertSupported()).rejects.toMatchObject({ code: "TCB_BINDING_UNAVAILABLE" });
  });
  it.each(["TCB_BINDING_VERSION", "isApprovedWithPolicy", "listingPolicy", "idByHashes"])("turns unavailable %s reads into a closed capability error", async (functionName) => {
    mocks.read.mockImplementation((call) => { if (call.functionName === functionName) throw new Error("private RPC diagnostics"); return read(call); });
    const registry = createTcbRegistry(cfg);
    await expect(functionName === "listingPolicy" ? registry.readPolicy(42n) : registry.assertApproved(binding)).rejects.toMatchObject({ code: "TCB_BINDING_UNAVAILABLE", message: "Configured chain or registry cannot verify TCB policy bindings" });
  });
  it("rejects a contradictory approved tuple with no listing ID", async () => {
    mocks.read.mockImplementation((call) => call.functionName === "idByHashes" ? 0n : read(call));
    await expect(createTcbRegistry(cfg).assertApproved(binding)).rejects.toMatchObject({ code: "TCB_BINDING_UNAVAILABLE" });
  });
  it.each([0n, -1n, 1n << 64n])("rejects invalid policy version %s before RPC", async (policyVersion) => {
    await expect(createTcbRegistry(cfg).assertApproved({ ...binding, policyVersion })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(mocks.chain).not.toHaveBeenCalled();
  });
  it.each([Number.MAX_SAFE_INTEGER + 1, 1.5, NaN])("rejects unsafe JS version %s", async (version) => {
    await expect(verifyTcbApproval(cfg, { ...binding, version })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("rejects a runtime string version instead of silently coercing an unvalidated boundary", async () => {
    await expect(verifyTcbApproval(cfg, { ...binding, version: "7" as never })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("rejects a malformed policy digest before any RPC call", async () => {
    await expect(createTcbRegistry(cfg).isApproved({ ...binding, policyHash: "0x1234" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(mocks.chain).not.toHaveBeenCalled();
  });
  it.each(["modelHash", "codeHash", "policyHash"])("rejects missing %s before RPC", async (field) => {
    await expect(createTcbRegistry(cfg).assertApproved({ ...binding, [field]: zeroHash })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(mocks.chain).not.toHaveBeenCalled();
  });
  it.each([0n, -1n, 1n << 256n])("rejects invalid listing ID %s", async (id) => {
    await expect(createTcbRegistry(cfg).readPolicy(id)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("durable policy listing", () => {
  it("approves only the registry's configured stake token and journals the exact immutable tuple", async () => {
    const registry = createTcbRegistry({ ...cfg, CHAIN_CONFIRMATIONS: 3 }, db);
    await expect(registry.listWithPolicy(binding, 125, "request-1")).resolves.toEqual({ tx: listTx, id: 42n });
    const opts = expect.objectContaining({ db, rpcUrl: cfg.ARC_RPC_URL, chainId: 31337, confirmations: 3 });
    expect(mocks.send).toHaveBeenNthCalledWith(1, opts, `tcb-list:${cfg.MODEL_REGISTRY_ADDRESS}:request-1:approve`, expect.objectContaining({ address: cfg.ENCL_TOKEN_ADDRESS, functionName: "approve", args: [cfg.MODEL_REGISTRY_ADDRESS, maxUint256] }));
    expect(mocks.send).toHaveBeenNthCalledWith(2, opts, `tcb-list:${cfg.MODEL_REGISTRY_ADDRESS}:request-1:list`, expect.objectContaining({ functionName: "listWithPolicy", args: [binding.modelHash, binding.codeHash, 125, binding.policyHash, 7n] }));
    expect(mocks.confirm).toHaveBeenCalledWith(opts, approveTx); expect(mocks.confirm).toHaveBeenCalledWith(opts, listTx);
  });
  it("reuses stable durable operation keys for retries and omits approval when no stake is required", async () => {
    mocks.read.mockImplementation((call) => call.functionName === "listingStake" ? 0n : read(call));
    const registry = createTcbRegistry(cfg, db);
    await registry.listWithPolicy(binding, 0, "retry"); await registry.listWithPolicy(binding, 0, "retry");
    expect(mocks.send.mock.calls.map((args) => args[1])).toEqual([`tcb-list:${cfg.MODEL_REGISTRY_ADDRESS}:retry:list`, `tcb-list:${cfg.MODEL_REGISTRY_ADDRESS}:retry:list`]);
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
  });
  it("requires the durable database before any chain write", async () => {
    await expect(createTcbRegistry(cfg).listWithPolicy(binding, 0, "request")).rejects.toMatchObject({ code: "TCB_SIGNER_UNAVAILABLE" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each([-1, 10001, 1.5])("rejects invalid listing bps %s", async (bps) => {
    await expect(createTcbRegistry(cfg, db).listWithPolicy(binding, bps, "request")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each(["", " ", "a".repeat(201)])("rejects invalid durable operation key %#", async (operation) => {
    await expect(createTcbRegistry(cfg, db).listWithPolicy(binding, 0, operation)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("never approves a different token than the configured ENCL", async () => {
    mocks.read.mockImplementation((call) => call.functionName === "encl" ? "0x0000000000000000000000000000000000009900" : read(call));
    await expect(createTcbRegistry(cfg, db).listWithPolicy(binding, 0, "request")).rejects.toThrow("stake token");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each([approveTx, listTx])("does not report success after reverted transaction %s", async (revertedHash) => {
    mocks.confirm.mockImplementation(async (_opts, hash) => ({ status: hash === revertedHash ? "reverted" : "success", logs: [listed(), policy()] }));
    await expect(createTcbRegistry(cfg, db).listWithPolicy(binding, 0, "request")).rejects.toThrow("reverted");
    expect(mocks.send).toHaveBeenCalledTimes(revertedHash === approveTx ? 1 : 2);
  });
  it("does not send the listing when approval finality is unavailable", async () => {
    mocks.confirm.mockRejectedValue(new Error("Approval confirmation unavailable"));
    await expect(createTcbRegistry(cfg, db).listWithPolicy(binding, 0, "request")).rejects.toThrow("confirmation unavailable");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]![2].functionName).toBe("approve");
  });
  it("retains the same listing journal key after an ambiguous send", async () => {
    mocks.read.mockImplementation((call) => call.functionName === "listingStake" ? 0n : read(call));
    mocks.send.mockRejectedValueOnce(new Error("Broadcast response lost"));
    const registry = createTcbRegistry(cfg, db);
    await expect(registry.listWithPolicy(binding, 0, "ambiguous-retry")).rejects.toThrow("Broadcast response lost");
    await expect(registry.listWithPolicy(binding, 0, "ambiguous-retry")).resolves.toEqual({ tx: listTx, id: 42n });
    expect(mocks.send.mock.calls[0]![1]).toBe(mocks.send.mock.calls[1]![1]);
    expect(mocks.send.mock.calls[0]![2]).toEqual(mocks.send.mock.calls[1]![2]);
  });
  it.each([
    () => [listed({ provider: "0x0000000000000000000000000000000000009900" }), policy()],
    () => [listed({ modelHash: zeroHash }), policy()],
    () => [listed({ address: "0x0000000000000000000000000000000000009900" }), policy()],
    () => [listed(), listed(), policy()],
    () => [listed(), policy({ policyHash: zeroHash })],
    () => [listed(), policy({ policyVersion: 8n })],
    () => [listed(), policy({ id: 43n })],
    () => [listed({ id: 0n }), policy({ id: 0n })],
    () => [listed(), policy(), policy()],
  ])("rejects misleading receipt events %#", async (logs) => {
    mocks.confirm.mockResolvedValue({ status: "success", logs: logs() });
    await expect(createTcbRegistry(cfg, db).listWithPolicy(binding, 0, "request")).rejects.toThrow("TCB listing receipt lacks");
  });
});
