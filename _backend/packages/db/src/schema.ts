import {
  boolean,
  bigint,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentRuns, agentActions } from "./agent-runtime-schema.js";

export const models = pgTable("models", {
  id: uuid("id").primaryKey().defaultRandom(),
  modelHash: text("model_hash").notNull(),
  codeHash: text("code_hash").notNull(),
  version: text("version").notNull(),
  provider: text("provider").notNull(),
  approved: boolean("approved").notNull().default(false),
  revoked: boolean("revoked").notNull().default(false),
  listingBps: integer("listing_bps").notNull().default(0),
  listingId: integer("listing_id"),
  chainScope: text("chain_scope"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("models_hashes_idx").on(t.modelHash, t.codeHash)]);

export const receipts = pgTable("receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  modelHash: text("model_hash").notNull(),
  codeHash: text("code_hash").notNull(),
  inHash: text("in_hash").notNull(),
  outHash: text("out_hash").notNull(),
  attRef: text("att_ref").notNull(),
  receiptVersion: integer("receipt_version").notNull().default(1),
  nonce: text("nonce"),
  chainId: integer("chain_id"),
  verifierAddress: text("verifier_address"),
  outputJson: text("output_json"),
  providerProofJson: text("provider_proof_json"),
  ts: bigint("ts", { mode: "bigint" }).notNull(),
  sig: text("sig").notNull(),
  typedHash: text("typed_hash").notNull(),
  status: text("status").notNull().default("pending"),
  anchoredTx: text("anchored_tx"),
  keyHash: text("key_hash"),
  agentId: text("agent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("receipts_typed_hash_idx").on(t.typedHash)]);

export const tcbPolicy = pgTable("tcb_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: integer("version").notNull().unique(),
  servingImageId: text("serving_image_id").notNull(),
  measurement: text("measurement").notNull(),
  policyHash: text("policy_hash"),
  policyJson: text("policy_json"),
  status: text("status").notNull().default("pending"),
  proposalKey: text("proposal_key").unique(),
  activationKey: text("activation_key").unique(),
  activationRequestHash: text("activation_request_hash"),
  activationMode: text("activation_mode"),
  activationScope: text("activation_scope"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usage = pgTable("usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  keyHash: text("key_hash").notNull(),
  calls: integer("calls").notNull().default(0),
  usdcUnits: bigint("usdc_units", { mode: "bigint" }).notNull().default(0n),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("usage_key_hash_idx").on(t.keyHash)]);

export const mandates = pgTable("mandates", {
  id: uuid("id").primaryKey().defaultRandom(),
  agent: text("agent").notNull().unique(),
  dailyLimitUnits: bigint("daily_limit_units", { mode: "bigint" }).notNull(),
  spentTodayUnits: bigint("spent_today_units", { mode: "bigint" }).notNull().default(0n),
  dayKey: text("day_key").notNull(),
  lane: text("lane").notNull().default("prefunded"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  keyHash: text("key_hash").notNull().unique(),
  label: text("label").notNull(),
  role: text("role").notNull().default("user"),
  usdcBalance: bigint("usdc_balance", { mode: "bigint" }).notNull().default(0n),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  apiKeyHash: text("api_key_hash").notNull(),
  attRef: text("att_ref").notNull(),
  quoteJson: text("quote_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  keyHash: text("key_hash").notNull(),
  amountUnits: bigint("amount_units", { mode: "bigint" }).notNull(),
  status: text("status").notNull().default("open"),
  settleTx: text("settle_tx"),
  settlingStartedAt: timestamp("settling_started_at", { withTimezone: true }),
  receiptHash: text("receipt_hash"),
  intentKey: text("intent_key"),
  requestHash: text("request_hash"),
  agentId: text("agent_id"),
  listingId: integer("listing_id"),
  authorizationJson: text("authorization_json"),
  settlementMode: text("settlement_mode"),
  mandateDayKey: text("mandate_day_key"),
  chainScope: text("chain_scope"),
  confidential: boolean("confidential").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("payments_owner_intent_idx").on(t.keyHash, t.intentKey)]);

export const idempotencyKeys = pgTable("idempotency_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  keyHash: text("key_hash").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  typedHash: text("typed_hash").notNull(),
  responseJson: text("response_json").notNull(),
  requestHash: text("request_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("idempotency_owner_key_idx").on(t.keyHash, t.idempotencyKey)]);

export const chainEvents = pgTable("chain_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(),
  scope: text("scope").notNull().default("legacy"),
  blockHash: text("block_hash"),
  txHash: text("tx_hash").notNull(),
  logIndex: integer("log_index").notNull(),
  blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
  payload: text("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("chain_events_scope_tx_log_idx").on(t.scope, t.txHash, t.logIndex)]);

export const indexCursors = pgTable("index_cursors", {
  name: text("name").primaryKey(),
  blockNumber: bigint("block_number", { mode: "bigint" }).notNull().default(0n),
  blockHash: text("block_hash"),
  checkpoints: text("checkpoints").notNull().default("[]"),
  status: text("status").notNull().default("active"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerKeyHash: text("owner_key_hash").notNull(),
  name: text("name").notNull(),
  policyJson: text("policy_json").notNull(),
  policyHash: text("policy_hash").notNull(),
  sealedMemory: text("sealed_memory").notNull(),
  memoryHash: text("memory_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const viewKeys = pgTable("view_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerKeyHash: text("owner_key_hash").notNull(),
  secretHash: text("secret_hash").notNull().unique(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const buybacks = pgTable("buybacks", {
  id: uuid("id").primaryKey().defaultRandom(),
  amountUnits: bigint("amount_units", { mode: "bigint" }).notNull(),
  txHash: text("tx_hash"),
  distributeTx: text("distribute_tx"),
  status: text("status").notNull().default("queued"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Signed bytes are committed before broadcast. They authorize only this exact transaction.
export const chainTransactions = pgTable("chain_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  scope: text("scope").notNull(),
  operationKey: text("operation_key").notNull(),
  requestHash: text("request_hash").notNull(),
  signer: text("signer").notNull(),
  nonce: bigint("nonce", { mode: "bigint" }).notNull(),
  rawTransaction: text("raw_transaction").notNull(),
  confirmedBlockNumber: bigint("confirmed_block_number", { mode: "bigint" }),
  confirmedBlockHash: text("confirmed_block_hash"),
  txHash: text("tx_hash").notNull(),
  status: text("status").notNull().default("prepared"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("chain_transactions_operation_idx").on(t.scope, t.operationKey),
  uniqueIndex("chain_transactions_nonce_idx").on(t.scope, t.signer, t.nonce),
]);

export const schema = {
  models,
  receipts,
  tcbPolicy,
  usage,
  mandates,
  apiKeys,
  sessions,
  payments,
  idempotencyKeys,
  chainEvents,
  indexCursors,
  agents,
  viewKeys,
  buybacks,
  chainTransactions,
  agentRuns,
  agentActions,
};
