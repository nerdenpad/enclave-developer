import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { WALLET_AUTH_SQL } from "@enclave/db";
import { WalletLogin, PostgresWalletLoginStore } from "./wallet-auth.js";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import type { EnclaveGateway } from "./gateway.js";
import { Queue, type IRedisClient } from "bullmq";
import { sha256Hex } from "@enclave/core";
import { RedisWalletLoginLimiter } from "./wallet-auth.js";

const origin = "https://enclaveagent.tech", signer = privateKeyToAccount(`0x${"31".repeat(32)}`);
const attacker = "203.0.113.10", victim = "203.0.113.20";

describe("wallet login quotas and additive migration on isolated PostgreSQL", () => {
  let admin: ReturnType<typeof postgres>, sql: ReturnType<typeof postgres>;
  let ownedSchema: string, first: WalletLogin, second: WalletLogin;
  beforeAll(() => {
    expect(process.env.ENCLAVE_INTEGRATION, "Use only the disposable integration runner").toBe("1");
    const target = process.env.WALLET_AUTH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!target) throw Error("Disposable wallet login test database is required");
    const url = new URL(target);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error("Wallet auth integration tests require a local disposable PostgreSQL server");
    admin = postgres(target, { max: 1 });
  });
  beforeEach(async () => {
    ownedSchema = `enclave_wallet_auth_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA "${ownedSchema}"`);
    sql = postgres(process.env.WALLET_AUTH_TEST_DATABASE_URL ?? process.env.DATABASE_URL!, {
      max: 5, connection: { search_path: ownedSchema, application_name: ownedSchema },
    });
    // Private minimal dependencies and the previous challenge schema reproduce
    // an upgrade without touching the application's public tables.
    await sql.unsafe(`CREATE TABLE api_keys (key_hash text PRIMARY KEY, label text, role text, usdc_balance bigint);
      CREATE TABLE wallet_login_challenges (id text PRIMARY KEY, address text NOT NULL, message text NOT NULL,
        expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());`);
    first = new WalletLogin(origin, new PostgresWalletLoginStore(sql));
    second = new WalletLogin(origin, new PostgresWalletLoginStore(sql));
  });
  afterEach(async () => {
    await sql?.end({ timeout: 5 });
    if (ownedSchema && /^enclave_wallet_auth_[a-f0-9]{32}$/.test(ownedSchema)) await admin.unsafe(`DROP SCHEMA "${ownedSchema}" CASCADE`);
  });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  async function migrateTwice() { await sql.unsafe(WALLET_AUTH_SQL); await sql.unsafe(WALLET_AUTH_SQL); }

  it("applies the additive migration twice and still verifies a previously issued legacy challenge", async () => {
    const id = randomBytes(24).toString("hex"), issuedAt = new Date(), expiresAt = new Date(Date.now() + 300_000);
    const message = createSiweMessage({ domain: "enclaveagent.tech", address: signer.address, uri: `${origin}/dashboard`,
      version: "1", chainId: 5042, nonce: id, issuedAt, expirationTime: expiresAt,
      statement: "Sign in to Enclave. This does not authorize a payment." });
    await sql`insert into wallet_login_challenges(id,address,message,expires_at) values (${id},${signer.address.toLowerCase()},${message},${expiresAt.toISOString()})`;
    await migrateTwice();
    expect((await sql`select client_hash from wallet_login_challenges where id=${id}`)[0]?.client_hash).toBe("legacy");
    const session = await first.verify(id, await signer.signMessage({ message }));
    expect(session.address).toBe(signer.address);
    expect((await first.resume(session.token, signer.address)).token).toBe(session.token);
    await first.logout(session.token); await expect(first.resume(session.token, signer.address)).rejects.toThrow("expired or changed");
  });

  it("five unconsumed attacker challenges cannot fill the victim's slots for the same public address", async () => {
    await migrateTwice();
    for (let index = 0; index < 5; index++) await first.challenge(signer.address, attacker);
    await expect(second.challenge(signer.address, attacker)).rejects.toMatchObject({ code: "LOGIN_RATE_LIMIT", statusCode: 429 });
    const challenge = await second.challenge(signer.address, victim);
    const session = await first.verify(challenge.id, await signer.signMessage({ message: challenge.message }));
    expect(session.address).toBe(signer.address);
    const rows = await sql`select client_hash, count(*)::int as n from wallet_login_challenges group by client_hash`;
    expect(rows).toHaveLength(1); expect(Number(rows[0]?.n)).toBe(5); expect(rows[0]?.client_hash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(attacker); expect(JSON.stringify(rows)).not.toContain(victim);
  });

  it("enforces five pending challenges per client/address across racing store instances", async () => {
    await migrateTwice();
    const raced = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).challenge(signer.address, attacker)));
    expect(raced.filter(result => result.status === "fulfilled")).toHaveLength(5);
    expect(raced.filter(result => result.status === "rejected")).toHaveLength(15);
    for (const result of raced) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "LOGIN_RATE_LIMIT", statusCode: 429 });
    const independent = await Promise.allSettled(Array.from({ length: 5 }, () => second.challenge(signer.address, victim)));
    expect(independent.every(result => result.status === "fulfilled")).toBe(true);
    expect(Number((await sql`select count(*)::int as n from wallet_login_challenges`)[0]?.n)).toBe(10);
  });

  it("keeps a second native client's full login path available after the original 120-request griefing reproduction", async () => {
    await migrateTwice();
    const gateway = { health: () => ({ chainId: 5042, paymentMode: "authorized" }), openSession: vi.fn(), settlePayment: vi.fn() };
    // REASON: only login routes run; no gateway, payment or provider operation is invoked.
    const app = createApp(gateway as unknown as EnclaveGateway, createLogger("silent"), undefined, first);
    const post = (path: string, body: unknown, peer: string, cookie = "") => app.request(`/v1/auth/wallet/${path}`, {
      method: "POST", headers: { origin, "content-type": "application/json", cookie }, body: JSON.stringify(body),
    }, { incoming: { socket: { remoteAddress: peer } } });
    for (let index = 0; index < 120; index++) await post("challenge", {}, attacker);
    expect(Number((await sql`select count(*)::int as n from wallet_login_challenges`)[0]?.n)).toBe(0);
    const challengeResponse = await post("challenge", { address: signer.address }, victim); expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json();
    const verified = await post("verify", { id: challenge.id, signature: await signer.signMessage({ message: challenge.message }) }, victim);
    expect(verified.status).toBe(200); const session = await verified.json(), cookie = `__Secure-enclave-login=${session.token}`;
    expect((await post("resume", { address: signer.address }, victim, cookie)).status).toBe(200);
    expect((await post("logout", {}, victim, cookie)).status).toBe(200);
    expect(Number((await sql`select count(*)::int as n from wallet_login_sessions`)[0]?.n)).toBe(0);
    expect(gateway.openSession).not.toHaveBeenCalled(); expect(gateway.settlePayment).not.toHaveBeenCalled();
  });
});

// The default CI harness always provides Redis. Missing wiring is an error in
// CI, not an unnoticed skip; an explicitly local PostgreSQL-only run can skip.
const realRedisEnabled = process.env.ENCLAVE_INTEGRATION === "1" && (process.env.CI === "true" || Boolean(process.env.REDIS_URL));
describe.skipIf(!realRedisEnabled)("wallet login atomic quotas on the disposable local Redis service", () => {
  let firstQueue: Queue, secondQueue: Queue, firstClient: IRedisClient, secondClient: IRedisClient;
  let firstLimiter: RedisWalletLoginLimiter, secondLimiter: RedisWalletLoginLimiter;
  const keys = new Set<string>();
  const redisKey = (key: string) => `enclave:wallet-login:v1:{wallet-login}:${key}`;
  function quota(limit: number) { const key = sha256Hex(`wallet-quota-test:${randomUUID()}`); keys.add(redisKey(key)); return { key, limit }; }
  beforeAll(async () => {
    const target = process.env.REDIS_URL;
    if (!target || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(target).hostname)) throw Error("Wallet quota integration requires a disposable local Redis service");
    firstQueue = new Queue(`wallet-quota-test-${randomUUID()}`, { connection: { url: target } });
    secondQueue = new Queue(`wallet-quota-test-${randomUUID()}`, { connection: { url: target } });
    firstQueue.on("error", () => {}); secondQueue.on("error", () => {});
    firstClient = await firstQueue.client; secondClient = await secondQueue.client;
    firstLimiter = new RedisWalletLoginLimiter(firstClient); secondLimiter = new RedisWalletLoginLimiter(secondClient);
    firstClient.defineCommand("enclaveWalletQuotaTestTtl", { numberOfKeys: 1, lua: "return redis.call('PTTL', KEYS[1])" });
  });
  afterEach(async () => { if (keys.size) await firstClient.del(...keys); keys.clear(); });
  afterAll(async () => {
    // These random empty queues and exact quota keys belong only to this suite.
    await firstQueue?.obliterate({ force: true }); await secondQueue?.obliterate({ force: true });
    await firstQueue?.close(); await secondQueue?.close();
  });
  it("admits exactly five racing requests across clients, preserving independent quotas and the original TTL", async () => {
    const shared = quota(5);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? firstLimiter : secondLimiter).take(shared)));
    expect(results.filter(value => value === 0)).toHaveLength(5);
    expect(results.filter(value => value > 0 && value <= 60_000)).toHaveLength(15);
    const before: unknown = await firstClient.runCommand("enclaveWalletQuotaTestTtl", [redisKey(shared.key)]);
    expect(Number(before)).toBeGreaterThan(0); expect(Number(before)).toBeLessThanOrEqual(60_000);
    expect(await secondLimiter.take(quota(5))).toBe(0);
    expect(await firstLimiter.take(shared)).toBeGreaterThan(0);
    const after: unknown = await firstClient.runCommand("enclaveWalletQuotaTestTtl", [redisKey(shared.key)]);
    expect(Number(after)).toBeLessThanOrEqual(Number(before));
  });
  it("expires quota counters and restores a bounded TTL for a preexisting counter with no expiry", async () => {
    const value = quota(5), key = redisKey(value.key);
    await firstClient.set(key, 5);
    expect(await firstLimiter.take(value)).toBeGreaterThan(0);
    expect(Number(await firstClient.runCommand("enclaveWalletQuotaTestTtl", [key]))).toBeGreaterThan(0);
    await firstClient.set(key, 5, { PX: 1 }); await new Promise<void>(resolve => setTimeout(resolve, 5));
    expect(await secondLimiter.take(value)).toBe(0);
    expect(Number(await firstClient.runCommand("enclaveWalletQuotaTestTtl", [key]))).toBeGreaterThan(0);
  });
});
