import { MandateBreachError } from "./errors.js";

export type MandateSnapshot = {
  dailyLimitUnits: bigint;
  spentTodayUnits: bigint;
  dayKey: string;
};

export function reserveMandate(row: MandateSnapshot, day: string, amount: bigint): MandateSnapshot {
  if (amount < 0n || row.dailyLimitUnits < 0n || row.spentTodayUnits < 0n) {
    throw new MandateBreachError("Mandate amounts must be non-negative");
  }
  const spent = row.dayKey === day ? row.spentTodayUnits : 0n;
  if (spent + amount > row.dailyLimitUnits) {
    throw new MandateBreachError();
  }
  return { dailyLimitUnits: row.dailyLimitUnits, dayKey: day, spentTodayUnits: spent + amount };
}
