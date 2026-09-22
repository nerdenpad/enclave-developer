import { and, eq, gt, isNull } from "drizzle-orm";
import { chainTransactions, receipts, type Database } from "@enclave/db";
import { isConfiguredAddress } from "@enclave/core";
import { BlockNotFoundError, TransactionReceiptNotFoundError, createPublicClient, http, type Hex } from "viem";
import { foundry } from "viem/chains";
import { hasVerifiedReceipt } from "./anchorer.js";

export type ReceiptReconcileOptions = {
  db: Database; rpcUrl: string; chainId: number; verifier: string | undefined; confirmations?: number;
  log: { warn: (obj: unknown, msg: string) => void };
};

/** One bounded page per tick. The caller retains the keyset cursor across ticks. */
export async function reconcileAnchoredReceipts(opts: ReceiptReconcileOptions, afterId?: string): Promise<{ afterId: string | undefined; checked: number; changed: number }> {
  if (!isConfiguredAddress(opts.verifier)) return { afterId: undefined, checked: 0, changed: 0 };
  const verifier = opts.verifier;
  const depth = opts.confirmations ?? ([31337, 1337].includes(opts.chainId) ? 0 : 12);
  if (!Number.isSafeInteger(depth) || depth < 0) throw new RangeError("Invalid receipt confirmation depth");
  const rpc = createPublicClient({ chain: { ...foundry, id: opts.chainId }, cacheTime: 0, transport: http(opts.rpcUrl, { timeout: 10_000, retryCount: 0 }) });
  if (await rpc.getChainId() !== opts.chainId) throw new Error("Receipt recovery RPC chain mismatch");
  const genesis = await rpc.getBlock({ blockNumber: 0n });
  if (!genesis.hash) throw new Error("Receipt recovery requires canonical genesis");
  const scope = `${opts.chainId}:${genesis.hash}`;
  const head = await rpc.getBlockNumber({ cacheTime: 0 });
  const rows = await opts.db.select().from(receipts).where(and(eq(receipts.status, "anchored"), afterId ? gt(receipts.id, afterId) : undefined)).orderBy(receipts.id).limit(100);
  let changed = 0;
  for (const row of rows) {
    // Historical signatures without a stored domain, and archived deployments, need explicit review.
    if (row.chainId !== opts.chainId || row.verifierAddress?.toLowerCase() !== verifier.toLowerCase()) continue;
    let status: "anchoring" | "anchor_failed" | undefined;
    try {
      if (!row.anchoredTx || !/^0x[0-9a-fA-F]{64}$/.test(row.anchoredTx)) status = "anchor_failed";
      else {
        const hash = row.anchoredTx as Hex;
        const [journal] = await opts.db.select().from(chainTransactions).where(and(eq(chainTransactions.scope, scope), eq(chainTransactions.operationKey, `receipt:${row.typedHash}`))).limit(1);
        if (journal && journal.txHash.toLowerCase() !== hash.toLowerCase()) status = "anchor_failed";
        else {
          const proof = await rpc.getTransactionReceipt({ hash });
          if (proof.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error("Receipt RPC returned a foreign transaction");
          const block = await rpc.getBlock({ blockNumber: proof.blockNumber });
          if (block.hash !== proof.blockHash || head < proof.blockNumber + BigInt(depth)) status = "anchoring";
          else if (!hasVerifiedReceipt(proof, verifier, row.typedHash)) status = "anchor_failed";
        }
      }
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError || error instanceof BlockNotFoundError) status = "anchoring";
      else { opts.log.warn({ typedHash: row.typedHash }, "receipt_proof_recheck_pending"); continue; }
    }
    if (status) {
      // A different instance may have already repaired this row while RPC requests were in flight.
      const updated = await opts.db.update(receipts).set({ status }).where(and(eq(receipts.id, row.id), eq(receipts.status, "anchored"), row.anchoredTx === null ? isNull(receipts.anchoredTx) : eq(receipts.anchoredTx, row.anchoredTx))).returning({ id: receipts.id });
      changed += updated.length;
    }
  }
  return { afterId: rows.length === 100 ? rows[rows.length - 1]!.id : undefined, checked: rows.length, changed };
}
