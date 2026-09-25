import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getAddress, recoverMessageAddress, type Hex } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { z } from "zod";
import { AppError, UnauthorizedError, ValidationError, sha256Hex } from "@enclave/core";
import type { createDb } from "@enclave/db";

type Challenge = { id: string; address: string; message: string; expiresAt: Date };
export interface WalletLoginStore {
  put(challenge: Challenge): Promise<void>;
  get(id: string): Promise<Challenge | undefined>;
  consume(id: string, tokenHash: string, expiresAt: Date): Promise<boolean>;
  revoke(tokenHash: string): Promise<void>;
}
export class PostgresWalletLoginStore implements WalletLoginStore {
  constructor(private sql: ReturnType<typeof createDb>["sql"]) {}
  async put(c: Challenge) {
    await this.sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtext(${`wallet-login:${c.address}`}))`;
      await tx`delete from wallet_login_challenges where expires_at <= now()`;
      await tx`delete from wallet_login_sessions where expires_at <= now()`;
      const [count] = await tx`select count(*)::int as n from wallet_login_challenges where address = ${c.address}`;
      if (Number(count?.n) >= 5) throw new AppError("LOGIN_RATE_LIMIT", "Wait before requesting another login", 429);
      await tx`insert into wallet_login_challenges(id,address,message,expires_at) values (${c.id},${c.address},${c.message},${c.expiresAt})`;
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
      await tx`insert into wallet_login_sessions(token_hash,owner_hash,address,expires_at) values (${tokenHash},${owner.owner_hash},${c.address},${expiresAt})`;
      return true;
    });
  }
  async revoke(hash: string) { await this.sql`delete from wallet_login_sessions where token_hash=${hash}`; }
}

export class WalletLogin {
  constructor(readonly origin: string, private store: WalletLoginStore) {
    if (new URL(origin).origin !== origin || !origin.startsWith("https://")) throw Error("Exact HTTPS login origin required");
  }
  async challenge(address: string) {
    const issuedAt = new Date(), expiresAt = new Date(issuedAt.getTime() + 300_000);
    const id = randomBytes(24).toString("hex"), checksum = getAddress(address);
    const message = createSiweMessage({ domain: new URL(this.origin).host, address: checksum, uri: `${this.origin}/dashboard`,
      version: "1", chainId: 5042, nonce: id, issuedAt, expirationTime: expiresAt,
      statement: "Sign in to Enclave. This does not authorize a payment." });
    await this.store.put({ id, address: checksum.toLowerCase(), message, expiresAt });
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
}

export function walletLoginRoutes(login: WalletLogin) {
  const app = new Hono();
  let remaining = 120, reset = Date.now() + 60_000;
  app.use("*", bodyLimit({ maxSize: 4096, onError: c => c.json({ title: "BODY_TOO_LARGE", status: 413 }, 413) }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method !== "GET") {
      if (c.req.header("origin") !== login.origin) throw new UnauthorizedError("Login origin mismatch");
      if (Date.now() >= reset) { remaining = 120; reset = Date.now() + 60_000; }
      if (--remaining < 0) throw new AppError("LOGIN_RATE_LIMIT", "Too many login requests", 429);
    }
    await next();
  });
  app.get("/config", c => c.json({ enabled: true, origin: login.origin, chainId: 5042, accountType: "EOA", sessionMinutes: 30 }));
  app.post("/challenge", async c => {
    const body = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ValidationError({ login: "Expected a wallet address" });
    return c.json(await login.challenge(body.data.address));
  });
  app.post("/verify", async c => {
    const body = z.object({ id: z.string().regex(/^[a-f0-9]{48}$/), signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ValidationError({ login: "Expected a challenge ID and EOA signature" });
    return c.json(await login.verify(body.data.id, body.data.signature as Hex));
  });
  app.post("/logout", async c => { await login.logout(c.req.header("x-api-key") ?? ""); return c.json({ ok: true }); });
  return app;
}
