import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// A committed dispatch claim is never deleted or reopened automatically. It
// survives a crash even if the result/publication transaction was rolled back.
export const inferenceExecutions = pgTable("inference_executions", {
  paymentId: uuid("payment_id").primaryKey(),
  claimId: uuid("claim_id").notNull().defaultRandom(),
  keyHash: text("key_hash").notNull(),
  requestHash: text("request_hash").notNull(),
  idempotencyKey: text("idempotency_key"),
  status: text("status").notNull().default("dispatched"),
  receiptHash: text("receipt_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [uniqueIndex("inference_executions_owner_intent_idx").on(t.keyHash, t.idempotencyKey)]);

export const INFERENCE_EXECUTION_SQL = `
CREATE TABLE IF NOT EXISTS inference_executions (
  payment_id uuid PRIMARY KEY,
  claim_id uuid NOT NULL DEFAULT gen_random_uuid(),
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  idempotency_key text,
  status text NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched', 'completed')),
  receipt_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status = 'dispatched' AND receipt_hash IS NULL AND completed_at IS NULL)
      OR (status = 'completed' AND receipt_hash IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS inference_executions_owner_intent_idx
  ON inference_executions(key_hash, idempotency_key);
`;
