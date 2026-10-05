import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { sha256Hex } from "@enclave/core";
import { WalletLogin, MemoryWalletLoginLimiter, RedisWalletLoginLimiter, normalizeWalletClientIp, type WalletLoginLimiter, type WalletLoginStore } from "./wallet-auth.js";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import type { EnclaveGateway } from "./gateway.js";

const origin = "https://enclaveagent.tech", account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const firstClient = "203.0.113.10", secondClient = "203.0.113.20";
const connection = (address = firstClient) => ({ incoming: { socket: { remoteAddress: address } } });
afterEach(() => { vi.useRealTimers(); });
function fixture(options: { trustedProxyIps?: readonly string[]; limiter?: WalletLoginLimiter } = {}) {
  const challenges = new Map<string, Parameters<WalletLoginStore["put"]>[0]>(), sessions = new Map<string, Date>();
  const store: WalletLoginStore = {
    async put(c) { challenges.set(c.id, c); }, async get(id) { return challenges.get(id); },
    async consume(id, hash, expires) { if (!challenges.delete(id)) return false; sessions.set(hash, expires); return true; },
    async session(hash) { const expiresAt = sessions.get(hash); return expiresAt ? { address: account.address, expiresAt } : undefined; },
    async revoke(hash) { sessions.delete(hash); },
  };
  const login = new WalletLogin(origin, store, options);
  const gateway = { health: () => ({ chainId: 31337, paymentMode: "mock" }), openSession: vi.fn(), settlePayment: vi.fn() };
  const app = createApp(gateway as unknown as EnclaveGateway, createLogger("silent"), undefined, login);
  const post = (path: string, body: unknown, requestOrigin = origin, token?: string, client = firstClient, headers: Record<string, string> = {}) => app.request(path, {
    method: "POST", headers: { origin: requestOrigin, "content-type": "application/json", ...(token ? { "x-api-key": token } : {}), ...headers }, body: JSON.stringify(body),
  }, connection(client));
  return { login, challenges, sessions, store, app, post, gateway };
}
describe("wallet login", () => {
  it("restores a signed session across navigation without extending its expiry", async () => {
    const f = fixture(), challenge = await f.login.challenge(account.address);
    const signature = await account.signMessage({ message: challenge.message });
    const response = await f.post("/v1/auth/wallet/verify", { id: challenge.id, signature });
    expect(response.status).toBe(200);
    const session = await response.json();
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Secure"); expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/v1/auth/wallet");
    const resume = (address = account.address, from = origin) => f.app.request("/v1/auth/wallet/resume", {
      method: "POST", headers: { origin: from, cookie: cookie.split(";")[0]!, "content-type": "application/json" }, body: JSON.stringify({ address }),
    }, connection());
    const restored = await resume(); expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ ...session, address: account.address });
    expect(restored.headers.get("set-cookie")).toBeNull();
    expect((await resume(account.address, "https://evil.example")).status).toBe(401);
    expect((await resume(`0x${"22".repeat(20)}`)).status).toBe(401);
    f.sessions.set(sha256Hex(session.token), new Date(0));
    expect((await resume()).status).toBe(401);
    await f.login.logout(session.token);
    expect((await resume()).status).toBe(401);
  });
  it("revokes cookie login on explicit logout and preserves a newer cookie during stale logout", async () => {
    const f = fixture(), challenge = await f.login.challenge(account.address);
    const session = await f.login.verify(challenge.id, await account.signMessage({ message: challenge.message }));
    const logout = (token?: string) => f.app.request("/v1/auth/wallet/logout", { method: "POST",
      headers: { origin, cookie: `__Secure-enclave-login=${session.token}`, ...(token ? { "x-api-key": token } : {}) } }, connection());
    const stale = await logout(`enws_${"cc".repeat(32)}`);
    expect(stale.headers.get("set-cookie")).toBeNull();
    expect(f.sessions.size).toBe(1);
    const result = await logout();
    expect(result.status).toBe(200); expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(f.sessions.size).toBe(0);
  });
  it("issues a scoped message, verifies it and stores only a token hash", async () => {
    const f = fixture(), c = await f.login.challenge(account.address);
    expect(parseSiweMessage(c.message)).toMatchObject({ address: account.address, domain: "enclaveagent.tech", chainId: 5042, nonce: c.id });
    const signature = await account.signMessage({ message: c.message });
    const result = await f.login.verify(c.id, signature);
    expect(f.sessions.has(sha256Hex(result.token))).toBe(true); expect(f.sessions.has(result.token)).toBe(false);
    expect(Date.parse(result.expiresAt) - Date.now()).toBeGreaterThan(1_790_000);
    await f.login.logout(result.token); expect(f.sessions.size).toBe(0);
    await f.login.logout(result.token); expect(f.sessions.size).toBe(0);
  });
  it("allows only one concurrent use of a signed challenge", async () => {
    const f = fixture(), c = await f.login.challenge(account.address), signature = await account.signMessage({ message: c.message });
    const results = await Promise.allSettled([f.login.verify(c.id, signature), f.login.verify(c.id, signature)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(f.sessions.size).toBe(1);
  });
  it("rejects another signer, expired messages and changed domain", async () => {
    const f = fixture(), c = await f.login.challenge(account.address), other = privateKeyToAccount(`0x${"22".repeat(32)}`);
    await expect(f.login.verify(c.id, await other.signMessage({ message: c.message }))).rejects.toThrow("does not match");
    await expect(new WalletLogin("https://other.example", f.store).verify(c.id, await account.signMessage({ message: c.message }))).rejects.toThrow("scope changed");
    f.challenges.get(c.id)!.expiresAt = new Date(0);
    await expect(f.login.verify(c.id, await account.signMessage({ message: c.message }))).rejects.toThrow("expired");
  });
  it("rejects login origin spoofing, malformed bodies and oversized requests", async () => {
    const f = fixture();
    expect((await f.post("/v1/auth/wallet/challenge", { address: account.address }, "https://evil.example")).status).toBe(401);
    expect((await f.post("/v1/auth/wallet/challenge", { address: "bad" })).status).toBe(400);
    expect((await f.post("/v1/auth/wallet/verify", { signature: "secret" })).status).toBe(400);
    expect((await f.post("/v1/auth/wallet/challenge", { address: "x".repeat(5000) })).status).toBe(413);
    expect(f.challenges.size).toBe(0);
  });
  it("rate limits malformed challenges with a retry deadline without allocating login records", async () => {
    const f = fixture();
    for (let n = 0; n < 30; n++) expect((await f.post("/v1/auth/wallet/challenge", {})).status).toBe(400);
    const denied = await f.post("/v1/auth/wallet/challenge", { address: account.address });
    expect(denied.status).toBe(429); expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(f.challenges.size).toBe(0);
  });
  it("exhausting one client cannot block another client's challenge, verify, resume or logout", async () => {
    const f = fixture(), put = vi.spyOn(f.store, "put");
    for (let n = 0; n < 120; n++) await f.post("/v1/auth/wallet/challenge", {});
    expect(put).not.toHaveBeenCalled();
    const response = await f.post("/v1/auth/wallet/challenge", { address: account.address }, origin, undefined, secondClient);
    expect(response.status).toBe(200); const challenge = await response.json();
    const verified = await f.post("/v1/auth/wallet/verify", { id: challenge.id, signature: await account.signMessage({ message: challenge.message }) }, origin, undefined, secondClient);
    expect(verified.status).toBe(200); const session = await verified.json();
    const cookie = `__Secure-enclave-login=${session.token}`;
    expect((await f.post("/v1/auth/wallet/resume", { address: account.address }, origin, undefined, secondClient, { cookie })).status).toBe(200);
    expect((await f.post("/v1/auth/wallet/logout", {}, origin, undefined, secondClient, { cookie })).status).toBe(200);
    expect(f.sessions.size).toBe(0); expect(f.gateway.settlePayment).not.toHaveBeenCalled();
  });
  it("reserves logout capacity even after the same client exhausts issuing, verification and restoration quotas", async () => {
    const f = fixture(), challenge = await f.login.challenge(account.address);
    const session = await f.login.verify(challenge.id, await account.signMessage({ message: challenge.message }));
    for (const [action, limit] of [["challenge", 30], ["verify", 60], ["resume", 120]] as const) {
      for (let n = 0; n < limit; n++) await f.post(`/v1/auth/wallet/${action}`, {});
      expect((await f.post(`/v1/auth/wallet/${action}`, {})).status).toBe(429);
    }
    expect((await f.post("/v1/auth/wallet/logout", {}, origin, session.token)).status).toBe(200);
    expect(f.sessions.size).toBe(0);
  });
  it("limits client+address resources without giving another client the victim's address quota", async () => {
    const f = fixture();
    for (let n = 0; n < 5; n++) expect((await f.post("/v1/auth/wallet/challenge", { address: account.address })).status).toBe(200);
    expect((await f.post("/v1/auth/wallet/challenge", { address: account.address })).status).toBe(429);
    expect((await f.post("/v1/auth/wallet/challenge", { address: account.address }, origin, undefined, secondClient)).status).toBe(200);
    const stored = [...f.challenges.values()];
    expect(stored.every(value => /^0x[a-f0-9]{64}$/.test(value.clientHash ?? ""))).toBe(true);
    expect(new Set(stored.map(value => value.clientHash)).size).toBe(2);
    expect(JSON.stringify(stored)).not.toContain(firstClient);
  });
  it("ignores forged forwarding headers from an untrusted native peer", async () => {
    const f = fixture();
    for (let n = 0; n < 30; n++) expect((await f.post("/v1/auth/wallet/challenge", {}, origin, undefined, firstClient,
      { "x-forwarded-for": `198.51.100.${n + 1}`, "x-real-ip": `198.51.100.${n + 1}` })).status).toBe(400);
    expect((await f.post("/v1/auth/wallet/challenge", {}, origin, undefined, firstClient, { "x-forwarded-for": secondClient, "x-real-ip": secondClient })).status).toBe(429);
    expect((await f.post("/v1/auth/wallet/challenge", { address: account.address }, origin, undefined, secondClient, { "x-real-ip": firstClient })).status).toBe(200);
  });
  it("uses only a valid single client IP from an explicitly trusted proxy, including IPv4-mapped peers", async () => {
    const f = fixture({ trustedProxyIps: ["127.0.0.1"] });
    for (let n = 0; n < 30; n++) expect((await f.post("/v1/auth/wallet/challenge", {}, origin, undefined, "::ffff:127.0.0.1", { "x-real-ip": firstClient })).status).toBe(400);
    expect((await f.post("/v1/auth/wallet/challenge", {}, origin, undefined, "127.0.0.1", { "x-real-ip": `::ffff:${firstClient}` })).status).toBe(429);
    expect((await f.post("/v1/auth/wallet/challenge", { address: account.address }, origin, undefined, "127.0.0.1", { "x-real-ip": secondClient })).status).toBe(200);
    for (const value of ["", `${firstClient}, ${secondClient}`, "unknown", "198.51.100.1:443"]) {
      expect((await f.post("/v1/auth/wallet/challenge", {}, origin, undefined, "127.0.0.1", { "x-real-ip": value, "x-forwarded-for": secondClient })).status).toBe(503);
    }
  });
  it("does not treat Origin or arbitrary headers as a client identity when native bindings are absent", async () => {
    const f = fixture();
    const response = await f.app.request("/v1/auth/wallet/challenge", { method: "POST", headers: { origin, "content-type": "application/json", "x-forwarded-for": secondClient }, body: JSON.stringify({ address: account.address }) });
    expect(response.status).toBe(503); expect(f.challenges.size).toBe(0);
  });
  it("fails issuing credentials closed when the shared limiter fails, but keeps bounded logout available", async () => {
    const limiter = { take: vi.fn().mockRejectedValue(Error("private redis endpoint and password")) }, f = fixture({ limiter });
    const unavailable = await f.post("/v1/auth/wallet/challenge", { address: account.address });
    expect(unavailable.status).toBe(503); expect(await unavailable.text()).not.toContain("private redis"); expect(f.challenges.size).toBe(0);
    const challenge = await f.login.challenge(account.address), signature = await account.signMessage({ message: challenge.message });
    const failedVerify = await f.post("/v1/auth/wallet/verify", { id: challenge.id, signature });
    expect(failedVerify.status).toBe(503); expect(failedVerify.headers.get("set-cookie")).toBeNull(); expect(f.challenges.has(challenge.id)).toBe(true);
    const session = await f.login.verify(challenge.id, signature);
    for (let n = 0; n < 30; n++) expect((await f.post("/v1/auth/wallet/logout", {}, origin, session.token)).status).toBe(200);
    expect((await f.post("/v1/auth/wallet/logout", {}, origin, session.token)).status).toBe(429); expect(f.sessions.size).toBe(0);
  });
  it("blocks public sessions from spending pilot funds or mutating admin/agent state", async () => {
    const f = fixture(), token = `enws_${"ab".repeat(32)}`;
    for (const path of ["/v1/session", "/v1/x402/settle", "/v1/inference", "/v1/tcb/rotate", "/v1/agents", "/trpc/infer"]) {
      expect((await f.post(path, {}, origin, token)).status).toBe(403);
    }
    expect(f.gateway.settlePayment).not.toHaveBeenCalled(); expect(f.gateway.openSession).not.toHaveBeenCalled();
    expect((await f.post("/v1/auth/wallet/logout", {}, origin, token)).status).toBe(200);
  });
});

describe("wallet login limiter storage", () => {
  it("normalizes equivalent IPv6 and mapped IPv4 client representations", () => {
    expect(normalizeWalletClientIp("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(normalizeWalletClientIp("::ffff:203.0.113.10")).toBe(firstClient);
    expect(normalizeWalletClientIp("::ffff:cb00:710a")).toBe(firstClient);
    for (const value of ["unknown", "203.0.113.10, 203.0.113.20", "127.0.0.1:80", "203.000.113.10", "fe80::1%lo0"]) expect(normalizeWalletClientIp(value)).toBeUndefined();
  });
  it("bounds local entries without globally denying new clients and resets their windows", async () => {
    vi.useFakeTimers(); const limiter = new MemoryWalletLoginLimiter(4);
    for (const key of ["a", "b", "c", "d"]) expect(await limiter.take({ key, limit: 1 })).toBe(0);
    expect(await limiter.take({ key: "a", limit: 1 })).toBe(60_000);
    expect(await limiter.take({ key: "e", limit: 1 })).toBe(0); expect(await limiter.take({ key: "a", limit: 1 })).toBe(60_000);
    await vi.advanceTimersByTimeAsync(60_000); expect(await limiter.take({ key: "a", limit: 1 })).toBe(0);
  });
  it("uses an atomic TTL-bounded Redis operation with only opaque quota keys", async () => {
    const runQuota = vi.fn().mockResolvedValue(0), defineQuota = vi.fn(), f = fixture({ limiter: new RedisWalletLoginLimiter({ status: "ready", defineCommand: defineQuota, runCommand: runQuota }) });
    expect((await f.post("/v1/auth/wallet/challenge", { address: account.address })).status).toBe(200);
    expect(defineQuota).toHaveBeenCalledExactlyOnceWith("enclaveWalletLoginQuotaV1", { numberOfKeys: 1, lua: expect.any(String) });
    expect(runQuota).toHaveBeenCalledTimes(2);
    for (const [name, [key, window, max]] of runQuota.mock.calls) {
      expect(name).toBe("enclaveWalletLoginQuotaV1"); expect(key).toMatch(/^enclave:wallet-login:v1:\{wallet-login\}:0x[a-f0-9]{64}$/);
      expect(key).not.toContain(firstClient); expect(key).not.toContain(account.address); expect(window).toBe(60_000); expect([30, 5]).toContain(max);
    }
  });
  it("bounds a hung Redis operation and consumes its late failure without an in-memory login bypass", async () => {
    vi.useFakeTimers(); let reject!: (error: unknown) => void;
    const runQuota = vi.fn().mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const limiter = new RedisWalletLoginLimiter({ status: "ready", defineCommand: vi.fn(), runCommand: runQuota });
    const pending = limiter.take({ key: sha256Hex("client"), limit: 1 });
    const rejected = expect(pending).rejects.toMatchObject({ code: "LOGIN_LIMIT_UNAVAILABLE", statusCode: 503 });
    await vi.advanceTimersByTimeAsync(2000); await rejected;
    reject(Error("late private Redis failure")); await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not dispatch authentication commands to an offline Redis client", async () => {
    const runCommand = vi.fn(), redis = { status: "reconnecting", defineCommand: vi.fn(), runCommand };
    const limiter = new RedisWalletLoginLimiter(redis);
    await expect(limiter.take({ key: sha256Hex("client"), limit: 1 })).rejects.toMatchObject({ code: "LOGIN_LIMIT_UNAVAILABLE" });
    expect(runCommand).not.toHaveBeenCalled();
    redis.status = "ready"; runCommand.mockResolvedValue(0);
    expect(await limiter.take({ key: sha256Hex("client"), limit: 1 })).toBe(0);
  });
  it("retains a bounded slot for each stalled underlying Redis command after the HTTP wait times out", async () => {
    vi.useFakeTimers(); const completions: ((result: unknown) => void)[] = [];
    const runCommand = vi.fn().mockImplementation(() => new Promise(resolve => { completions.push(resolve); }));
    const limiter = new RedisWalletLoginLimiter({ status: "ready", defineCommand: vi.fn(), runCommand }, 2);
    const quota = { key: sha256Hex("client"), limit: 1 };
    const first = limiter.take(quota), second = limiter.take(quota);
    const firstFailed = expect(first).rejects.toMatchObject({ code: "LOGIN_LIMIT_UNAVAILABLE" });
    const secondFailed = expect(second).rejects.toMatchObject({ code: "LOGIN_LIMIT_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(2000); await firstFailed; await secondFailed;
    expect(runCommand).toHaveBeenCalledTimes(2);
    for (let attempt = 0; attempt < 20; attempt++) await expect(limiter.take(quota)).rejects.toMatchObject({ code: "LOGIN_LIMIT_UNAVAILABLE" });
    expect(runCommand).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    completions[0]!(0); await vi.advanceTimersByTimeAsync(0);
    runCommand.mockResolvedValueOnce(0); expect(await limiter.take(quota)).toBe(0); expect(runCommand).toHaveBeenCalledTimes(3);
    completions[1]!(0); await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0);
  });
});
