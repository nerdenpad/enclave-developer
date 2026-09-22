import { bigint, boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey(), ownerKeyHash: text("owner_key_hash").notNull(), agentId: uuid("agent_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(), requestHash: text("request_hash").notNull(),
  status: text("status").notNull(), step: integer("step").notNull().default(0), maxSteps: integer("max_steps").notNull(),
  maxBudgetUnits: bigint("max_budget_units", { mode: "bigint" }).notNull(), spentUnits: bigint("spent_units", { mode: "bigint" }).notNull().default(0n),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(), sealedState: text("sealed_state").notNull(),
  version: integer("version").notNull().default(0), leaseToken: uuid("lease_token"), leaseUntil: timestamp("lease_until", { withTimezone: true }),
  cancelRequested: boolean("cancel_requested").notNull().default(false), errorCode: text("error_code"),
  paymentId: uuid("payment_id"), receiptHash: text("receipt_hash"), ledgerSequence: integer("ledger_sequence").notNull().default(0),
  ledgerHead: text("ledger_head").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex("agent_runs_owner_idempotency_idx").on(t.ownerKeyHash, t.idempotencyKey), index("agent_runs_claim_idx").on(t.status, t.createdAt), index("agent_runs_owner_id_idx").on(t.ownerKeyHash, t.id)]);

export const agentActions = pgTable("agent_actions", {
  id: uuid("id").primaryKey(), runId: uuid("run_id").notNull().references(() => agentRuns.id),
  sequence: integer("sequence").notNull(), kind: text("kind").notNull(), previousHash: text("previous_hash").notNull(),
  actionHash: text("action_hash").notNull(), sealedPayload: text("sealed_payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex("agent_actions_run_sequence_idx").on(t.runId, t.sequence)]);

export const AGENT_RUNTIME_SQL = `
CREATE TABLE IF NOT EXISTS agent_runs (
 id uuid PRIMARY KEY, owner_key_hash text NOT NULL, agent_id uuid NOT NULL,
 idempotency_key text NOT NULL, request_hash text NOT NULL, status text NOT NULL,
 step integer NOT NULL DEFAULT 0 CHECK (step >= 0), max_steps integer NOT NULL CHECK (max_steps BETWEEN 1 AND 100),
 max_budget_units bigint NOT NULL CHECK (max_budget_units > 0), spent_units bigint NOT NULL DEFAULT 0 CHECK (spent_units >= 0 AND spent_units <= max_budget_units),
 deadline_at timestamptz NOT NULL, sealed_state text NOT NULL, version integer NOT NULL DEFAULT 0,
 lease_token uuid, lease_until timestamptz, cancel_requested boolean NOT NULL DEFAULT false,
 error_code text, payment_id uuid, receipt_hash text, ledger_sequence integer NOT NULL DEFAULT 0,
 ledger_head text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_owner_idempotency_idx ON agent_runs(owner_key_hash,idempotency_key);
CREATE INDEX IF NOT EXISTS agent_runs_claim_idx ON agent_runs(status,created_at);
CREATE INDEX IF NOT EXISTS agent_runs_owner_id_idx ON agent_runs(owner_key_hash,id);
CREATE TABLE IF NOT EXISTS agent_actions (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES agent_runs(id), sequence integer NOT NULL,
 kind text NOT NULL, previous_hash text NOT NULL, action_hash text NOT NULL,
 sealed_payload text NOT NULL, created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_actions_run_sequence_idx ON agent_actions(run_id,sequence);
`;
