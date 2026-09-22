import { describe, expect, it } from "vitest";
import { splitFee } from "./fees.js";

describe("splitFee", () => {
  it("splits 80/10/5/5 and preserves the full amount", () => {
    const amount = 1_000_000n;
    const parts = splitFee(amount);
    expect(parts.treasury).toBe(800_000n);
    expect(parts.stakers).toBe(100_000n);
    expect(parts.providers).toBe(50_000n);
    expect(parts.ecosystem).toBe(50_000n);
    expect(parts.treasury + parts.stakers + parts.providers + parts.ecosystem).toBe(amount);
  });

  it("puts remainder dust on ecosystem so units are not lost", () => {
    const parts = splitFee(7n);
    expect(parts.treasury + parts.stakers + parts.providers + parts.ecosystem).toBe(7n);
    expect(parts.ecosystem).toBe(7n - parts.treasury - parts.stakers - parts.providers);
  });
});
