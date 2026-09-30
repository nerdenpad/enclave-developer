import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError, DevCvm, sha256Hex } from "@enclave/core";
import type { Database } from "@enclave/db";
import { privateKeyToAccount } from "viem/accounts";
import { EnclaveGateway } from "./gateway.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import * as chain from "./chain.js";
import * as settlementProof from "./settlement-proof.js";
import * as authorization from "./authorization.js";

const owner = sha256Hex("payment-owner"), payer = privateKeyToAccount(`0x${"51".repeat(32)}`).address;
const paymentId = "10000000-0000-4000-8000-000000000001";
const txHash = sha256Hex("durable settlement");
const auth = { from: payer, validAfter: "0", validBefore: "9999999999", signature: `0x${"11".repeat(65)}` as const };
type Internal = { requireKey(key: string): Promise<string>; assertNewPaymentAdmission(): Promise<void>; assertMandateTx(...args: unknown[]): Promise<void> };
function setup(status = "open") {
  const row = { id: paymentId, keyHash: owner, amountUnits: 100_000n, status, settlementMode: status === "open" ? null : "authorized",
    chainScope: "unit-scope", authorizationJson: status === "open" ? null : JSON.stringify(auth), agentId: null, listingId: null,
    confidential: false, mandateDayKey: "2026-09-30", settleTx: status === "settled" ? txHash : null, settlingStartedAt: null };
  const query = { from: vi.fn(), where: vi.fn(), for: vi.fn(), limit: vi.fn().mockResolvedValue([row]) };
  query.from.mockReturnValue(query); query.where.mockReturnValue(query); query.for.mockReturnValue(query);
  const update = vi.fn().mockImplementation(() => ({ set: (values: Record<string, unknown>) => ({ where: () => {
    const result = Promise.resolve(undefined) as Promise<undefined> & { returning(): Promise<unknown[]> };
    result.returning = async () => [{ ...row, ...values }]; return result;
  } }) }));
  const db = { select: vi.fn().mockReturnValue(query), update,
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)) };
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://unit.invalid/test", PAYMENT_MODE: "authorized",
    USDC_ADDRESS: `0x${"31".repeat(20)}`, USAGE_METER_ADDRESS: `0x${"32".repeat(20)}` });
  const gateway = new EnclaveGateway(db as unknown as Database, {} as DevCvm, config, createLogger("silent"), undefined);
  const internal = gateway as unknown as Internal;
  vi.spyOn(internal, "requireKey").mockResolvedValue(owner);
  const admission = vi.spyOn(internal, "assertNewPaymentAdmission").mockRejectedValue(new ConflictError("Provider attestation rejected"));
  const mandate = vi.spyOn(internal, "assertMandateTx").mockResolvedValue();
  const settle = vi.fn().mockResolvedValue(txHash);
  vi.spyOn(chain, "createFacilitator").mockReturnValue({ payer, settle });
  vi.spyOn(settlementProof, "settlementScope").mockResolvedValue("unit-scope");
  vi.spyOn(settlementProof, "verifySettlementProof").mockResolvedValue();
  vi.spyOn(authorization, "validateAuthorization").mockResolvedValue();
  return { gateway, row, admission, mandate, settle, update };
}
afterEach(() => vi.restoreAllMocks());
describe("new payment admission and durable recovery", () => {
  it("does not offer a payer authorization after provider admission fails", async () => {
    const fixture = setup();
    await expect(fixture.gateway.paymentAuthorization("owner-key", paymentId, payer)).rejects.toThrow("Provider attestation rejected");
    expect(fixture.admission).toHaveBeenCalledOnce(); expect(fixture.update).not.toHaveBeenCalled(); expect(fixture.settle).not.toHaveBeenCalled();
  });
  it("rejects a new signed payment before reserving funds or submitting a transaction", async () => {
    const fixture = setup();
    await expect(fixture.gateway.settlePayment("owner-key", paymentId, false, auth)).rejects.toThrow("Provider attestation rejected");
    expect(fixture.row.status).toBe("open"); expect(fixture.mandate).not.toHaveBeenCalled();
    expect(fixture.update).not.toHaveBeenCalled(); expect(fixture.settle).not.toHaveBeenCalled();
  });
  it("can reconcile an already admitted uncertain payment while new admissions are blocked", async () => {
    const fixture = setup("settlement_unknown");
    await expect(fixture.gateway.settlePayment("owner-key", paymentId, false, auth)).resolves.toMatchObject({ tx: txHash });
    expect(fixture.admission).not.toHaveBeenCalled(); expect(fixture.mandate).not.toHaveBeenCalled(); expect(fixture.settle).toHaveBeenCalledOnce();
  });
  it("returns a previously settled payment without a new attestation or execution", async () => {
    const fixture = setup("settled");
    await expect(fixture.gateway.settlePayment("owner-key", paymentId, false, auth)).resolves.toMatchObject({ tx: txHash });
    expect(fixture.admission).not.toHaveBeenCalled(); expect(fixture.settle).not.toHaveBeenCalled(); expect(fixture.update).not.toHaveBeenCalled();
  });
});
