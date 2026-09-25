import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const walletSessions = pgTable("wallet_login_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  ownerHash: text("owner_hash").notNull(),
  address: text("address").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const WALLET_AUTH_SQL = `
CREATE TABLE IF NOT EXISTS wallet_accounts (
  address text PRIMARY KEY,
  owner_hash text NOT NULL UNIQUE REFERENCES api_keys(key_hash),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wallet_login_challenges (
  id text PRIMARY KEY, address text NOT NULL, message text NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_challenge_address_idx ON wallet_login_challenges(address, created_at);
CREATE INDEX IF NOT EXISTS wallet_challenge_expiry_idx ON wallet_login_challenges(expires_at);
CREATE TABLE IF NOT EXISTS wallet_login_sessions (
  token_hash text PRIMARY KEY, owner_hash text NOT NULL REFERENCES api_keys(key_hash),
  address text NOT NULL REFERENCES wallet_accounts(address), expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_session_expiry_idx ON wallet_login_sessions(expires_at);
CREATE INDEX IF NOT EXISTS wallet_session_address_idx ON wallet_login_sessions(address);
`;
