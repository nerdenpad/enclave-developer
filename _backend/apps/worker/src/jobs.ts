import { and, eq, gt, inArray, lt, lte } from "drizzle-orm";
import { payments, receipts, sessions, recoverSignerTransactions, type SignerOptions, type Database } from "@enclave/db";
import type { Queue } from "bullmq";
import { startPolling, type PollingTask } from "./polling.js";
import { reconcileAnchoredReceipts, type ReceiptReconcileOptions } from "./receipt-recovery.js";

export function startSignerRecovery(opts: SignerOptions & { log: { warn: (obj: unknown, msg: string) => void } }): PollingTask {
  return startPolling(async () => {
    try { await recoverSignerTransactions(opts); }
    catch { opts.log.warn({}, "signer_recovery_pending"); }
  }, 15_000);
}

export async function expireSessions(db: Database, now = new Date()): Promise<number> {
  const rows = await db.delete(sessions).where(lte(sessions.expiresAt, now)).returning({ id: sessions.id });
  return rows.length;
}

export function startAttestRefresher(opts: {
  db: Database;
  log: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void };
  intervalMs?: number;
}): PollingTask {
  const intervalMs = opts.intervalMs ?? 30_000;
  async function tick() {
    try {
      const expired = await expireSessions(opts.db);
      opts.log.info({ expired }, "attest_refreshed");
    } catch (err) {
      opts.log.warn({ err }, "attest_refresh_failed");
    }
  }
  return startPolling(tick, intervalMs);
}

export async function reopenStuckSettling(db: Database, olderThanMs = 120_000, now = Date.now()): Promise<number> {
  // Historical name retained for callers; an uncertain transfer must never be reopened automatically.
  const cutoff = new Date(now - olderThanMs);
  const rows = await db
    .update(payments)
    .set({ status: "settlement_unknown" })
    .where(and(eq(payments.status, "settling"), lt(payments.settlingStartedAt, cutoff)))
    .returning({ id: payments.id });
  return rows.length;
}

export function startUsageSettler(opts: {
  db: Database;
  log: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void };
  intervalMs?: number;
}): PollingTask {
  const intervalMs = opts.intervalMs ?? 15_000;
  async function tick() {
    try {
      const uncertain = await reopenStuckSettling(opts.db);
      if (uncertain > 0) {
        opts.log.warn({ uncertain }, "usage_settler_reconciliation_required");
      }
    } catch (err) {
      opts.log.warn({ err }, "usage_settler_failed");
    }
  }
  return startPolling(tick, intervalMs);
}

/** Recover the commit-to-Redis gap without resetting failed jobs' retry budgets. */
export async function recoverReceiptJobs(db: Database, queue: Pick<Queue, "add">): Promise<number> {
  let afterId: string | undefined;
  let recovered = 0;
  while (true) {
    const rows = await db.select({ id: receipts.id, typedHash: receipts.typedHash }).from(receipts)
      .where(and(inArray(receipts.status, ["pending", "anchoring"]), afterId ? gt(receipts.id, afterId) : undefined))
      .orderBy(receipts.id).limit(500);
    for (const row of rows) {
      const job = await queue.add("anchor", { typedHash: row.typedHash }, {
        jobId: row.typedHash,
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
      });
      // A fork can invalidate a previously completed job. Retry that completion once;
      // failed jobs retain their exhausted retry budget for operator review.
      if (await job.getState() === "completed") await job.retry("completed");
    }
    recovered += rows.length;
    if (rows.length < 500) return recovered;
    // Keyset paging prevents old failed jobs from starving newer committed receipts.
    afterId = rows[rows.length - 1]!.id;
  }
}

export function startReceiptRecovery(opts: {
  db: Database;
  queue: Pick<Queue, "add">;
  log: { warn: (obj: unknown, msg: string) => void };
  intervalMs?: number;
  chain?: Omit<ReceiptReconcileOptions, "db" | "log">;
}): PollingTask {
  let afterId: string | undefined;
  return startPolling(async () => {
    if (opts.chain) {
      try {
        const result = await reconcileAnchoredReceipts({ ...opts.chain, db: opts.db, log: opts.log }, afterId);
        afterId = result.afterId;
      } catch { opts.log.warn({}, "receipt_proof_recheck_pending"); }
    }
    try {
      await recoverReceiptJobs(opts.db, opts.queue);
    } catch (err) {
      opts.log.warn({ err }, "receipt_recovery_failed");
    }
  }, opts.intervalMs ?? 30_000);
}
