import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payments, sessions } from "@enclave/db";
import { expireSessions, recoverReceiptJobs, reopenStuckSettling, startAttestRefresher, startReceiptRecovery, startSignerRecovery, startUsageSettler } from "./jobs.js";
import { sqlQuery, testDb } from "./test-db.js";

const signerRecovery = vi.hoisted(() => vi.fn());
const anchoredRecovery = vi.hoisted(() => vi.fn());
vi.mock("@enclave/db", async (original) => ({ ...await original<typeof import("@enclave/db")>(), recoverSignerTransactions: signerRecovery }));
vi.mock("./receipt-recovery.js", () => ({ reconcileAnchoredReceipts: anchoredRecovery }));
beforeEach(() => { signerRecovery.mockReset().mockResolvedValue(0); anchoredRecovery.mockReset().mockResolvedValue({ afterId: undefined, checked: 0, changed: 0 }); });

afterEach(() => { vi.useRealTimers(); });

describe("maintenance jobs", () => {
  it("recovers durable signer operations immediately and stays quiet on success", async () => {
    const mock = testDb();
    const log = { warn: vi.fn() };
    const opts = { db: mock.db, rpcUrl: "http://rpc.test", chainId: 31337, privateKey: `0x${"11".repeat(32)}` as const, log };
    await startSignerRecovery(opts).stop();
    expect(signerRecovery).toHaveBeenCalledExactlyOnceWith(opts);
    expect(log.warn).not.toHaveBeenCalled();
  });
  it("keeps signer recovery retryable after a transport failure and drains on stop", async () => {
    vi.useFakeTimers();
    signerRecovery.mockRejectedValueOnce(new Error("transport unavailable"));
    const mock = testDb();
    const log = { warn: vi.fn() };
    const task = startSignerRecovery({ db: mock.db, rpcUrl: "http://rpc.test", chainId: 31337, privateKey: `0x${"11".repeat(32)}`, log });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith({}, "signer_recovery_pending");
    expect(signerRecovery).toHaveBeenCalledTimes(2);
    await task.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signerRecovery).toHaveBeenCalledTimes(2);
  });
  it("expires sessions at the exact expiry boundary and reports deleted rows", async () => {
    const mock = testDb();
    const now = new Date("2026-09-16T12:00:00Z");
    mock.returning.mockResolvedValue([{ id: "one" }, { id: "two" }]);
    expect(await expireSessions(mock.db, now)).toBe(2);
    expect(mock.delete).toHaveBeenCalledWith(sessions);
    const query = sqlQuery(mock.writeWhere.mock.calls[0]![0]);
    expect(query.sql).toContain('"sessions"."expires_at" <= $1');
    expect(query.params).toEqual([now.toISOString()]);
  });
  it("quarantines only stale claims instead of making uncertain payments spendable again", async () => {
    const mock = testDb();
    const now = Date.parse("2026-09-16T12:00:00Z");
    mock.returning.mockResolvedValue([{ id: "one" }]);
    expect(await reopenStuckSettling(mock.db, 120_000, now)).toBe(1);
    expect(mock.update).toHaveBeenCalledWith(payments);
    expect(mock.set).toHaveBeenCalledWith({ status: "settlement_unknown" });
    const query = sqlQuery(mock.writeWhere.mock.calls[0]![0]);
    expect(query.sql).toContain('"payments"."status" = $1');
    expect(query.sql).toContain('"payments"."settling_started_at" < $2');
    expect(query.params).toEqual(["settling", new Date(now - 120_000).toISOString()]);
  });
  it("recovers missing queue jobs with deterministic job ids and bounded retries", async () => {
    const mock = testDb();
    mock.rows.mockResolvedValue([{ typedHash: "0xabc" }, { typedHash: "0xdef" }]);
    const add = vi.fn().mockResolvedValue({ getState: vi.fn().mockResolvedValue("waiting") });
    expect(await recoverReceiptJobs(mock.db, { add })).toBe(2);
    expect(add).toHaveBeenCalledWith("anchor", { typedHash: "0xabc" }, { jobId: "0xabc", attempts: 5, backoff: { type: "exponential", delay: 1000 } });
    expect(sqlQuery(mock.query.where.mock.calls[0]![0]).params).toEqual(["pending", "anchoring"]);
    expect(mock.rows).toHaveBeenCalledWith(500);
  });
  it("leaves recovery retryable after a Redis failure", async () => {
    const mock = testDb();
    mock.rows.mockResolvedValue([{ typedHash: "0xabc" }]);
    await expect(recoverReceiptJobs(mock.db, { add: vi.fn().mockRejectedValue(new Error("redis offline")) })).rejects.toThrow("redis offline");
    expect(mock.update).not.toHaveBeenCalled();
  });
  it("retries retained completed jobs after a fork but leaves failed retry budgets untouched", async () => {
    const mock = testDb();
    mock.rows.mockResolvedValue([{ typedHash: "completed" }, { typedHash: "failed" }]);
    const completeRetry = vi.fn(); const failedRetry = vi.fn();
    const add = vi.fn().mockResolvedValueOnce({ getState: vi.fn().mockResolvedValue("completed"), retry: completeRetry })
      .mockResolvedValueOnce({ getState: vi.fn().mockResolvedValue("failed"), retry: failedRetry });
    await recoverReceiptJobs(mock.db, { add });
    expect(completeRetry).toHaveBeenCalledExactlyOnceWith("completed");
    expect(failedRetry).not.toHaveBeenCalled();
  });
  it("retains its anchored receipt keyset across periodic ticks and resets after the final page", async () => {
    vi.useFakeTimers();
    const mock = testDb(); const log = { warn: vi.fn() };
    anchoredRecovery.mockResolvedValueOnce({ afterId: "page-one", checked: 100, changed: 0 });
    const chain = { chainId: 31337, rpcUrl: "http://rpc.test", verifier: "0x000000000000000000000000000000000000abcd" };
    const task = startReceiptRecovery({ db: mock.db, queue: { add: vi.fn() }, log, chain, intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(20);
    await task.stop();
    expect(anchoredRecovery.mock.calls.map((call) => call[1])).toEqual([undefined, "page-one", undefined]);
    expect(anchoredRecovery).toHaveBeenCalledWith({ ...chain, db: mock.db, log }, "page-one");
  });
  it("continues outbox recovery even if chain proof RPC is unavailable", async () => {
    const mock = testDb(); const log = { warn: vi.fn() };
    mock.rows.mockResolvedValue([{ typedHash: "pending" }]);
    const add = vi.fn().mockResolvedValue({ getState: vi.fn().mockResolvedValue("waiting") });
    anchoredRecovery.mockRejectedValue(new Error("RPC unavailable"));
    await startReceiptRecovery({ db: mock.db, queue: { add }, log, chain: { chainId: 31337, rpcUrl: "http://rpc.test", verifier: undefined } }).stop();
    expect(add).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith({}, "receipt_proof_recheck_pending");
  });
  it("pages beyond retained failed jobs so newer pending receipts cannot starve", async () => {
    const mock = testDb();
    mock.rows.mockResolvedValueOnce(Array.from({ length: 500 }, (_, id) => ({ id: String(id), typedHash: `hash-${id}` })))
      .mockResolvedValueOnce([{ id: "500", typedHash: "last-hash" }]);
    const add = vi.fn().mockResolvedValue({ getState: vi.fn().mockResolvedValue("waiting") });
    expect(await recoverReceiptJobs(mock.db, { add })).toBe(501);
    expect(add).toHaveBeenLastCalledWith("anchor", { typedHash: "last-hash" }, expect.objectContaining({ jobId: "last-hash" }));
    expect(sqlQuery(mock.query.where.mock.calls[1]![0]).params).toEqual(["pending", "anchoring", "499"]);
  });
  it.each(["attestation", "settler", "recovery"] as const)("%s runs immediately, logs failures, and can be stopped", async (kind) => {
    vi.useFakeTimers();
    const mock = testDb();
    const error = new Error("offline");
    mock.returning.mockRejectedValue(error);
    mock.rows.mockRejectedValue(error);
    const log = { info: vi.fn(), warn: vi.fn() };
    const task = kind === "attestation" ? startAttestRefresher({ db: mock.db, log, intervalMs: 10 })
      : kind === "settler" ? startUsageSettler({ db: mock.db, log, intervalMs: 10 })
      : startReceiptRecovery({ db: mock.db, log, queue: { add: vi.fn() }, intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(log.warn).toHaveBeenCalledTimes(2);
    await task.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
  it("reports uncertain payments for reconciliation", async () => {
    const mock = testDb();
    mock.returning.mockResolvedValue([{ id: "one" }]);
    const log = { info: vi.fn(), warn: vi.fn() };
    const task = startUsageSettler({ db: mock.db, log });
    await task.stop();
    expect(log.warn).toHaveBeenCalledWith({ uncertain: 1 }, "usage_settler_reconciliation_required");
  });
  it("logs successful session cleanup and remains quiet with no stale claims", async () => {
    const mock = testDb();
    const log = { info: vi.fn(), warn: vi.fn() };
    await startAttestRefresher({ db: mock.db, log }).stop();
    await startUsageSettler({ db: mock.db, log }).stop();
    expect(log.info).toHaveBeenCalledExactlyOnceWith({ expired: 0 }, "attest_refreshed");
    expect(log.warn).not.toHaveBeenCalled();
  });
});
