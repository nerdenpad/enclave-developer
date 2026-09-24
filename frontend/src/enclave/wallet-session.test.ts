import { describe, expect, it, vi } from "vitest";
import type SignClient from "@walletconnect/sign-client";
import { accountFromSession, connectBrowserWallet, connectWalletConnect, parseChainId } from "./wallet-session";
import type { BrowserProvider } from "./wallets";

const first = `0x${"11".repeat(20)}`, second = `0x${"22".repeat(20)}`;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function browser() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const state = { accounts: [first], chain: "0x1" };
  const request = vi.fn(async ({ method }: { method: string }) => method === "eth_chainId" ? state.chain : state.accounts);
  const provider: BrowserProvider = { request, on: (name, handler) => { listeners.set(name, handler); }, removeListener: name => { listeners.delete(name); } };
  return { wallet: { id: "fixture", name: "Fixture", provider }, request, state, listeners };
}
function session() { return { topic: "topic", expiry: Math.floor(Date.now() / 1000) + 60, peer: { metadata: { name: "Remote wallet" } }, namespaces: { eip155: { accounts: [`eip155:1:${first}`], methods: ["eth_signTypedData_v4"] } } }; }
function wc() {
  const gate = deferred<ReturnType<typeof session>>();
  const listeners = new Map<string, (value: { topic: string }) => void>();
  const disconnect = vi.fn().mockResolvedValue(undefined), pairingDisconnect = vi.fn().mockResolvedValue(undefined);
  const connect = vi.fn().mockResolvedValue({ uri: `wc:${"a".repeat(64)}@2?symKey=test`, approval: () => gate.promise });
  const client = { connect, disconnect, core: { pairing: { disconnect: pairingDisconnect } }, on: (event: string, fn: (value: { topic: string }) => void) => listeners.set(event, fn), off: (event: string) => listeners.delete(event) };
  return { gate, listeners, disconnect, pairingDisconnect, connect, getClient: async () => client as unknown as SignClient };
}
describe("browser wallet lifecycle", () => {
  it("connects with read-only calls, tracks account/network changes and removes listeners", async () => {
    const mock = browser(), changed = vi.fn();
    const connection = await connectBrowserWallet(mock.wallet, new AbortController().signal, changed);
    expect(connection.account.address).toBe(first);
    mock.state.accounts = [second]; mock.state.chain = "0x2105";
    mock.listeners.get("accountsChanged")?.();
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ address: second, chainId: 8453 })));
    expect(mock.request.mock.calls.every(([args]) => ["eth_requestAccounts", "eth_accounts", "eth_chainId"].includes(args.method))).toBe(true);
    await connection.disconnect();
    expect(mock.listeners.size).toBe(0);
    expect(changed).toHaveBeenLastCalledWith(null);
  });
  it("drops the connection when the wallet locks", async () => {
    const mock = browser(), changed = vi.fn();
    await connectBrowserWallet(mock.wallet, new AbortController().signal, changed);
    mock.state.accounts = []; mock.listeners.get("accountsChanged")?.();
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(null));
    expect(mock.listeners.size).toBe(0);
  });
  it("ignores late approval after cancellation", async () => {
    const mock = browser(), gate = deferred<string[]>(), changed = vi.fn(), abort = new AbortController();
    mock.request.mockImplementationOnce(() => gate.promise);
    const pending = connectBrowserWallet(mock.wallet, abort.signal, changed);
    abort.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve([first]); await Promise.resolve();
    expect(changed).not.toHaveBeenCalled(); expect(mock.listeners.size).toBe(0);
  });
  it("does not connect with malformed accounts or chain IDs", async () => {
    const mock = browser(); mock.state.accounts = ["invalid"];
    await expect(connectBrowserWallet(mock.wallet, new AbortController().signal, vi.fn())).rejects.toThrow();
    expect(mock.listeners.size).toBe(0);
    for (const value of [0, -1, "0x0", "1e3", "0x20000000000000"]) expect(() => parseChainId(value)).toThrow();
  });
});
describe("WalletConnect lifecycle", () => {
  it("requests only the connection scope and disconnects when account approval changes", async () => {
    const mock = wc(), changed = vi.fn();
    const pending = connectWalletConnect("a".repeat(32), 1, new AbortController().signal, vi.fn(), changed, mock.getClient);
    mock.gate.resolve(session());
    const connection = await pending;
    expect(connection.account.address).toBe(first);
    expect(mock.connect).toHaveBeenCalledWith({ requiredNamespaces: { eip155: { chains: ["eip155:1"], methods: ["eth_signTypedData_v4"], events: ["accountsChanged", "chainChanged"] } } });
    mock.listeners.get("session_update")?.({ topic: "topic" });
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(null));
    expect(mock.disconnect).toHaveBeenCalledTimes(1); expect(mock.listeners.size).toBe(0);
  });
  it("cancels pairing and closes a session approved after the dialog closes", async () => {
    const mock = wc(), changed = vi.fn(), abort = new AbortController(), uri = vi.fn();
    const pending = connectWalletConnect("a".repeat(32), 1, abort.signal, uri, changed, mock.getClient);
    await vi.waitFor(() => expect(uri).toHaveBeenCalled());
    abort.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    mock.gate.resolve(session());
    await vi.waitFor(() => expect(mock.disconnect).toHaveBeenCalled());
    expect(mock.pairingDisconnect).toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  });
  it("rejects unapproved networks, missing signing capability and expired sessions", () => {
    expect(() => accountFromSession(session(), 8453)).toThrow();
    expect(() => accountFromSession({ ...session(), expiry: 1 }, 1)).toThrow();
    const noMethod = session(); noMethod.namespaces.eip155.methods = [];
    expect(() => accountFromSession(noMethod, 1)).toThrow();
  });
  it("disconnects an unusable approved session without exposing an account", async () => {
    const mock = wc(), changed = vi.fn();
    const pending = connectWalletConnect("a".repeat(32), 8453, new AbortController().signal, vi.fn(), changed, mock.getClient);
    mock.gate.resolve(session()); await expect(pending).rejects.toThrow();
    expect(mock.disconnect).toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  });
});
