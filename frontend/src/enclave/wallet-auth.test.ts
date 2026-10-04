import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { loginWallet, signLoginMessage, validateLoginMessage, walletLoginAvailable } from "./wallet-auth";
import type { WalletConnection } from "./wallet-session";
const account = privateKeyToAccount(`0x${"11".repeat(32)}`), origin = "https://enclaveagent.tech", nonce = "a".repeat(48);
function message(overrides = {}) { return createSiweMessage({ domain: "enclaveagent.tech", address: account.address, uri: `${origin}/dashboard`,
  version: "1", chainId: 5042, nonce, issuedAt: new Date(), expirationTime: new Date(Date.now() + 300_000),
  statement: "Sign in to Enclave. This does not authorize a payment.", ...overrides }); }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("wallet login availability", () => {
  it("recovers from a transient configuration timeout without retrying a signature", async () => {
    vi.useFakeTimers(); vi.stubGlobal("location", { origin });
    const fetch = vi.fn().mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"))
      .mockResolvedValue(new Response(JSON.stringify({ enabled: true, origin, chainId: 5042 })));
    vi.stubGlobal("fetch", fetch);
    const available = walletLoginAvailable();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await available).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url, options]) => url === "/api/v1/auth/wallet/config" && options.method === "GET")).toBe(true);
  });
  it("does not retry disabled login or accept another origin", async () => {
    vi.stubGlobal("location", { origin });
    const fetch = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, origin: "https://evil.example", chainId: 5042 })));
    vi.stubGlobal("fetch", fetch);
    expect(await walletLoginAvailable()).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
    expect(await walletLoginAvailable()).toBe(false); expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("cancelled wallet login", () => {
  function connection(signIn: WalletConnection["signIn"]): WalletConnection {
    return { account: { address: account.address, chainId: 5042, name: "Fixture", transport: "walletconnect" },
      signIn, disconnect: vi.fn(), authorizeArc: vi.fn() };
  }
  function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  const json = (value: unknown) => new Response(JSON.stringify(value));
  it("abandons a hung signature and never verifies a late approval", async () => {
    vi.stubGlobal("location", { origin });
    const approval = deferred<`0x${string}`>(), started = deferred<void>(), controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(json({ id: nonce, message: message() })); vi.stubGlobal("fetch", fetch);
    const wallet = connection(vi.fn((_message, signal) => { expect(signal).toBe(controller.signal); started.resolve(); return approval.promise; }));
    const login = loginWallet(wallet, () => true, controller.signal);
    const rejected = expect(login).rejects.toMatchObject({ name: "AbortError" });
    await started.promise; controller.abort(); await rejected;
    approval.resolve(`0x${"ab".repeat(65)}`); await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/auth/wallet/challenge");
  });
  it("abandons a pending challenge before requesting any signature", async () => {
    vi.stubGlobal("location", { origin });
    const challenge = deferred<Response>(), controller = new AbortController(), signIn = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => challenge.promise));
    const login = loginWallet(connection(signIn), () => true, controller.signal);
    const rejected = expect(login).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejected;
    challenge.resolve(json({ id: nonce, message: message() })); await new Promise(resolve => setTimeout(resolve, 0));
    expect(signIn).not.toHaveBeenCalled();
  });
  it("preserves a timeout reason and consumes late wallet failure", async () => {
    vi.stubGlobal("location", { origin });
    const approval = deferred<`0x${string}`>(), started = deferred<void>(), controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(json({ id: nonce, message: message() })); vi.stubGlobal("fetch", fetch);
    const login = loginWallet(connection(() => { started.resolve(); return approval.promise; }), () => true, controller.signal);
    const rejected = expect(login).rejects.toMatchObject({ name: "TimeoutError" });
    await started.promise; controller.abort(new DOMException("Sign-in timed out", "TimeoutError")); await rejected;
    approval.reject(new Error("Late SDK failure")); await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("revokes a late verified token without publishing the cancelled login", async () => {
    vi.stubGlobal("location", { origin });
    const verified = deferred<Response>(), verifying = deferred<void>(), controller = new AbortController();
    const token = `enws_${"c".repeat(64)}`;
    const fetch = vi.fn((url: string, _options?: RequestInit) => {
      if (url.endsWith("/challenge")) return Promise.resolve(json({ id: nonce, message: message() }));
      if (url.endsWith("/verify")) {
        // Match fetch/body cancellation rather than a transport that ignores it.
        _options?.signal?.addEventListener("abort", () => verified.reject(_options.signal?.reason), { once: true });
        verifying.resolve(); return verified.promise;
      }
      return Promise.resolve(json({ ok: true }));
    }); vi.stubGlobal("fetch", fetch);
    const login = loginWallet(connection(text => account.signMessage({ message: text })), () => true, controller.signal);
    const rejected = expect(login).rejects.toMatchObject({ name: "AbortError" });
    await verifying.promise; controller.abort(); await rejected;
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    verified.resolve(json({ token, address: account.address, expiresAt: new Date(Date.now() + 1_800_000).toISOString() }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/v1/auth/wallet/challenge", "/api/v1/auth/wallet/verify", "/api/v1/auth/wallet/logout"]);
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ headers: { "x-api-key": token } });
  });
});
describe("wallet login signing", () => {
  it("signs only the current site's login message without a transaction", async () => {
    vi.stubGlobal("location", { origin }); const text = message();
    const request = vi.fn(async () => account.signMessage({ message: text }));
    await signLoginMessage(text, account.address, request);
    expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0]).toMatchObject([{ method: "personal_sign" }]);
  });
  it.each([{ domain: "evil.example" }, { chainId: 1 }, { uri: "https://evil.example" }, { statement: "Transfer money" },
    { nonce: "badnonce" }, { expirationTime: new Date(0) }, { address: `0x${"22".repeat(20)}` }])("rejects mismatched login scope %j", overrides => {
    expect(() => validateLoginMessage(message(overrides), account.address, origin, nonce)).toThrow();
  });
  it("rejects a signature made by another account", async () => {
    vi.stubGlobal("location", { origin }); const text = message();
    await expect(signLoginMessage(text, account.address, () => privateKeyToAccount(`0x${"22".repeat(32)}`).signMessage({ message: text }))).rejects.toThrow("does not match");
  });
});
