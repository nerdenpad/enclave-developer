import { and, eq, or } from "drizzle-orm";
import { AppError, ConflictError } from "@enclave/core";
import { inferenceExecutions, type Database } from "@enclave/db";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type InferenceExecutionBinding = {
  paymentId: string;
  keyHash: string;
  requestHash: string;
  idempotencyKey?: string | undefined;
};

export function uncertainInference(paymentId: string): AppError {
  return new AppError("INFERENCE_EXECUTION_UNCERTAIN",
    "Execution may have been dispatched. This payment is quarantined; do not submit another payment for this request.",
    409, { paymentId });
}

/** Caller holds the payment and owner/idempotency locks. This insert must commit
 * in its own transaction before the provider is invoked. */
export async function claimInferenceExecution(tx: Tx, binding: InferenceExecutionBinding): Promise<string> {
  const [claimed] = await tx.insert(inferenceExecutions).values({ ...binding, idempotencyKey: binding.idempotencyKey ?? null })
    .onConflictDoNothing().returning({ claimId: inferenceExecutions.claimId });
  if (claimed) return claimed.claimId;
  const [existing] = await tx.select().from(inferenceExecutions).where(or(
    eq(inferenceExecutions.paymentId, binding.paymentId),
    binding.idempotencyKey ? and(eq(inferenceExecutions.keyHash, binding.keyHash),
      eq(inferenceExecutions.idempotencyKey, binding.idempotencyKey)) : undefined,
  )).limit(1);
  if (!existing) throw new ConflictError("Inference dispatch claim could not be confirmed");
  if (existing.keyHash !== binding.keyHash || existing.requestHash !== binding.requestHash
    || existing.paymentId !== binding.paymentId || existing.idempotencyKey !== (binding.idempotencyKey ?? null)) {
    throw new ConflictError("Inference dispatch is bound to a different request");
  }
  throw uncertainInference(binding.paymentId);
}

/** Completion belongs in the same atomic transaction as the receipt, payment
 * consumption and cached response. A failed commit leaves the dispatch claim. */
export async function completeInferenceExecution(tx: Tx, binding: InferenceExecutionBinding, claimId: string, receiptHash: string): Promise<void> {
  const rows = await tx.update(inferenceExecutions).set({ status: "completed", receiptHash, completedAt: new Date() })
    .where(and(eq(inferenceExecutions.paymentId, binding.paymentId), eq(inferenceExecutions.claimId, claimId),
      eq(inferenceExecutions.keyHash, binding.keyHash), eq(inferenceExecutions.requestHash, binding.requestHash),
      eq(inferenceExecutions.status, "dispatched"))).returning({ paymentId: inferenceExecutions.paymentId });
  if (rows.length !== 1) throw uncertainInference(binding.paymentId);
}

/** Never translate a committed external attempt into permission to execute it
 * again, including failures before publication or a lost commit acknowledgement. */
export async function runClaimedInference<T>(paymentId: string, execute: () => Promise<T>): Promise<T> {
  try { return await execute(); }
  catch { throw uncertainInference(paymentId); }
}
