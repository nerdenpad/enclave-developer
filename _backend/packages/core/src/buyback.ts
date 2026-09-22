/** Share of the treasury slice queued for ENCL buyback (stub, no DEX). 1000 = 10%. */
export const BUYBACK_OF_TREASURY_BPS = 1000n;

export function buybackFromTreasury(treasuryAmount: bigint): bigint {
  if (treasuryAmount < 0n) {
    throw new Error("amount");
  }
  return (treasuryAmount * BUYBACK_OF_TREASURY_BPS) / 10_000n;
}
