import { afterEach, describe, expect, it, vi } from "vitest";
import { onWalletChanged, paymentWallet, setPaymentWallet, walletChanged } from "./wallet-runtime";
import { WalletSessionUnavailableError, type WalletConnection } from "./wallet-session";

const unsubscribe: Array<() => void> = [];
function wallet(assertActive = vi.fn()): WalletConnection {
  return { account: { address: `0x${"11".repeat(20)}`, chainId: 5042, name: "Fixture", transport: "walletconnect" },
    assertActive, disconnect: vi.fn().mockResolvedValue(undefined), signIn: vi.fn(), authorizeArc: vi.fn() };
}
afterEach(() => { for (const stop of unsubscribe.splice(0)) stop(); setPaymentWallet(null, false); });

describe("payment wallet runtime", () => {
  it("explains the current action when a wallet must be connected", () => {
    expect(() => paymentWallet()).toThrow("Connect a wallet before confirming payment");
    expect(() => paymentWallet("sign-in")).toThrow("Connect a wallet before signing in");
  });
  it("distinguishes lifecycle changes from an explicit disconnect and supports silent updates", () => {
    const changed = vi.fn(), legacy = vi.fn(() => {});
    unsubscribe.push(onWalletChanged(changed), onWalletChanged(legacy));
    setPaymentWallet(wallet()); walletChanged(); setPaymentWallet(null, true, "disconnect"); setPaymentWallet(wallet(), false);
    expect(changed.mock.calls).toEqual([["connection"], ["connection"], ["disconnect"]]);
    expect(legacy).toHaveBeenCalledTimes(3);
    unsubscribe.pop()?.(); walletChanged(); expect(legacy).toHaveBeenCalledTimes(3);
  });
  it("checks the active transport each time the wallet is retrieved", () => {
    const assertActive = vi.fn(), current = wallet(assertActive); setPaymentWallet(current, false);
    expect(paymentWallet()).toBe(current); expect(paymentWallet("sign-in")).toBe(current);
    expect(assertActive).toHaveBeenCalledTimes(2);
  });
  it("clears an unavailable connection and notifies once without retrying an approval", () => {
    const changed = vi.fn(), unavailable = new WalletSessionUnavailableError("missing"), current = wallet(vi.fn(() => { throw unavailable; }));
    unsubscribe.push(onWalletChanged(changed)); setPaymentWallet(current, false);
    expect(() => paymentWallet()).toThrow(unavailable);
    expect(changed).toHaveBeenCalledExactlyOnceWith("connection");
    expect(() => paymentWallet()).toThrow("Connect a wallet");
    expect(current.authorizeArc).not.toHaveBeenCalled(); expect(current.disconnect).not.toHaveBeenCalled();
  });
  it("does not repeat a synchronous invalidation notification from the transport", () => {
    const changed = vi.fn(), current = wallet(vi.fn(() => { setPaymentWallet(null); throw new WalletSessionUnavailableError("expired"); }));
    unsubscribe.push(onWalletChanged(changed)); setPaymentWallet(current, false);
    expect(() => paymentWallet()).toThrow(WalletSessionUnavailableError);
    expect(changed).toHaveBeenCalledExactlyOnceWith("connection");
  });
  it("marks a changed signing identity separately from a missing session", () => {
    const changed = vi.fn(), current = wallet(vi.fn(() => { throw new WalletSessionUnavailableError("changed"); }));
    unsubscribe.push(onWalletChanged(changed)); setPaymentWallet(current, false);
    expect(() => paymentWallet()).toThrow(WalletSessionUnavailableError);
    expect(changed).toHaveBeenCalledExactlyOnceWith("identity");
  });
  it("preserves an explicit replacement installed while the previous connection is invalidated", () => {
    const replacement = wallet(), changed = vi.fn();
    const stale = wallet(vi.fn(() => { setPaymentWallet(replacement); throw new WalletSessionUnavailableError("missing"); }));
    unsubscribe.push(onWalletChanged(changed)); setPaymentWallet(stale, false);
    expect(() => paymentWallet()).toThrow(WalletSessionUnavailableError);
    expect(paymentWallet()).toBe(replacement); expect(changed).toHaveBeenCalledTimes(1);
  });
});
