/** Anvil `.env.example` placeholders occupy 0x1..0x10; the zero address is never a live contract. */
const PLACEHOLDER_MAX = 16n;

export function isConfiguredAddress(value: string | undefined | null): value is `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return false;
  }
  try {
    return BigInt(value) > PLACEHOLDER_MAX;
  } catch {
    return false;
  }
}
