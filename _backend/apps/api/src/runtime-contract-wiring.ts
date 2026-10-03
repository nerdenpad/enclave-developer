import { createPublicClient, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AppError } from "@enclave/core";
import type { Config } from "./config.js";
import { apiRpcTransport } from "./rpc-transport.js";

const verifierAbi = parseAbi([
  "function registry() view returns (address)", "function enclaveSigner() view returns (address)",
]);
const meterAbi = parseAbi([
  "function usdc() view returns (address)", "function feeVault() view returns (address)",
  "function modelRegistry() view returns (address)", "function relay() view returns (address)",
]);
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** Fresh, read-only admission/publication gate. No signatures, sends or cached approvals. */
export async function verifyRuntimeContractWiring(config: Config, expectedSigner: Hex): Promise<void> {
  const rpc = createPublicClient({ transport: apiRpcTransport(config, { timeout: 15_000, retryCount: 0 }), cacheTime: 0 });
  const mismatch = () => new AppError("PAYMENTS_RUNTIME_MISMATCH", "The current contract signer or payment routing differs from this deployment", 409);
  try {
    if (await rpc.getChainId() !== config.ARC_CHAIN_ID) throw mismatch();
    const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 });
    const before = await rpc.getBlock({ blockNumber });
    const verifier = config.ATTESTATION_VERIFIER_ADDRESS as Hex, meter = config.USAGE_METER_ADDRESS as Hex;
    const [registry, signer, token, vault, meterRegistry, relay] = await Promise.all([
      rpc.readContract({ address: verifier, abi: verifierAbi, functionName: "registry", blockNumber }),
      rpc.readContract({ address: verifier, abi: verifierAbi, functionName: "enclaveSigner", blockNumber }),
      rpc.readContract({ address: meter, abi: meterAbi, functionName: "usdc", blockNumber }),
      rpc.readContract({ address: meter, abi: meterAbi, functionName: "feeVault", blockNumber }),
      rpc.readContract({ address: meter, abi: meterAbi, functionName: "modelRegistry", blockNumber }),
      rpc.readContract({ address: meter, abi: meterAbi, functionName: "relay", blockNumber }),
    ]);
    if (!same(registry, config.MODEL_REGISTRY_ADDRESS) || !same(signer, expectedSigner)
      || !same(token, config.USDC_ADDRESS) || !same(vault, config.FEE_VAULT_ADDRESS)
      || !same(meterRegistry, config.MODEL_REGISTRY_ADDRESS)
      || !same(relay, privateKeyToAccount(config.DEPLOYER_PRIVATE_KEY).address)) throw mismatch();
    const after = await rpc.getBlock({ blockNumber });
    if (!before.hash || before.hash !== after.hash) throw mismatch();
  } catch (error) {
    if (error instanceof AppError && error.code === "PAYMENTS_RUNTIME_MISMATCH") throw error;
    // Provider transport errors can contain RPC credentials. Only expose a fixed diagnostic.
    throw new AppError("PAYMENTS_RUNTIME_UNAVAILABLE", "Current contract signer and payment routing could not be verified", 503);
  }
}
