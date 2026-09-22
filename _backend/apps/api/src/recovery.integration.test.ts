import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { apiKeys, createDb, mandates, payments, TransactionRevertedError } from "@enclave/db";
import { sha256Hex } from "@enclave/core";
import type { Hex } from "viem";
import { EnclaveGateway } from "./gateway.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import * as chain from "./chain.js";
import * as proof from "./settlement-proof.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("Postgres recovery fencing and pagination", () => {
  const config = { ...loadConfig(), PAYMENT_MODE: "mock" as const, USAGE_METER_ADDRESS: "0x0000000000000000000000000000000000000100" };
  const { db, sql } = createDb(config.DATABASE_URL);
  const oldTx = `0x${"ab".repeat(32)}` as Hex;
  const newerTx = `0x${"cd".repeat(32)}` as Hex;
  let gateway: EnclaveGateway;
  let apiKey: string;
  let keyHash: Hex;

  beforeAll(async () => { gateway = await EnclaveGateway.boot(db, config, createLogger("silent"), undefined); });
  beforeEach(async () => {
    apiKey = `recovery-${randomUUID()}`;
    keyHash = sha256Hex(apiKey);
    await db.insert(apiKeys).values({ keyHash, label: "recovery-fencing-test" });
    await db.insert(mandates).values({ agent: keyHash, dailyLimitUnits: 1_000n, dayKey: new Date().toISOString().slice(0, 10) });
    // Only the external chain response is controlled. Claim, fencing, recovery,
    // mandate accounting, and concurrent state changes all use real Postgres.
    vi.spyOn(proof, "settlementScope").mockResolvedValue("isolated-recovery-scope");
    vi.spyOn(proof, "verifySettlementProof").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(payments).where(eq(payments.keyHash, keyHash));
    await db.delete(mandates).where(eq(mandates.agent, keyHash));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, keyHash));
  });
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  for (const newerState of ["settled", "consumed", "settling"] as const) {
    it.each(["success", "timeout", "revert"] as const)(`does not let a late %s overwrite a newer ${newerState} payment`, async (completion) => {
      const paymentId = randomUUID();
      await db.insert(payments).values({ id: paymentId, keyHash, amountUnits: 10n });
      const submitted = deferred<void>();
      const finish = deferred<Hex>();
      const settle = vi.fn<ReturnType<typeof chain.createFacilitator>["settle"]>(() => {
        submitted.resolve();
        return finish.promise;
      });
      vi.spyOn(chain, "createFacilitator").mockReturnValue({ payer: "0x1111111111111111111111111111111111111111", settle });
      const late = gateway.settlePayment(apiKey, paymentId).then((value) => ({ value }), (error: unknown) => ({ error }));
      try {
        await Promise.race([submitted.promise, late.then(() => { throw new Error("Settlement ended before the controlled RPC response"); })]);
        const [claimed] = await db.select().from(payments).where(eq(payments.id, paymentId));
        expect(claimed).toMatchObject({ status: "settling", settlementMode: "mock", chainScope: "isolated-recovery-scope" });
        expect(claimed!.settlingStartedAt).toBeInstanceOf(Date);
        const newerClaim = newerState === "settling" ? new Date(claimed!.settlingStartedAt!.getTime() + 60_000) : null;
        const receiptHash = newerState === "consumed" ? sha256Hex("already consumed") : null;
        await db.update(payments).set({ status: newerState, settleTx: newerTx, receiptHash, settlingStartedAt: newerClaim }).where(eq(payments.id, paymentId));
        const [winner] = await db.select().from(payments).where(eq(payments.id, paymentId));

        const failure = completion === "revert" ? new TransactionRevertedError(oldTx) : new Error("Late RPC timeout");
        if (completion === "success") finish.resolve(oldTx);
        else finish.reject(failure);
        const result = await late;
        if (completion === "success") expect(result).toHaveProperty("value");
        else expect(result).toEqual({ error: failure });

        const [after] = await db.select().from(payments).where(eq(payments.id, paymentId));
        expect(after).toEqual(winner);
        expect((await db.select().from(mandates).where(eq(mandates.agent, keyHash)))[0]?.spentTodayUnits).toBe(10n);
        expect(settle).toHaveBeenCalledOnce();
        if (newerState === "consumed") {
          await expect(gateway.settlePayment(apiKey, paymentId)).rejects.toMatchObject({ statusCode: 409 });
          expect((await db.select().from(payments).where(eq(payments.id, paymentId)))[0]).toEqual(winner);
        }
      } finally {
        finish.reject(new Error("test cleanup"));
        await late;
      }
    });
  }

  it("reaches later recoverable payments beyond two full pages of persistent failures", async () => {
    const prefix = randomUUID().slice(0, 24);
    const ids = Array.from({ length: 202 }, (_, index) => `${prefix}${index.toString(16).padStart(12, "0")}`);
    const recoverable = ids.at(-1)!;
    await db.insert(payments).values(ids.map((id) => ({ id, keyHash, amountUnits: 1n, status: "settlement_unknown", settlementMode: "simulated" })));
    type Settlement = { paymentId: string; tx: string; confidential: boolean };
    const internal = gateway as unknown as { performSettlement(owner: string, paymentId: string, confidential?: boolean): Promise<Settlement> };
    const attempts = vi.spyOn(internal, "performSettlement").mockImplementation(async (owner, paymentId, confidential = false) => {
      if (owner !== keyHash || paymentId !== recoverable) throw new Error("Persistent RPC failure");
      await db.update(payments).set({ status: "settled", settleTx: `sim:${paymentId}` }).where(eq(payments.id, paymentId));
      return { paymentId, tx: `sim:${paymentId}`, confidential };
    });

    expect(await gateway.reconcilePayments()).toBe(1);
    const attemptedIds = attempts.mock.calls.filter(([owner]) => owner === keyHash).map(([, id]) => id);
    expect(attemptedIds).toEqual(ids);
    const rows = await db.select().from(payments).where(eq(payments.keyHash, keyHash));
    expect(rows.filter((row) => row.status === "settlement_unknown")).toHaveLength(201);
    expect(rows.find((row) => row.id === recoverable)).toMatchObject({ status: "settled", settleTx: `sim:${recoverable}` });
  });
});
