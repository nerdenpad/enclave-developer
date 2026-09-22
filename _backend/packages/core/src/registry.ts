export type ModelListingState = {
  approved: boolean;
  revoked: boolean;
};

export function modelServingAllowed(row: ModelListingState | undefined | null): boolean {
  return Boolean(row?.approved) && !row?.revoked;
}

export function listingBpsValid(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 0 && bps <= 10_000;
}
