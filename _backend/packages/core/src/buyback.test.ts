import { describe, expect, it } from "vitest";
import { buybackFromTreasury } from "./buyback.js";
import { splitFee } from "./fees.js";

describe("buyback stub math", () => {
  it("queues 10% of the treasury slice and never exceeds it", () => {
    const { treasury } = splitFee(1_000_000n);
    expect(treasury).toBe(800_000n);
    expect(buybackFromTreasury(treasury)).toBe(80_000n);
    expect(buybackFromTreasury(treasury) <= treasury).toBe(true);
    expect(buybackFromTreasury(0n)).toBe(0n);
  });
});
