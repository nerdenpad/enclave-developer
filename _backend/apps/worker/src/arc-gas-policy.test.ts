import { describe, expect, it } from "vitest";
import { enforceArcRelayGas } from "@enclave/db";

describe("Arc relay gas policy", () => {
  it("accepts bounded EIP-1559 and legacy quotes using native 18-decimal USDC", () => {
    expect(() => enforceArcRelayGas(5042, { gas: 1_000_000n, maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 1n })).not.toThrow();
    expect(() => enforceArcRelayGas(5042, { gas: 100_000n, gasPrice: 20_000_000_000n })).not.toThrow();
  });
  it.each([
    {}, { gas: 0n, gasPrice: 20_000_000_000n }, { gas: 1_000_001n, gasPrice: 20_000_000_000n },
    { gas: 100_000n, gasPrice: 19_999_999_999n }, { gas: 100_000n, maxFeePerGas: 100_000_000_001n },
    { gas: 100_000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 21_000_000_000n },
    { gas: 100_000n, maxFeePerGas: 20_000_000_000n, value: 1n },
  ])("rejects unsafe or incomplete quotes before signing: %s", quote => {
    expect(() => enforceArcRelayGas(5042, quote)).toThrow("ARC_RELAY_GAS_LIMIT");
  });
  it("does not change isolated development-chain behavior", () => {
    expect(() => enforceArcRelayGas(31337, { value: 8n })).not.toThrow();
  });
});
