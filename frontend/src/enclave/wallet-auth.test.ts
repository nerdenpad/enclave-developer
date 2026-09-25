import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { signLoginMessage, validateLoginMessage, walletLoginAvailable } from "./wallet-auth";
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
