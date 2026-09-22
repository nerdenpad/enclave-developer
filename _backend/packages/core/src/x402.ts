export const USDC_DECIMALS = 6;

export type X402Requirement = {
  x402Version: 1;
  accepts: Array<{
    scheme: "exact";
    network: string;
    maxAmountRequired: string;
    payTo: string;
    asset: string;
    extra: { receiptPending: boolean; paymentId: string };
  }>;
};

export function usdcToUnits(amount: number): bigint {
  const units = Math.round(amount * 10 ** USDC_DECIMALS);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(units)) {
    throw new Error("USDC amount must be non-negative and fit safe integer units");
  }
  return BigInt(units);
}

export function paymentRequiredBody(opts: {
  network: string;
  amountUnits: bigint;
  payTo: string;
  asset: string;
  paymentId: string;
}): X402Requirement {
  if (opts.amountUnits < 0n) {
    throw new Error("Payment amount must be non-negative");
  }
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: opts.network,
        maxAmountRequired: opts.amountUnits.toString(),
        payTo: opts.payTo,
        asset: opts.asset,
        extra: { receiptPending: true, paymentId: opts.paymentId },
      },
    ],
  };
}
