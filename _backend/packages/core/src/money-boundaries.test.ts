import { describe, expect, it } from "vitest";
import { buybackFromTreasury, paymentRequiredBody, reserveMandate, splitFee, usdcToUnits } from "./index.js";

describe("monetary boundary invariants", () => {
  it.each([0n, 1n, 7n, 19n, 99n, 100n, 101n, 10n ** 30n])("preserves every fee unit for amount %s", (amount) => {
    const split = splitFee(amount);
    expect(split.treasury + split.stakers + split.providers + split.ecosystem).toBe(amount);
    for (const part of Object.values(split)) {
      expect(part).toBeGreaterThanOrEqual(0n);
      expect(part).toBeLessThanOrEqual(amount);
    }
    expect(split.treasury).toBe((amount * 80n) / 100n);
    expect(split.stakers).toBe((amount * 10n) / 100n);
    expect(split.providers).toBe((amount * 5n) / 100n);
  });

  it("rejects negative fees and buybacks", () => {
    expect(() => splitFee(-1n)).toThrow();
    expect(() => buybackFromTreasury(-1n)).toThrow();
  });

  it("rounds buybacks down without inventing dust or losing bigint precision", () => {
    expect(buybackFromTreasury(9n)).toBe(0n);
    expect(buybackFromTreasury(19n)).toBe(1n);
    expect(buybackFromTreasury(10n ** 30n + 9n)).toBe(10n ** 29n);
  });

  it.each([
    [0, 0n],
    [0.000001, 1n],
    [0.00000049, 0n],
    [0.00000051, 1n],
    [1.234567, 1_234_567n],
    [0.1 + 0.2, 300_000n],
  ])("converts %s USDC to six-decimal integer units", (amount, expected) => {
    expect(usdcToUnits(amount as number)).toBe(expected);
  });

  it("allows exact-limit and zero reservations without mutating the stored snapshot", () => {
    const row = { dailyLimitUnits: 100n, spentTodayUnits: 90n, dayKey: "2026-09-16" };
    const next = reserveMandate(row, row.dayKey, 10n);
    expect(next.spentTodayUnits).toBe(100n);
    expect(next).not.toBe(row);
    expect(row.spentTodayUnits).toBe(90n);
    expect(reserveMandate(next, row.dayKey, 0n).spentTodayUnits).toBe(100n);
    expect(() => reserveMandate(next, row.dayKey, 1n)).toThrow();
  });

  it("applies the cap after a day reset, including zero limits", () => {
    const previous = { dailyLimitUnits: 100n, spentTodayUnits: 100n, dayKey: "2026-09-15" };
    expect(reserveMandate(previous, "2026-09-16", 100n).spentTodayUnits).toBe(100n);
    expect(() => reserveMandate(previous, "2026-09-16", 101n)).toThrow();
    const blocked = { ...previous, dailyLimitUnits: 0n };
    expect(reserveMandate(blocked, "2026-09-16", 0n).spentTodayUnits).toBe(0n);
    expect(() => reserveMandate(blocked, "2026-09-16", 1n)).toThrow();
  });

  it("retains exact bigint amounts and all routing fields in the x402 challenge", () => {
    const amount = 10n ** 30n + 123n;
    const body = paymentRequiredBody({
      amountUnits: amount,
      network: "arc-testnet",
      payTo: "0xrecipient",
      asset: "0xusdc",
      paymentId: "payment-id",
    });
    expect(body).toEqual({
      x402Version: 1,
      accepts: [{
        scheme: "exact",
        network: "arc-testnet",
        maxAmountRequired: amount.toString(),
        payTo: "0xrecipient",
        asset: "0xusdc",
        extra: { receiptPending: true, paymentId: "payment-id" },
      }],
    });
    expect(() => JSON.stringify(body)).not.toThrow();
  });
});
