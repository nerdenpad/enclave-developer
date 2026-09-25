import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { privateKeyToAccount } from "viem/accounts";
import { WALLET_AUTH_SQL, createDb } from "@enclave/db";
import { sha256Hex } from "@enclave/core";
import { PostgresWalletLoginStore, WalletLogin } from "../apps/api/src/wallet-auth.js";

// Only a unique isolated schema is touched; no application rows or chain transactions.
const url = process.env.DATABASE_URL;
if (!url) throw Error("DATABASE_URL is required for isolated wallet login integration tests");
const schema = `wallet_login_test_${randomBytes(8).toString("hex")}`;
const admin = postgres(url, { max: 1, onnotice: () => {} });
let testSql: ReturnType<typeof createDb>["sql"] | undefined;
try {
  await admin`create schema ${admin(schema)}`;
  testSql = postgres(url, { max: 4, connection: { search_path: schema }, onnotice: () => {} });
  // createDb also initializes Drizzle, which replaces postgres-js date serializers.
  drizzle(testSql);
  await testSql.unsafe("CREATE TABLE api_keys (key_hash text PRIMARY KEY,label text NOT NULL,role text NOT NULL,usdc_balance bigint NOT NULL)");
  await testSql.unsafe(WALLET_AUTH_SQL);
  const login = new WalletLogin("https://enclaveagent.tech", new PostgresWalletLoginStore(testSql));
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`), other = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const c = await login.challenge(account.address), signature = await account.signMessage({ message: c.message });
  const race = await Promise.allSettled([login.verify(c.id, signature), login.verify(c.id, signature)]);
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
  const first = race.find(r => r.status === "fulfilled")!;
  assert.equal(first.status, "fulfilled");
  const token = first.status === "fulfilled" ? first.value.token : "";
  const resumed = await login.resume(token, account.address);
  assert.equal(resumed.token, token);
  assert.equal(resumed.expiresAt, first.status === "fulfilled" ? first.value.expiresAt : "");
  await assert.rejects(() => login.resume(token, other.address));
  const [row] = await testSql`select s.token_hash,s.owner_hash,k.role,k.usdc_balance from wallet_login_sessions s join api_keys k on k.key_hash=s.owner_hash`;
  assert.equal(row?.token_hash, sha256Hex(token)); assert.equal(row?.role, "wallet"); assert.equal(String(row?.usdc_balance), "0");
  assert.notEqual(row?.owner_hash, sha256Hex(account.address));
  const second = await login.challenge(account.address);
  await login.verify(second.id, await account.signMessage({ message: second.message }));
  const owners = await testSql`select distinct owner_hash from wallet_login_sessions`;
  assert.equal(owners.length, 1);
  const third = await login.challenge(other.address);
  await login.verify(third.id, await other.signMessage({ message: third.message }));
  assert.equal((await testSql`select distinct owner_hash from wallet_login_sessions`).length, 2);
  await login.logout(token); assert.equal((await testSql`select token_hash from wallet_login_sessions where token_hash=${sha256Hex(token)}`).length, 0);
  await assert.rejects(() => login.resume(token, account.address));
  const expired = await login.challenge(account.address);
  await testSql`update wallet_login_challenges set expires_at=now()-interval '1 second' where id=${expired.id}`;
  await assert.rejects(() => login.verify(expired.id, signature));
  for (let n = 0; n < 5; n++) await login.challenge(account.address);
  await assert.rejects(() => login.challenge(account.address), /Wait before/);
  console.log("Wallet login PostgreSQL integration passed: replay race, stable identity, isolation, no credit/admin grant, logout, expiry and rate limit.");
} finally {
  await testSql?.end();
  // The only drop target is the generated test schema, quoted as an SQL identifier.
  await admin`drop schema if exists ${admin(schema)} cascade`;
  await admin.end();
}
