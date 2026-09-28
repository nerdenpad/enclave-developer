import { describe, expect, it } from "vitest";
import { arcTransactionUrl, receiptsCsv } from "./receipt-tools";
import type { WorkspaceReceipt } from "./api";

const tx = `0x${"a".repeat(64)}`;
const receipt = { chainId: 5042, status: "anchored", anchoredTx: tx };

describe("receipt presentation", () => {
  it("links only confirmed Arc transactions", () => {
    expect(arcTransactionUrl(receipt)).toBe(`https://explorer.arc.io/tx/${tx}`);
    expect(arcTransactionUrl({ ...receipt, chainId: 31337 })).toBeNull();
    expect(arcTransactionUrl({ ...receipt, status: "anchoring" })).toBeNull();
    expect(arcTransactionUrl({ ...receipt, anchoredTx: "sim:fake" })).toBeNull();
  });
  it("exports a stable CSV and neutralizes spreadsheet formulas", () => {
    const csv = receiptsCsv([{ ...receipt, id: "=1+1", createdAt: "2026-09-28", typedHash: tx,
      modelHash: tx, codeHash: tx, inHash: tx, outHash: tx, attRef: tx, verifierAddress: "0xabc",
      ts: "1", sig: "0x12", nonce: null, receiptVersion: 1, agentId: null } as WorkspaceReceipt]);
    expect(csv).toContain('"\'=1+1"');
    expect(csv).toContain('"5042"');
    expect(csv.split("\r\n")).toHaveLength(3);
  });
});
