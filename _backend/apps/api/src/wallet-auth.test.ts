import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { sha256Hex } from "@enclave/core";
import { WalletLogin, type WalletLoginStore } from "./wallet-auth.js";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import type { EnclaveGateway } from "./gateway.js";

const origin = "https://enclaveagent.tech", account = privateKeyToAccount(`0x${"11".repeat(32)}`);
function fixture() {
  const challenges = new Map<string, Parameters<WalletLoginStore["put"]>[0]>(), sessions = new Map<string, Date>();
  const store: WalletLoginStore = {
    async put(c) { challenges.set(c.id, c); }, async get(id) { return challenges.get(id); },
    async consume(id, hash, expires) { if (!challenges.delete(id)) return false; sessions.set(hash, expires); return true; },
    async revoke(hash) { sessions.delete(hash); },
  };
  const login = new WalletLogin(origin, store);
  const gateway = { health: () => ({ chainId: 31337, paymentMode: "mock" }), openSession: vi.fn(), settlePayment: vi.fn() };
  const app = createApp(gateway as unknown as EnclaveGateway, createLogger("silent"), undefined, login);
  const post = (path: string, body: unknown, requestOrigin = origin, token?: string) => app.request(path, {
    method: "POST", headers: { origin: requestOrigin, "content-type": "application/json", ...(token ? { "x-api-key": token } : {}) }, body: JSON.stringify(body),
  });
  return { login, challenges, sessions, store, app, post, gateway };
}
describe("wallet login", () => {
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
  it("rate limits login requests", async () => {
    const f = fixture();
    for (let n = 0; n < 120; n++) await f.post("/v1/auth/wallet/challenge", {});
    expect((await f.post("/v1/auth/wallet/challenge", { address: account.address })).status).toBe(429);
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
