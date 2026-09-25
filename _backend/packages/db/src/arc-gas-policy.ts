/** Conservative relay limits, independent of the customer tariff. Deployment uses customer signing. */
export const ARC_RELAY_LIMITS = Object.freeze({
  chainId: 5042, minFeePerGas: 20_000_000_000n, maxFeePerGas: 100_000_000_000n,
  maxGas: 1_000_000n, maxTransactionCost: 100_000_000_000_000_000n, // 0.10 native USDC
});

export function enforceArcRelayGas(chainId: number, prepared: {
  gas?: bigint | undefined; gasPrice?: bigint | undefined; maxFeePerGas?: bigint | undefined; maxPriorityFeePerGas?: bigint | undefined; value?: bigint | undefined;
}): void {
  if (chainId !== ARC_RELAY_LIMITS.chainId) return;
  const fee = prepared.maxFeePerGas ?? prepared.gasPrice;
  const gas = prepared.gas;
  const priority = prepared.maxPriorityFeePerGas ?? 0n;
  if (typeof gas !== "bigint" || gas <= 0n || gas > ARC_RELAY_LIMITS.maxGas
    || typeof fee !== "bigint" || fee < ARC_RELAY_LIMITS.minFeePerGas || fee > ARC_RELAY_LIMITS.maxFeePerGas
    || priority < 0n || priority > fee || gas * fee > ARC_RELAY_LIMITS.maxTransactionCost
    || (prepared.value ?? 0n) !== 0n) {
    throw new Error("ARC_RELAY_GAS_LIMIT: transaction exceeds the reviewed relay policy; no new transaction was signed");
  }
}
