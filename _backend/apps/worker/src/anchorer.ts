import { isConfiguredAddress } from "@enclave/core";
import { confirmDurableTransaction, receipts, sendDurableTransaction, TransactionRevertedError, type Database, type SignerOptions } from "@enclave/db";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { decodeEventLog, parseAbi, type Hex, type TransactionReceipt } from "viem";
import { z } from "zod";

const anchorJob = z.object({ typedHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value): Hex => `0x${value.slice(2)}`);
const receiptFields = z.object({ modelHash: bytes32, codeHash: bytes32, inHash: bytes32, outHash: bytes32, attRef: bytes32, ts: z.bigint().min(0n).max(2n ** 64n - 1n) });
const verifierAbi = parseAbi([
  "function verifyReceipt((bytes32 modelHash, bytes32 codeHash, bytes32 inHash, bytes32 outHash, bytes32 attRef, bytes32 nonce, uint64 ts) r, bytes sig) returns (bytes32 receiptHash)",
  "function verifyLegacyReceipt((bytes32 modelHash, bytes32 codeHash, bytes32 inHash, bytes32 outHash, bytes32 attRef, uint64 ts) r, bytes sig) returns (bytes32 receiptHash)",
  "event Verified(bytes32 indexed receiptHash, bytes32 modelHash, bytes32 codeHash, bytes32 inHash, bytes32 outHash, bytes32 attRef, address signer)",
]);

export function hasVerifiedReceipt(confirmation: TransactionReceipt, verifier: string, typedHash: string): boolean {
  return confirmation.status === "success" && confirmation.logs.some((event) => {
    if (event.address.toLowerCase() !== verifier.toLowerCase()) return false;
    try {
      return decodeEventLog({ abi: verifierAbi, eventName: "Verified", data: event.data, topics: event.topics }).args.receiptHash.toLowerCase() === typedHash.toLowerCase();
    } catch { return false; }
  });
}

export type AnchorerOpts = {
  db: Database;
  verifier: string | undefined;
  rpcUrl: string;
  chainId?: number;
  confirmations?: number;
  privateKey: Hex;
  log: Pick<Logger, "info" | "warn">;
};

export async function anchorReceipt(opts: AnchorerOpts, data: unknown): Promise<void> {
  const { typedHash } = anchorJob.parse(data);
  const [row] = await opts.db.select().from(receipts).where(eq(receipts.typedHash, typedHash)).limit(1);
  if (!row) { opts.log.warn({ typedHash }, "receipt_missing"); return; }
  if (row.status === "anchored") return;
  if (row.status === "anchor_failed") throw new Error(`Receipt anchoring requires operator review: ${typedHash}`);
  if (!isConfiguredAddress(opts.verifier)) {
    if (row.status === "anchored-sim") return;
    await opts.db.update(receipts).set({ status: "anchored-sim", anchoredTx: `sim:${typedHash.slice(0, 18)}` }).where(eq(receipts.typedHash, typedHash));
    opts.log.info({ typedHash }, "receipt_sim_anchored");
    return;
  }
  const chainId = opts.chainId ?? 31337;
  if (row.chainId != null && row.chainId !== chainId) throw new Error("Receipt signature belongs to a different chain");
  if (row.verifierAddress != null && row.verifierAddress.toLowerCase() !== opts.verifier.toLowerCase()) throw new Error("Receipt signature belongs to a different verifier deployment");
  if (row.receiptVersion !== 1 && row.receiptVersion !== 2) throw new Error("Unsupported receipt version");
  const fields = receiptFields.parse(row);
  const receipt = row.receiptVersion === 2 ? { ...fields, nonce: bytes32.parse(row.nonce) } : fields;
  const sig = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((value): Hex => `0x${value.slice(2)}`).parse(row.sig);
  const signer: SignerOptions = {
    db: opts.db, rpcUrl: opts.rpcUrl, chainId, privateKey: opts.privateKey,
    ...(opts.confirmations === undefined ? {} : { confirmations: opts.confirmations }),
  };
  let tx: Hex;
  let confirmation: Awaited<ReturnType<typeof confirmDurableTransaction>>;
  try {
    if (row.status === "anchoring" && row.anchoredTx?.match(/^0x[0-9a-fA-F]{64}$/)) {
      // REASON: preserve pre-migration submitted hashes; format checked above.
      tx = row.anchoredTx as Hex;
    } else {
      tx = await sendDurableTransaction(signer, `receipt:${typedHash}`, {
        address: opts.verifier, abi: verifierAbi,
        functionName: row.receiptVersion === 2 ? "verifyReceipt" : "verifyLegacyReceipt",
        args: [receipt, sig],
      });
      await opts.db.update(receipts).set({ status: "anchoring", anchoredTx: tx }).where(eq(receipts.typedHash, typedHash));
    }
    confirmation = await confirmDurableTransaction(signer, tx);
  } catch (error) {
    // Durable operations are immutable: a proven revert requires review, never a new signed retry.
    if (error instanceof TransactionRevertedError) {
      await opts.db.update(receipts).set({ status: "anchor_failed", anchoredTx: error.txHash }).where(eq(receipts.typedHash, typedHash));
    }
    throw error;
  }
  const verified = hasVerifiedReceipt(confirmation, opts.verifier, typedHash);
  if (!verified) {
    await opts.db.update(receipts).set({ status: "anchor_failed", anchoredTx: confirmation.transactionHash }).where(eq(receipts.typedHash, typedHash));
    throw new Error(`Transaction did not verify the requested receipt: ${confirmation.transactionHash}`);
  }
  await opts.db.update(receipts).set({ status: "anchored", anchoredTx: confirmation.transactionHash }).where(eq(receipts.typedHash, typedHash));
  opts.log.info({ typedHash, tx: confirmation.transactionHash }, "receipt_anchored");
}
