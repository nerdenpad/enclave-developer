import { createPublicClient, getAddress, http, maxUint256, parseAbi, parseEventLogs, zeroHash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { AppError, ConflictError, isConfiguredAddress, ValidationError } from "@enclave/core";
import { confirmDurableTransaction, sendDurableTransaction, type Database } from "@enclave/db";
import type { Config } from "./config.js";

export const tcbRegistryAbi = parseAbi([
  "function TCB_BINDING_VERSION() view returns (uint256)",
  "function listingPolicy(uint256 id) view returns (bytes32 policyHash,uint64 policyVersion)",
  "function isApprovedWithPolicy(bytes32 modelHash,bytes32 codeHash,bytes32 policyHash,uint64 policyVersion) view returns (bool)",
  "function listWithPolicy(bytes32 modelHash,bytes32 codeHash,uint16 listingBps,bytes32 policyHash,uint64 policyVersion) returns (uint256 id)",
  "function idByHashes(bytes32 modelHash,bytes32 codeHash) view returns (uint256)",
  "function listingStake() view returns (uint256)",
  "function encl() view returns (address)",
  "event Listed(uint256 indexed id,bytes32 modelHash,bytes32 codeHash,address provider)",
  "event PolicyBound(uint256 indexed id,bytes32 indexed policyHash,uint64 policyVersion)",
]);
const tokenAbi = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
export type TcbChainBinding = { modelHash: Hex; codeHash: Hex; policyHash: Hex; policyVersion: bigint };
export type TcbApproval = { mode: "onchain"; scope: string; listingId: bigint };

function validate(binding: TcbChainBinding): void {
  for (const value of [binding.modelHash, binding.codeHash, binding.policyHash]) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value) || value.toLowerCase() === zeroHash) throw new ValidationError({ policy: "Expected nonzero model, code and policy hashes" });
  }
  if (typeof binding.policyVersion !== "bigint" || binding.policyVersion <= 0n || binding.policyVersion > UINT64_MAX) throw new ValidationError({ policyVersion: "Expected positive uint64" });
}
function unavailable(): AppError { return new AppError("TCB_BINDING_UNAVAILABLE", "Configured chain or registry cannot verify TCB policy bindings", 503); }

/** Explicit immutable commitments only. No local bypass or independent hardware verification is implied. */
export function createTcbRegistry(config: Config, db?: Database) {
  const rpc = createPublicClient({ chain: { ...foundry, id: config.ARC_CHAIN_ID }, transport: http(config.ARC_RPC_URL, { timeout: 15_000, retryCount: 1 }), cacheTime: 0 });
  const address = config.MODEL_REGISTRY_ADDRESS as Hex;
  async function assertSupported(): Promise<{ scope: string }> {
    try {
      if (!isConfiguredAddress(address) || await rpc.getChainId() !== config.ARC_CHAIN_ID) throw unavailable();
      const genesis = await rpc.getBlock({ blockNumber: 0n });
      if (!genesis.hash || await rpc.readContract({ address, abi: tcbRegistryAbi, functionName: "TCB_BINDING_VERSION" }) !== 1n) throw unavailable();
      return { scope: `${config.ARC_CHAIN_ID}:${genesis.hash.toLowerCase()}:${address.toLowerCase()}` };
    } catch { throw unavailable(); }
  }
  async function readPolicy(listingId: bigint): Promise<{ policyHash: Hex; policyVersion: bigint }> {
    if (typeof listingId !== "bigint" || listingId <= 0n || listingId > UINT256_MAX) throw new ValidationError({ listingId: "Expected positive uint256" });
    await assertSupported();
    try {
      const [policyHash, policyVersion] = await rpc.readContract({ address, abi: tcbRegistryAbi, functionName: "listingPolicy", args: [listingId] });
      return { policyHash, policyVersion };
    } catch { throw unavailable(); }
  }
  async function approval(binding: TcbChainBinding) {
    validate(binding);
    const { scope } = await assertSupported();
    try {
      const approved = await rpc.readContract({ address, abi: tcbRegistryAbi, functionName: "isApprovedWithPolicy",
        args: [binding.modelHash, binding.codeHash, binding.policyHash, binding.policyVersion] });
      return { approved, scope };
    } catch { throw unavailable(); }
  }
  async function assertApproved(binding: TcbChainBinding): Promise<TcbApproval> {
    const { approved, scope } = await approval(binding);
    if (!approved) throw new AppError("TCB_POLICY_NOT_APPROVED", "Model, code and TCB policy are not approved together", 409);
    let listingId: bigint;
    try { listingId = await rpc.readContract({ address, abi: tcbRegistryAbi, functionName: "idByHashes", args: [binding.modelHash, binding.codeHash] }); }
    catch { throw unavailable(); }
    if (listingId === 0n) throw unavailable();
    return { mode: "onchain", scope, listingId };
  }
  return {
    assertSupported, readPolicy, assertApproved,
    async isApproved(binding: TcbChainBinding): Promise<boolean> { return (await approval(binding)).approved; },
    async listWithPolicy(binding: TcbChainBinding, bps: number, operationKey: string): Promise<{ tx: Hex; id: bigint }> {
      validate(binding);
      if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new ValidationError({ bps: "Expected integer basis points from 0 to 10000" });
      if (typeof operationKey !== "string" || !operationKey.trim() || operationKey.length > 200) throw new ValidationError({ operationKey: "Expected a stable nonempty operation key up to 200 characters" });
      if (!db) throw new AppError("TCB_SIGNER_UNAVAILABLE", "TCB listings require the durable signer database", 503);
      await assertSupported();
      const provider = privateKeyToAccount(config.DEPLOYER_PRIVATE_KEY).address;
      const options = { db, rpcUrl: config.ARC_RPC_URL, chainId: config.ARC_CHAIN_ID, privateKey: config.DEPLOYER_PRIVATE_KEY,
        ...(config.CHAIN_CONFIRMATIONS === undefined ? {} : { confirmations: config.CHAIN_CONFIRMATIONS }) };
      const prefix = `tcb-list:${address.toLowerCase()}:${operationKey}`;
      const stake = await rpc.readContract({ address, abi: tcbRegistryAbi, functionName: "listingStake" });
      if (stake > 0n) {
        const token = await rpc.readContract({ address, abi: tcbRegistryAbi, functionName: "encl" });
        if (!isConfiguredAddress(config.ENCL_TOKEN_ADDRESS) || token.toLowerCase() !== config.ENCL_TOKEN_ADDRESS.toLowerCase()) throw new ConflictError("Registry stake token does not match configured ENCL");
        const hash = await sendDurableTransaction(options, `${prefix}:approve`, { address: getAddress(token), abi: tokenAbi, functionName: "approve", args: [address, maxUint256] });
        if ((await confirmDurableTransaction(options, hash)).status !== "success") throw new ConflictError("TCB listing stake approval reverted");
      }
      const hash = await sendDurableTransaction(options, `${prefix}:list`, { address, abi: tcbRegistryAbi, functionName: "listWithPolicy",
        args: [binding.modelHash, binding.codeHash, bps, binding.policyHash, binding.policyVersion] });
      const receipt = await confirmDurableTransaction(options, hash);
      if (receipt.status !== "success") throw new ConflictError("TCB listing transaction reverted");
      const logs = receipt.logs.filter((log) => log.address.toLowerCase() === address.toLowerCase());
      const listed = parseEventLogs({ abi: tcbRegistryAbi, eventName: "Listed", logs, strict: true }).filter(({ args }) =>
        args.modelHash.toLowerCase() === binding.modelHash.toLowerCase() && args.codeHash.toLowerCase() === binding.codeHash.toLowerCase() && args.provider.toLowerCase() === provider.toLowerCase());
      if (listed.length !== 1) throw new ConflictError("TCB listing receipt lacks the exact provider/model event");
      const id = listed[0]!.args.id;
      const policies = parseEventLogs({ abi: tcbRegistryAbi, eventName: "PolicyBound", logs, strict: true }).filter(({ args }) =>
        args.id === id && args.policyHash.toLowerCase() === binding.policyHash.toLowerCase() && args.policyVersion === binding.policyVersion);
      if (id === 0n || policies.length !== 1) throw new ConflictError("TCB listing receipt lacks the exact policy binding");
      return { tx: hash, id };
    },
  };
}

/** API lifecycle entry point. A bigint version preserves all onchain uint64 values. */
export async function verifyTcbApproval(config: Config, input: { modelHash: Hex; codeHash: Hex; policyHash: Hex; version: number | bigint }): Promise<TcbApproval> {
  if ((typeof input.version !== "number" && typeof input.version !== "bigint") || (typeof input.version === "number" && !Number.isSafeInteger(input.version))) throw new ValidationError({ version: "Expected a safe integer or bigint policy version" });
  return createTcbRegistry(config).assertApproved({ modelHash: input.modelHash, codeHash: input.codeHash, policyHash: input.policyHash, policyVersion: BigInt(input.version) });
}
