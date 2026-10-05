import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { IRedisClient } from "bullmq";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { getAddress, recoverMessageAddress, type Hex } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { z } from "zod";
import { AppError, UnauthorizedError, ValidationError, sha256Hex } from "@enclave/core";
import type { createDb } from "@enclave/db";

type Challenge = { id: string; address: string; message: string; expiresAt: Date; clientHash?: string };
type LoginAction = "challenge" | "verify" | "resume" | "logout" | "other";
export type WalletLoginQuota = { key: string; limit: number };
export interface WalletLoginLimiter { take(quota: WalletLoginQuota): Promise<number>; }
const LIMIT_WINDOW_MS = 60_000;
const clientLimits: Record<LoginAction, number> = { challenge: 30, verify: 60, resume: 120, logout: 60, other: 30 };
const resourceLimits: Record<Exclude<LoginAction, "other">, number> = { challenge: 5, verify: 10, resume: 60, logout: 30 };

/** Bounded, single-process limiter. Production injects the shared Redis limiter. */
export class MemoryWalletLoginLimiter implements WalletLoginLimiter {
  private entries = new Map<string, { count: number; reset: number }>();
  constructor(private capacity = 10_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000) throw Error("Invalid wallet login limiter capacity");
  }
  async take(quota: WalletLoginQuota): Promise<number> {
    const now = Date.now();
    const previous = this.entries.get(quota.key);
    const value = previous && previous.reset > now ? previous : { count: 0, reset: now + LIMIT_WINDOW_MS };
    // Touch existing callers even when denied, so key churn cannot cheaply
    // evict the actively exhausted client's counter.
    if (previous) { this.entries.delete(quota.key); this.entries.set(quota.key, value); }
    if (value.count >= quota.limit) return value.reset - now;
    if (!this.entries.has(quota.key) && this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(quota.key, { count: value.count + 1, reset: value.reset });
    return 0;
  }
}

const TAKE_WALLET_QUOTA = `
local key = KEYS[1]
local count = tonumber(redis.call('GET', key) or '0')
if count >= tonumber(ARGV[2]) then
  local ttl = redis.call('PTTL', key)
  if ttl < 0 then redis.call('PEXPIRE', key, ARGV[1]); ttl = tonumber(ARGV[1]) end
  return math.max(1, ttl)
end
redis.call('INCR', key)
if redis.call('PTTL', key) < 0 then redis.call('PEXPIRE', key, ARGV[1]) end
return 0
`;

/** Atomic across replicas sharing this Redis namespace; all keys expire. */
export class RedisWalletLoginLimiter implements WalletLoginLimiter {
  private pending = 0;
  constructor(private redis: Pick<IRedisClient, "status" | "defineCommand" | "runCommand">, private capacity = 64) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024) throw Error("Invalid wallet login Redis capacity");
    redis.defineCommand("enclaveWalletLoginQuotaV1", { numberOfKeys: 1, lua: TAKE_WALLET_QUOTA });
  }
  async take(quota: WalletLoginQuota): Promise<number> {
    try {
      // Never fill the receipt queue client's offline buffer. A stalled ready
      // connection is also capped; HTTP deadlines do not release these slots
      // until the underlying command actually settles.
      if (this.redis.status !== "ready" || this.pending >= this.capacity) throw Error("Wallet quota client unavailable");
      this.pending++;
      const result = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Wallet quota timeout")), 2000);
        // Keep late Redis completion/rejection handled after the HTTP deadline.
        void Promise.resolve().then(() => {
          if (this.redis.status !== "ready") throw Error("Wallet quota client unavailable");
          return this.redis.runCommand("enclaveWalletLoginQuotaV1", [`enclave:wallet-login:v1:{wallet-login}:${quota.key}`, LIMIT_WINDOW_MS, quota.limit]);
        }).then(value => { this.pending--; clearTimeout(timeout); resolve(value); }, error => { this.pending--; clearTimeout(timeout); reject(error); });
      });
      if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0 || result > LIMIT_WINDOW_MS) throw Error("Invalid wallet quota result");
      return result;
    } catch { throw new AppError("LOGIN_LIMIT_UNAVAILABLE", "Wallet sign-in is temporarily unavailable. Try again.", 503); }
  }
}

export function normalizeWalletClientIp(value: string): string | undefined {
  if (value.length > 64 || value.includes("%") || !isIP(value)) return undefined;
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = normalized.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return normalized;
}
type WalletLoginOptions = { trustedProxyIps?: readonly string[]; limiter?: WalletLoginLimiter };
export interface WalletLoginStore {
  put(challenge: Challenge): Promise<void>;
  get(id: string): Promise<Challenge | undefined>;
  consume(id: string, tokenHash: string, expiresAt: Date): Promise<boolean>;
  revoke(tokenHash: string): Promise<void>;
  session(tokenHash: string): Promise<{ address: string; expiresAt: Date } | undefined>;
}
export class PostgresWalletLoginStore implements WalletLoginStore {
  constructor(private sql: ReturnType<typeof createDb>["sql"]) {}
  async put(c: Challenge) {
    const clientHash = c.clientHash ?? "legacy";
    await this.sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtext(${`wallet-login:${c.address}:${clientHash}`}))`;
      await tx`delete from wallet_login_challenges where expires_at <= now()`;
      await tx`delete from wallet_login_sessions where expires_at <= now()`;
      const [count] = await tx`select count(*)::int as n from wallet_login_challenges where address = ${c.address} and client_hash = ${clientHash}`;
      if (Number(count?.n) >= 5) throw new AppError("LOGIN_RATE_LIMIT", "Wait before requesting another login", 429);
      await tx`insert into wallet_login_challenges(id,address,message,expires_at,client_hash) values (${c.id},${c.address},${c.message},${c.expiresAt.toISOString()},${clientHash})`;
    });
  }
  async get(id: string) {
    const [row] = await this.sql`select id,address,message,expires_at from wallet_login_challenges where id=${id} and expires_at > now()`;
    return row ? { id: String(row.id), address: String(row.address), message: String(row.message), expiresAt: new Date(row.expires_at) } : undefined;
  }
  async consume(id: string, tokenHash: string, expiresAt: Date) {
    return this.sql.begin(async tx => {
      // Consume and create the session atomically; racing replays cannot both succeed.
      const [c] = await tx`delete from wallet_login_challenges where id=${id} and expires_at > now() returning address`;
      if (!c) return false;
      await tx`select pg_advisory_xact_lock(hashtext(${`wallet-login:${c.address}`}))`;
      let [owner] = await tx`select owner_hash from wallet_accounts where address=${c.address}`;
      if (!owner) {
        const ownerHash = sha256Hex(randomBytes(32));
        await tx`insert into api_keys(key_hash,label,role,usdc_balance) values (${ownerHash},${`Wallet ${c.address}`},'wallet',0)`;
        await tx`insert into wallet_accounts(address,owner_hash) values (${c.address},${ownerHash})`;
        owner = { owner_hash: ownerHash };
      }
      const [count] = await tx`select count(*)::int as n from wallet_login_sessions where address=${c.address} and expires_at > now()`;
      if (Number(count?.n) >= 10) throw new AppError("LOGIN_SESSION_LIMIT", "Sign out another session or wait for it to expire", 429);
      await tx`insert into wallet_login_sessions(token_hash,owner_hash,address,expires_at) values (${tokenHash},${owner.owner_hash},${c.address},${expiresAt.toISOString()})`;
      return true;
    });
  }
  async revoke(hash: string) { await this.sql`delete from wallet_login_sessions where token_hash=${hash}`; }
  async session(hash: string) {
    const [row] = await this.sql`select address,expires_at from wallet_login_sessions where token_hash=${hash} and expires_at > now()`;
    return row ? { address: String(row.address), expiresAt: new Date(row.expires_at) } : undefined;
  }
}

export class WalletLogin {
  private trustedProxyIps: Set<string>;
  private limiter: WalletLoginLimiter;
  private logoutFallback = new MemoryWalletLoginLimiter();
  constructor(readonly origin: string, private store: WalletLoginStore, options: WalletLoginOptions = {}) {
    if (new URL(origin).origin !== origin || !origin.startsWith("https://")) throw Error("Exact HTTPS login origin required");
    this.trustedProxyIps = new Set((options.trustedProxyIps ?? []).map(ip => {
      const normalized = normalizeWalletClientIp(ip);
      if (!normalized) throw Error("Trusted wallet login proxy must be an exact IP address");
      return normalized;
    }));
    this.limiter = options.limiter ?? new MemoryWalletLoginLimiter();
  }
  client(c: Context): string {
    let peer: string | undefined;
    try { peer = normalizeWalletClientIp(getConnInfo(c).remote.address ?? ""); } catch { /* Non-node adapters must supply a native socket binding. */ }
    if (!peer) throw new AppError("LOGIN_CLIENT_UNAVAILABLE", "Wallet sign-in client identity is unavailable", 503);
    if (!this.trustedProxyIps.has(peer)) return peer;
    // The configured proxy must overwrite this single header. Never take the
    // leftmost arbitrary X-Forwarded-For value or treat Origin as client identity.
    const forwarded = normalizeWalletClientIp(c.req.header("x-real-ip") ?? "");
    if (!forwarded) throw new AppError("LOGIN_CLIENT_UNAVAILABLE", "Wallet sign-in proxy identity is unavailable", 503);
    return forwarded;
  }
  async limit(client: string, action: LoginAction, resource?: string): Promise<number> {
    const scope = `${this.origin}:${action}:${resource === undefined ? "client" : "resource"}`;
    const quota = { key: sha256Hex(`${scope}:${client}${resource === undefined ? "" : `:${resource}`}`),
      limit: resource === undefined || action === "other" ? clientLimits[action] : resourceLimits[action] };
    try { return await this.limiter.take(quota); }
    catch (error) {
      // Revoke/logout has separate capacity and a bounded local fallback during
      // Redis outages. Issuing or restoring credentials remains fail-closed.
      if (action === "logout") return this.logoutFallback.take(quota);
      if (error instanceof AppError && error.code === "LOGIN_LIMIT_UNAVAILABLE") throw error;
      throw new AppError("LOGIN_LIMIT_UNAVAILABLE", "Wallet sign-in is temporarily unavailable. Try again.", 503);
    }
  }
  async challenge(address: string, client?: string) {
    const issuedAt = new Date(), expiresAt = new Date(issuedAt.getTime() + 300_000);
    const id = randomBytes(24).toString("hex"), checksum = getAddress(address);
    const message = createSiweMessage({ domain: new URL(this.origin).host, address: checksum, uri: `${this.origin}/dashboard`,
      version: "1", chainId: 5042, nonce: id, issuedAt, expirationTime: expiresAt,
      statement: "Sign in to Enclave. This does not authorize a payment." });
    await this.store.put({ id, address: checksum.toLowerCase(), message, expiresAt,
      ...(client === undefined ? {} : { clientHash: sha256Hex(`wallet-login:${this.origin}:${client}`) }) });
    return { id, message, expiresAt: expiresAt.toISOString() };
  }
  async verify(id: string, signature: Hex) {
    const c = await this.store.get(id);
    if (!c || c.expiresAt.getTime() <= Date.now()) throw new UnauthorizedError("Login challenge expired or already used");
    const data = parseSiweMessage(c.message);
    if (data.domain !== new URL(this.origin).host || data.uri !== `${this.origin}/dashboard` || data.chainId !== 5042
      || data.nonce !== c.id || data.address?.toLowerCase() !== c.address || data.expirationTime?.getTime() !== c.expiresAt.getTime()) throw new UnauthorizedError("Login scope changed");
    let signer: string;
    try { signer = await recoverMessageAddress({ message: c.message, signature }); }
    catch { throw new UnauthorizedError("Invalid wallet signature"); }
    if (signer.toLowerCase() !== c.address) throw new UnauthorizedError("Wallet signature does not match");
    const token = `enws_${randomBytes(32).toString("hex")}`, expiresAt = new Date(Date.now() + 30 * 60_000);
    if (!await this.store.consume(id, sha256Hex(token), expiresAt)) throw new UnauthorizedError("Login challenge expired or already used");
    return { token, address: signer, expiresAt: expiresAt.toISOString() };
  }
  async logout(token: string) { if (/^enws_[a-f0-9]{64}$/.test(token)) await this.store.revoke(sha256Hex(token)); }
  async resume(token: string, address: string) {
    if (!/^enws_[a-f0-9]{64}$/.test(token)) throw new UnauthorizedError("No wallet login session");
    const session = await this.store.session(sha256Hex(token));
    if (!session || session.expiresAt.getTime() <= Date.now() || session.address.toLowerCase() !== address.toLowerCase()) throw new UnauthorizedError("Wallet login expired or changed");
    return { token, address: session.address, expiresAt: session.expiresAt.toISOString() };
  }
}

export function walletLoginRoutes(login: WalletLogin) {
  const app = new Hono<{ Variables: { walletLoginClient: string } }>();
  const cookie = "__Secure-enclave-login";
  const cookieOptions = { path: "/api/v1/auth/wallet", secure: true, httpOnly: true, sameSite: "Strict" as const };
  const limit = async (c: Context<{ Variables: { walletLoginClient: string } }>, action: LoginAction, resource?: string) => {
    const retry = await login.limit(c.get("walletLoginClient"), action, resource);
    if (retry) { c.header("Retry-After", String(Math.max(1, Math.ceil(retry / 1000)))); throw new AppError("LOGIN_RATE_LIMIT", "Too many login requests. Wait before trying again.", 429); }
  };
  app.use("*", bodyLimit({ maxSize: 4096, onError: c => c.json({ title: "BODY_TOO_LARGE", status: 413 }, 413) }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method !== "GET") {
      if (c.req.header("origin") !== login.origin) throw new UnauthorizedError("Login origin mismatch");
      c.set("walletLoginClient", login.client(c));
      const name = c.req.path.split("/").at(-1);
      const action: LoginAction = name === "challenge" || name === "verify" || name === "resume" || name === "logout" ? name : "other";
      await limit(c, action);
    }
    await next();
  });
  app.get("/config", c => c.json({ enabled: true, origin: login.origin, chainId: 5042, accountType: "EOA", sessionMinutes: 30 }));
  app.post("/challenge", async c => {
    const body = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ValidationError({ login: "Expected a wallet address" });
    await limit(c, "challenge", body.data.address.toLowerCase());
    return c.json(await login.challenge(body.data.address, c.get("walletLoginClient")));
  });
  app.post("/verify", async c => {
    const body = z.object({ id: z.string().regex(/^[a-f0-9]{48}$/), signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ValidationError({ login: "Expected a challenge ID and EOA signature" });
    await limit(c, "verify", body.data.id);
    const session = await login.verify(body.data.id, body.data.signature as Hex);
    setCookie(c, cookie, session.token, { ...cookieOptions, expires: new Date(session.expiresAt) });
    return c.json(session);
  });
  // Restore only through an origin-checked POST. The bearer stays in JS memory;
  // its durable copy is a scoped HttpOnly cookie, never localStorage.
  app.post("/resume", async c => {
    const body = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ValidationError({ login: "Expected a wallet address" });
    const token = getCookie(c, cookie) ?? "";
    await limit(c, "resume", /^enws_[a-f0-9]{64}$/.test(token) ? sha256Hex(token) : "none");
    return c.json(await login.resume(token, body.data.address));
  });
  app.post("/logout", async c => {
    const stored = getCookie(c, cookie), token = c.req.header("x-api-key") ?? stored ?? "";
    await limit(c, "logout", /^enws_[a-f0-9]{64}$/.test(token) ? sha256Hex(token) : "none");
    await login.logout(token);
    // A late cancellation of an old login must not remove a newer browser session.
    if (!stored || stored === token) deleteCookie(c, cookie, cookieOptions);
    return c.json({ ok: true });
  });
  return app;
}
