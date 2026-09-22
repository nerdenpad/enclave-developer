import { describe, expect, it } from "vitest";
import { MandateBreachError, reserveMandate } from "./index.js";

describe("reserveMandate", () => {
  const base = { dailyLimitUnits: 100n, spentTodayUnits: 90n, dayKey: "2026-09-14" };

  it("rejects when the daily cap would be exceeded", () => {
    expect(() => reserveMandate(base, "2026-09-14", 11n)).toThrow(MandateBreachError);
  });

  it("resets spend on a new day", () => {
    const next = reserveMandate(base, "2026-09-15", 50n);
    expect(next.spentTodayUnits).toBe(50n);
    expect(next.dayKey).toBe("2026-09-15");
  });
});
