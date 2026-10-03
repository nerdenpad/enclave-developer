import { keccak256, stringToHex, type Hex } from "viem";
import { isConfiguredAddress } from "./addresses.js";

/** Shared identity for indexed rows and public registry reads; preserve its encoded field order. */
export function indexerScope(input: {
  chainId: number;
  genesisHash: Hex;
  deploymentId?: string | undefined;
  verifier?: string | undefined;
  meter?: string | undefined;
  feeVault?: string | undefined;
  registry?: string | undefined;
}): string {
  const normalize = (value: string | undefined) => isConfiguredAddress(value) ? value.toLowerCase() : null;
  const identity = {
    genesis: input.genesisHash.toLowerCase(), deployment: input.deploymentId ?? "",
    verifier: normalize(input.verifier), meter: normalize(input.meter),
    feeVault: normalize(input.feeVault), registry: normalize(input.registry),
  };
  return `enclave-v2:${input.chainId}:${keccak256(stringToHex(JSON.stringify(identity)))}`;
}
