export const FEE_SPLIT_BPS = {
  treasury: 80,
  stakers: 10,
  providers: 5,
  ecosystem: 5,
} as const;

export type FeeSplit = {
  treasury: bigint;
  stakers: bigint;
  providers: bigint;
  ecosystem: bigint;
};

export function splitFee(amount: bigint): FeeSplit {
  if (amount < 0n) {
    throw new Error("amount");
  }
  const treasury = (amount * BigInt(FEE_SPLIT_BPS.treasury)) / 100n;
  const stakers = (amount * BigInt(FEE_SPLIT_BPS.stakers)) / 100n;
  const providers = (amount * BigInt(FEE_SPLIT_BPS.providers)) / 100n;
  const ecosystem = amount - treasury - stakers - providers;
  return { treasury, stakers, providers, ecosystem };
}
