import postgres from "postgres";
import { config as loadDotenv } from "dotenv";
import { AGENT_RUNTIME_SQL } from "./agent-runtime-schema.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url) });
loadDotenv();

const SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_hash text NOT NULL,
  code_hash text NOT NULL,
  version text NOT NULL,
  provider text NOT NULL,
  approved boolean NOT NULL DEFAULT false,
  revoked boolean NOT NULL DEFAULT false,
  listing_bps integer NOT NULL DEFAULT 0,
  listing_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS models_hashes_idx ON models (model_hash, code_hash);

CREATE TABLE IF NOT EXISTS receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_hash text NOT NULL,
  code_hash text NOT NULL,
  in_hash text NOT NULL,
  out_hash text NOT NULL,
  att_ref text NOT NULL,
  ts bigint NOT NULL,
  sig text NOT NULL,
  typed_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  anchored_tx text,
  key_hash text,
  agent_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS receipts_typed_hash_idx ON receipts (typed_hash);

CREATE TABLE IF NOT EXISTS tcb_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE,
  serving_image_id text NOT NULL,
  measurement text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash text NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  usdc_units bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS usage_key_hash_idx ON usage (key_hash);

CREATE TABLE IF NOT EXISTS mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL UNIQUE,
  daily_limit_units bigint NOT NULL,
  spent_today_units bigint NOT NULL DEFAULT 0,
  day_key text NOT NULL,
  lane text NOT NULL DEFAULT 'prefunded',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  usdc_balance bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_hash text NOT NULL,
  att_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash text NOT NULL,
  amount_units bigint NOT NULL,
  status text NOT NULL DEFAULT 'open',
  settle_tx text,
  receipt_hash text,
  intent_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS intent_key text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS settling_started_at timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS confidential boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS payments_owner_intent_idx ON payments (key_hash, intent_key);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash text NOT NULL,
  idempotency_key text NOT NULL,
  typed_hash text NOT NULL,
  response_json text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_owner_key_idx ON idempotency_keys (key_hash, idempotency_key);

CREATE TABLE IF NOT EXISTS chain_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  payload text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS index_cursors (
  name text PRIMARY KEY,
  block_number bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE models ADD COLUMN IF NOT EXISTS listing_bps integer NOT NULL DEFAULT 0;
ALTER TABLE models ADD COLUMN IF NOT EXISTS listing_id integer;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS key_hash text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS agent_id text;

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key_hash text NOT NULL,
  name text NOT NULL,
  policy_json text NOT NULL,
  policy_hash text NOT NULL,
  sealed_memory text NOT NULL,
  memory_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS view_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key_hash text NOT NULL,
  secret_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buybacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_units bigint NOT NULL,
  tx_hash text,
  distribute_tx text,
  status text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

const UPGRADES = `
ALTER TABLE models ADD COLUMN IF NOT EXISTS chain_scope text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS receipt_version integer NOT NULL DEFAULT 1;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS nonce text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS quote_json text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS listing_id integer;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS authorization_json text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS settlement_mode text;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE chain_events ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'legacy';
ALTER TABLE chain_events ADD COLUMN IF NOT EXISTS block_hash text;
DROP INDEX IF EXISTS chain_events_tx_log_idx;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS chain_id integer;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS verifier_address text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS output_json text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS provider_proof_json text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS mandate_day_key text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS chain_scope text;
CREATE UNIQUE INDEX IF NOT EXISTS chain_events_scope_tx_log_idx ON chain_events(scope, tx_hash, log_index);
ALTER TABLE index_cursors ADD COLUMN IF NOT EXISTS block_hash text;
ALTER TABLE index_cursors ADD COLUMN IF NOT EXISTS checkpoints text NOT NULL DEFAULT '[]';
ALTER TABLE index_cursors ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
CREATE TABLE IF NOT EXISTS chain_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text NOT NULL, operation_key text NOT NULL,
  request_hash text NOT NULL, signer text NOT NULL, nonce bigint NOT NULL, raw_transaction text NOT NULL,
  tx_hash text NOT NULL, status text NOT NULL DEFAULT 'prepared', error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tcb_policy ADD COLUMN IF NOT EXISTS policy_hash text;
ALTER TABLE tcb_policy ADD COLUMN IF NOT EXISTS policy_json text;
ALTER TABLE tcb_policy ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE tcb_policy ADD COLUMN IF NOT EXISTS proposal_key text;
ALTER TABLE tcb_policy ADD COLUMN IF NOT EXISTS activation_key text;
ALTER TABLE tcb_policy ADD COLUMN IF NOT EXISTS activation_request_hash text;
ALTER TABLE tcb_policy ADD COLUMN IF NOT EXISTS activation_mode text;
ALTER TABLE tcb_policy ADD COLUMN IF NOT EXISTS activation_scope text;
ALTER TABLE tcb_policy ADD COLUMN IF NOT EXISTS activated_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS tcb_policy_proposal_key_idx ON tcb_policy (proposal_key);
CREATE UNIQUE INDEX IF NOT EXISTS tcb_policy_activation_key_idx ON tcb_policy (activation_key);
CREATE UNIQUE INDEX IF NOT EXISTS tcb_policy_single_active_idx ON tcb_policy (status) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS chain_transactions_operation_idx ON chain_transactions(scope, operation_key);
ALTER TABLE chain_transactions ADD COLUMN IF NOT EXISTS confirmed_block_number bigint;
ALTER TABLE chain_transactions ADD COLUMN IF NOT EXISTS confirmed_block_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS chain_transactions_nonce_idx ON chain_transactions(scope, signer, nonce);
CREATE INDEX IF NOT EXISTS chain_transactions_pending_idx ON chain_transactions(scope, status);
CREATE INDEX IF NOT EXISTS payments_reconcile_idx ON payments(status, settling_started_at);
`;

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required");
}

const sql = postgres(url, { max: 1, onnotice: () => undefined });
await sql.begin(async (tx) => {
  await tx`select pg_advisory_xact_lock(hashtext('enclave:schema-migration'))`;
  await tx.unsafe(SQL);
  await tx.unsafe(UPGRADES);
  await tx.unsafe(AGENT_RUNTIME_SQL);
});
await sql.end();
console.log("migrated");
