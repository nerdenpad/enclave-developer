import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverWallets, fetchWalletDirectory, pairingLink, parseWalletDirectory, walletError } from "./wallets";

afterEach(() => vi.unstubAllGlobals());
describe("wallet discovery and directory", () => {
  it("discovers distinct extensions, deduplicates announcements and stops listening on disposal", () => {
    const target = new EventTarget() as Window;
    const update = vi.fn();
    const provider = { request: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const detail = { info: { uuid: "a139eb1f-44df-456a-ad70-197939cf0806", name: "Test wallet" }, provider };
    const stop = discoverWallets(target, update);
    target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0][0].provider).toBe(provider);
    stop();
    target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { ...detail, info: { ...detail.info, uuid: "b139eb1f-44df-456a-ad70-197939cf0806" } } }));
    expect(update).toHaveBeenCalledTimes(1);
  });
  it("ignores malformed announcements and upgrades a legacy extension name", () => {
    const target = new EventTarget() as Window;
    const provider = { request: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    Reflect.set(target, "ethereum", provider);
    const update = vi.fn(), stop = discoverWallets(target, update);
    expect(update.mock.calls[0]![0][0].name).toBe("Browser wallet");
    target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "bad", name: "bad" }, provider } }));
    target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "a139eb1f-44df-456a-ad70-197939cf0806", name: "Named wallet" }, provider } }));
    expect(update.mock.calls[1]![0]).toHaveLength(1);
    expect(update.mock.calls[1]![0][0].name).toBe("Named wallet");
    stop();
  });
  it("loads more than 50 directory entries without fabricating a wallet list", async () => {
    const listings = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), { id: String(i), name: `Fixture ${i}`, mobile: { native: null, universal: null } }]));
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ listings, total: 165 })));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    const result = await fetchWalletDirectory("a".repeat(32), 8453, "wallet", 2, signal);
    expect(result.wallets).toHaveLength(65);
    const url = new URL(fetcher.mock.calls[0]![0]);
    expect(url.origin).toBe("https://explorer-api.walletconnect.com");
    expect(url.searchParams.get("chains")).toBe("eip155:8453");
    expect(url.searchParams.get("entries")).toBe("100");
    expect(url.searchParams.get("page")).toBe("2");
    expect(fetcher.mock.calls[0]![1].signal).toBe(signal);
  });
  it("rejects unavailable configuration before network access", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(fetchWalletDirectory("", 1, "", 1, new AbortController().signal)).rejects.toThrow("not configured");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("validates, deduplicates and caps catalog rows", () => {
    const result = parseWalletDirectory({ listings: { one: { id: "a", name: "One" }, duplicate: { id: "a", name: "One" }, invalid: { id: "b", name: "" } }, total: 3 });
    expect(result.wallets).toHaveLength(1);
    expect(() => parseWalletDirectory({ listings: {}, total: -1 })).toThrow();
  });
  it("keeps provider messages and pairing data out of displayed errors", () => {
    expect(walletError({ code: 4001, message: "sensitive" })).toContain("declined");
    expect(walletError(new Error("wc:secret"))).not.toContain("secret");
  });
});

describe("wallet pairing links", () => {
  const uri = `wc:${"a".repeat(64)}@2?symKey=${"b".repeat(64)}&relay-protocol=irn`;
  it("encodes the URI in a validated universal or native link", () => {
    expect(pairingLink({ id: "a", name: "One", mobile: { universal: "https://wallet.example/app" } }, uri)).toBe(`https://wallet.example/app/wc?uri=${encodeURIComponent(uri)}`);
    expect(pairingLink({ id: "a", name: "One", mobile: { native: "testwallet://" } }, uri)).toBe(`testwallet://wc?uri=${encodeURIComponent(uri)}`);
  });
  it.each(["javascript://attack", "data://attack", "file://attack", "intent://attack", "ms-excel://attack", "powershell://attack", "https://user:password@evil.example/"])("rejects dangerous link %s", native => {
    expect(pairingLink({ id: "a", name: "One", mobile: { native, universal: native } }, uri)).toBeNull();
  });
  it("does not use malformed pairing URIs", () => {
    expect(pairingLink({ id: "a", name: "One", mobile: { native: "testwallet://" } }, "javascript:alert(1)")).toBeNull();
  });
});
