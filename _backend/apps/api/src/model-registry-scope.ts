import { apiRpcTransport } from "./rpc-transport.js";
import { ConflictError, indexerScope } from "@enclave/core";
import { createPublicClient } from "viem";
import { foundry } from "viem/chains";
import type { Config } from "./config.js";

/** Resolve the exact scope used by the indexer; fail before reading rows on an invalid RPC identity. */
export async function modelRegistryScope(config: Config): Promise<string> {
  const rpc = createPublicClient({ chain: { ...foundry, id: config.ARC_CHAIN_ID },
    transport: apiRpcTransport(config, { timeout: 15_000, retryCount: 1 }), cacheTime: 0 });
  if (await rpc.getChainId() !== config.ARC_CHAIN_ID) throw new ConflictError("Registry RPC chain mismatch");
  const genesis = await rpc.getBlock({ blockNumber: 0n });
  if (genesis.number !== 0n || !genesis.hash || !/^0x[0-9a-fA-F]{64}$/.test(genesis.hash)) {
    throw new ConflictError("Registry canonical genesis is unavailable");
  }
  return indexerScope({ chainId: config.ARC_CHAIN_ID, genesisHash: genesis.hash,
    verifier: config.ATTESTATION_VERIFIER_ADDRESS, meter: config.USAGE_METER_ADDRESS,
    feeVault: config.FEE_VAULT_ADDRESS, registry: config.MODEL_REGISTRY_ADDRESS,
    ...(config.CHAIN_DEPLOYMENT_ID ? { deploymentId: config.CHAIN_DEPLOYMENT_ID } : {}) });
}
