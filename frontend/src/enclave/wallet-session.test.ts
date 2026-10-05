import { afterEach, describe, expect, it, vi } from "vitest";
import type SignClient from "@walletconnect/sign-client";
import { accountFromSession, connectBrowserWallet, connectWalletConnect, parseChainId, switchBrowserToArc, WalletSessionUnavailableError, WalletPeerUnavailableError } from "./wallet-session";
import type { BrowserProvider } from "./wallets";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { receiveData } from "./arc-payment";

const first = `0x${"11".repeat(20)}`, second = `0x${"22".repeat(20)}`;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function browser() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const state = { accounts: [first], chain: "0x1" };
  const request = vi.fn(async ({ method }: { method: string }): Promise<unknown> => method === "eth_chainId" ? state.chain : state.accounts);
  const provider: BrowserProvider = { request, on: (name, handler) => { listeners.set(name, handler); }, removeListener: name => { listeners.delete(name); } };
  return { wallet: { id: "fixture", name: "Fixture", provider }, request, state, listeners };
}
function session() { return { topic: "topic", expiry: Math.floor(Date.now() / 1000) + 60, peer: { metadata: { name: "Remote wallet" } }, namespaces: { eip155: { accounts: [`eip155:1:${first}`], methods: ["eth_signTypedData_v4", "personal_sign"] } } }; }
function wc() {
  const gate = deferred<ReturnType<typeof session>>();
  const sessions = new Map<string, ReturnType<typeof session>>();
  type SessionEvent = { topic: string; params?: { namespaces?: unknown; chainId?: string; event?: { name: string; data: unknown } } };
  const listeners = new Map<string, (value: SessionEvent) => void>();
  const disconnect = vi.fn().mockResolvedValue(undefined), pairingDisconnect = vi.fn().mockResolvedValue(undefined);
  const ping = vi.fn().mockResolvedValue(undefined);
  const request = vi.fn<({ topic, chainId, request }: { topic: string; chainId: string; request: { method: string; params: unknown[] } }) => Promise<unknown>>().mockResolvedValue(undefined);
  const connect = vi.fn().mockResolvedValue({ uri: `wc:${"a".repeat(64)}@2?symKey=test`, approval: () => gate.promise.then(value => { sessions.set(value.topic, value); return value; }) });
  const get = vi.fn((topic: string) => { const value = sessions.get(topic); if (!value) throw Error(`No matching key. session topic doesn't exist: ${topic}`); return value; });
  const client = { connect, disconnect, ping, request, session: { get }, core: { pairing: { disconnect: pairingDisconnect } }, on: (event: string, fn: (value: SessionEvent) => void) => listeners.set(event, fn), off: (event: string) => listeners.delete(event) };
  return { gate, sessions, get, request, ping, listeners, disconnect, pairingDisconnect, connect, getClient: async () => client as unknown as SignClient };
}
const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
function arcSession(topic = "topic") { const live = session(); live.topic = topic; live.namespaces.eip155.accounts = [`eip155:5042:${signer.address}`]; return live; }
function intent() { return { payer: signer.address, meter: second, amountUnits: "100000", paymentId: "10000000-0000-4000-8000-000000000002", validBefore: String(Math.floor(Date.now() / 1000) + 600) }; }
async function approvedWallet(live = arcSession()) {
  const mock = wc(), changed = vi.fn();
  const pending = connectWalletConnect("a".repeat(32), 5042, new AbortController().signal, vi.fn(), changed, mock.getClient);
  mock.gate.resolve(live);
  return { mock, changed, live, connection: await pending };
}
async function restoredWallet() {
  const mock = wc(), changed = vi.fn(), live = arcSession(); live.expiry += 600;
  mock.sessions.set(live.topic, live);
  const connection = await connectWalletConnect("a".repeat(32), 5042, new AbortController().signal, vi.fn(), changed, mock.getClient, { topic: live.topic, address: signer.address });
  changed.mockClear();
  return { mock, changed, live, connection };
}
function loginMessage() { return createSiweMessage({ domain: "enclaveagent.tech", address: signer.address, uri: "https://enclaveagent.tech/dashboard",
  version: "1", chainId: 5042, nonce: "a".repeat(48), issuedAt: new Date(), expirationTime: new Date(Date.now() + 300_000),
  statement: "Sign in to Enclave. This does not authorize a payment." }); }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("browser wallet lifecycle", () => {
  it.each(["account", "chain"])("reports a valid %s event synchronously and preserves identity loss if provider reads fail", async kind => {
    const mock = browser(), changed = vi.fn();
    await connectBrowserWallet(mock.wallet, new AbortController().signal, changed); changed.mockClear();
    mock.request.mockRejectedValue(Error("Provider unavailable"));
    mock.listeners.get(kind === "account" ? "accountsChanged" : "chainChanged")?.(kind === "account" ? [second] : "0x13b2");
    expect(changed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(kind === "account" ? { address: second } : { chainId: 5042 }), "identity");
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(null, "identity"));
    expect(mock.listeners.size).toBe(0);
  });
  it("detects a rapid account change and return before either provider read finishes", async () => {
    const mock = browser(), changed = vi.fn(), gate = deferred<unknown>();
    const connection = await connectBrowserWallet(mock.wallet, new AbortController().signal, changed); changed.mockClear();
    mock.request.mockImplementation(async ({ method }) => method === "eth_accounts" ? gate.promise : mock.state.chain);
    mock.listeners.get("accountsChanged")?.([second]); mock.listeners.get("accountsChanged")?.([first]);
    expect(changed.mock.calls).toEqual([[expect.objectContaining({ address: second }), "identity"], [expect.objectContaining({ address: first }), "identity"]]);
    gate.resolve([first]); await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3)); connection.detach?.();
  });
  it("treats empty accounts as immediate connection loss and malformed event payloads as a read failure", async () => {
    const mock = browser(), changed = vi.fn();
    await connectBrowserWallet(mock.wallet, new AbortController().signal, changed); changed.mockClear(); mock.request.mockClear();
    mock.listeners.get("accountsChanged")?.([]);
    expect(changed).toHaveBeenCalledExactlyOnceWith(null); expect(mock.request).not.toHaveBeenCalled();
    const malformed = browser(), update = vi.fn(); await connectBrowserWallet(malformed.wallet, new AbortController().signal, update); update.mockClear();
    malformed.request.mockRejectedValue(Error("Provider unavailable")); malformed.listeners.get("accountsChanged")?.(["invalid"]);
    expect(update).not.toHaveBeenCalled(); await vi.waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith(null));
  });
  it("silently restores only the selected address and detaches without disconnecting", async () => {
    const mock = browser(), changed = vi.fn();
    const connection = await connectBrowserWallet(mock.wallet, new AbortController().signal, changed, first);
    expect(mock.request.mock.calls.map(([args]) => args.method)).toEqual(["eth_accounts", "eth_chainId"]);
    changed.mockClear(); connection.detach?.();
    expect(mock.listeners.size).toBe(0); expect(changed).not.toHaveBeenCalled();
    await expect(connectBrowserWallet(mock.wallet, new AbortController().signal, changed, second)).rejects.toThrow("Selected wallet changed");
    expect(mock.listeners.size).toBe(0);
  });
  it.each(["account", "network", "disconnect"])("rejects approval after a %s change even when the original signature is valid", async change => {
    const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const mock = browser(), gate = deferred<string>();
    mock.state.accounts = [signer.address]; mock.state.chain = "0x13b2";
    mock.request.mockImplementation(async ({ method }) => method === "eth_signTypedData_v4" ? gate.promise : method === "eth_chainId" ? mock.state.chain : mock.state.accounts);
    const connection = await connectBrowserWallet(mock.wallet, new AbortController().signal, vi.fn());
    const intent = { payer: signer.address, meter: second, amountUnits: "100000", paymentId: "10000000-0000-4000-8000-000000000002", validBefore: String(Math.floor(Date.now() / 1000) + 600) };
    const pending = connection.authorizeArc(intent);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(mock.request.mock.calls.some(([args]) => args.method === "eth_signTypedData_v4")).toBe(true));
    if (change === "account") mock.state.accounts = [second];
    if (change === "network") mock.state.chain = "0x1";
    if (change === "disconnect") await connection.disconnect();
    gate.resolve(await signer.signTypedData(receiveData(intent)));
    await rejected;
    await connection.disconnect();
  });
  it("connects with read-only calls, tracks account/network changes and removes listeners", async () => {
    const mock = browser(), changed = vi.fn();
    const connection = await connectBrowserWallet(mock.wallet, new AbortController().signal, changed);
    expect(connection.account.address).toBe(first);
    mock.state.accounts = [second]; mock.state.chain = "0x2105";
    mock.listeners.get("accountsChanged")?.();
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ address: second, chainId: 8453 }), "identity"));
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
  it.each(["missing", "expired"])("retires a peer-rejected %s topic without waiting for cleanup or replaying its signature", async cause => {
    const { mock, changed, connection } = await approvedWallet(), cleanup = deferred<void>();
    const unrelated = arcSession("unrelated-topic"); mock.sessions.set(unrelated.topic, unrelated);
    mock.disconnect.mockImplementation(({ topic }: { topic: string }) => cleanup.promise.then(() => { mock.sessions.delete(topic); }));
    mock.request.mockRejectedValueOnce(Error(cause === "missing" ? "There is no existing session matching the topic" : "Wallet session expired"));
    changed.mockClear();
    await expect(connection.authorizeArc(intent())).rejects.toMatchObject({ code: "WALLET_SESSION_UNAVAILABLE", reason: cause });
    expect(changed).toHaveBeenCalledExactlyOnceWith(null); expect(mock.request).toHaveBeenCalledTimes(1);
    expect(mock.disconnect).toHaveBeenCalledExactlyOnceWith({ topic: "topic", reason: { code: 6000, message: "User disconnected" } });
    expect(() => connection.assertActive?.()).toThrow(WalletSessionUnavailableError);
    // The connection was already invalidated, but an explicit disconnect still
    // joins the same retirement instead of returning with a stored stale topic.
    const firstDisconnect = connection.disconnect(), secondDisconnect = connection.disconnect();
    expect(mock.disconnect).toHaveBeenCalledTimes(1);
    cleanup.resolve(); await Promise.all([firstDisconnect, secondDisconnect]);
    expect(mock.sessions.has("topic")).toBe(false); expect(mock.sessions.get("unrelated-topic")).toBe(unrelated);
    expect(changed).toHaveBeenCalledTimes(1); expect(mock.request).toHaveBeenCalledTimes(1);
  });
  it("retires a silently expired SDK session before another wallet signature", async () => {
    const { mock, changed, live, connection } = await approvedWallet();
    mock.disconnect.mockImplementation(async ({ topic }: { topic: string }) => { mock.sessions.delete(topic); });
    live.expiry = 1; changed.mockClear();
    await expect(connection.authorizeArc(intent())).rejects.toMatchObject({ reason: "expired" });
    await connection.disconnect();
    expect(mock.disconnect).toHaveBeenCalledExactlyOnceWith({ topic: "topic", reason: { code: 6000, message: "User disconnected" } });
    expect(mock.sessions.has("topic")).toBe(false); expect(mock.request).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledExactlyOnceWith(null);
  });
  it.each(["resolve", "reject"])("keeps a replacement session active when retirement of its previous topic completes with %s", async outcome => {
    const { mock, changed, connection } = await approvedWallet(), cleanup = deferred<void>();
    mock.disconnect.mockImplementation(({ topic }: { topic: string }) => cleanup.promise.then(() => { mock.sessions.delete(topic); }));
    mock.request.mockRejectedValueOnce(Error("There is no existing session matching the topic")); changed.mockClear();
    await expect(connection.authorizeArc(intent())).rejects.toThrow(WalletSessionUnavailableError);
    const replacement = arcSession("replacement-topic"), replacementChanged = vi.fn(); mock.sessions.set(replacement.topic, replacement);
    const current = await connectWalletConnect("a".repeat(32), 5042, new AbortController().signal, vi.fn(), replacementChanged,
      mock.getClient, { topic: replacement.topic, address: signer.address });
    replacementChanged.mockClear(); const previousNotifications = changed.mock.calls.length;
    if (outcome === "resolve") cleanup.resolve(); else cleanup.reject(Error("Old topic is no longer present in the SDK"));
    await connection.disconnect();
    expect(current.account.address).toBe(signer.address); expect(() => current.assertActive?.()).not.toThrow();
    expect(mock.sessions.get("replacement-topic")).toBe(replacement); expect(replacementChanged).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(previousNotifications); expect(mock.disconnect).toHaveBeenCalledTimes(1);
    expect(mock.request).toHaveBeenCalledTimes(1); current.detach?.();
  });
  it("retires a deleted topic once even if the user disconnects it after the protocol event", async () => {
    const { mock, changed, connection } = await approvedWallet(); changed.mockClear();
    mock.disconnect.mockRejectedValueOnce(Error("No matching key. session topic doesn't exist: topic"));
    mock.listeners.get("session_delete")?.({ topic: "topic" });
    await Promise.all([connection.disconnect(), connection.disconnect()]);
    expect(changed).toHaveBeenCalledExactlyOnceWith(null); expect(mock.disconnect).toHaveBeenCalledTimes(1);
    expect(mock.request).not.toHaveBeenCalled(); expect(mock.listeners.size).toBe(0);
  });
  it("invalidates a session lost after successful login before requesting payment approval", async () => {
    vi.stubGlobal("location", { origin: "https://enclaveagent.tech" });
    const { mock, changed, connection } = await approvedWallet(), message = loginMessage();
    mock.request.mockResolvedValueOnce(await signer.signMessage({ message }));
    await expect(connection.signIn(message)).resolves.toMatch(/^0x/);
    mock.sessions.clear(); changed.mockClear();
    await expect(connection.authorizeArc(intent())).rejects.toMatchObject({ code: "WALLET_SESSION_UNAVAILABLE", reason: "missing" });
    expect(mock.request).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledExactlyOnceWith(null); expect(mock.listeners.size).toBe(0);
    expect(() => connection.account).toThrow(WalletSessionUnavailableError);
    await connection.disconnect(); expect(changed).toHaveBeenCalledTimes(1);
  });
  it.each([
    Error("There is no existing session matching the topic"),
    { code: 2, message: "No matching key. session topic doesn't exist: topic" },
    "Missing or invalid. session topic does not exist in keychain: topic",
  ])("invalidates a topic rejected by the wallet or SDK even while its local store still exists: %j", async error => {
    const { mock, changed, connection } = await approvedWallet();
    mock.request.mockRejectedValueOnce(error); changed.mockClear();
    await expect(connection.authorizeArc(intent())).rejects.toMatchObject({ code: "WALLET_SESSION_UNAVAILABLE", reason: "missing" });
    expect(changed).toHaveBeenCalledExactlyOnceWith(null); expect(mock.listeners.size).toBe(0);
    await expect(connection.authorizeArc(intent())).rejects.toThrow(WalletSessionUnavailableError);
    expect(mock.request).toHaveBeenCalledTimes(1);
  });
  it("keeps an approved session available after the user rejects a signature", async () => {
    const { mock, changed, connection } = await approvedWallet();
    mock.request.mockRejectedValueOnce({ code: 4001, message: "User rejected the request" }); changed.mockClear();
    await expect(connection.authorizeArc(intent())).rejects.toMatchObject({ code: 4001 });
    expect(connection.account.address).toBe(signer.address); expect(changed).not.toHaveBeenCalled();
    const payment = intent(); mock.request.mockResolvedValueOnce(await signer.signTypedData(receiveData(payment)));
    await expect(connection.authorizeArc(payment)).resolves.toMatchObject({ from: signer.address });
    expect(mock.request).toHaveBeenCalledTimes(2); connection.detach?.();
  });
  it.each(["account", "chain", "expiry", "method", "topic"])("rejects a silently changed live %s before requesting a signature", async change => {
    const { mock, changed, live, connection } = await approvedWallet();
    mock.sessions.set("unrelated", arcSession("unrelated"));
    if (change === "account") live.namespaces.eip155.accounts = [`eip155:5042:${second}`];
    if (change === "chain") live.namespaces.eip155.accounts = [`eip155:1:${signer.address}`];
    if (change === "expiry") live.expiry = Math.floor(Date.now() / 1000) - 1;
    if (change === "method") live.namespaces.eip155.methods = ["personal_sign"];
    if (change === "topic") live.topic = "replacement";
    changed.mockClear();
    await expect(connection.authorizeArc(intent())).rejects.toThrow(WalletSessionUnavailableError);
    expect(mock.request).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledExactlyOnceWith(...(change === "expiry" || change === "topic" ? [null] : [null, "identity"]));
    expect(mock.listeners.size).toBe(0);
    expect(mock.disconnect).toHaveBeenCalledExactlyOnceWith({ topic: "topic", reason: { code: 6000, message: "User disconnected" } });
    expect(mock.sessions.has("unrelated")).toBe(true); expect(mock.pairingDisconnect).not.toHaveBeenCalled();
  });
  it("checks the fresh login capability rather than the original approval", async () => {
    const { mock, changed, live, connection } = await approvedWallet();
    live.namespaces.eip155.methods = ["eth_signTypedData_v4"]; changed.mockClear();
    await expect(connection.signIn(loginMessage())).rejects.toMatchObject({ code: "WALLET_SESSION_UNAVAILABLE", reason: "changed" });
    expect(mock.request).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledExactlyOnceWith(null, "identity");
  });
  it("rejects a payer mismatch or another connection chain without signing or discarding its approval", async () => {
    const { mock, connection } = await approvedWallet();
    await expect(connection.authorizeArc({ ...intent(), payer: second })).rejects.toThrow("payer wallet");
    expect(connection.account.address).toBe(signer.address); expect(mock.request).not.toHaveBeenCalled(); connection.detach?.();
    const other = wc(), pending = connectWalletConnect("a".repeat(32), 1, new AbortController().signal, vi.fn(), vi.fn(), other.getClient);
    other.gate.resolve(session()); const otherConnection = await pending;
    await expect(otherConnection.authorizeArc({ ...intent(), payer: first })).rejects.toThrow("Arc Mainnet");
    await expect(otherConnection.signIn(loginMessage())).rejects.toThrow("Arc Mainnet");
    expect(other.request).not.toHaveBeenCalled(); otherConnection.detach?.();
  });
  it.each(["missing", "account", "expiry"])("rejects a valid late signature when the fresh session becomes %s during approval", async change => {
    const { mock, changed, live, connection } = await approvedWallet(), gate = deferred<unknown>(), payment = intent();
    mock.request.mockReturnValueOnce(gate.promise);
    const pending = connection.authorizeArc(payment), rejected = expect(pending).rejects.toThrow(WalletSessionUnavailableError);
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalled());
    if (change === "missing") mock.sessions.clear();
    if (change === "account") live.namespaces.eip155.accounts = [`eip155:5042:${second}`];
    if (change === "expiry") live.expiry = 0;
    changed.mockClear(); gate.resolve(await signer.signTypedData(receiveData(payment))); await rejected;
    expect(changed).toHaveBeenCalledExactlyOnceWith(...(change === "account" ? [null, "identity"] : [null])); expect(mock.listeners.size).toBe(0);
  });
  it.each(["session_delete", "session_expire", "session_update", "session_event"])("immediately rejects pending approval on %s and consumes a late SDK failure", async event => {
    const { mock, changed, connection } = await approvedWallet(), gate = deferred<unknown>();
    mock.request.mockReturnValueOnce(gate.promise);
    const pending = connection.authorizeArc(intent()), rejected = expect(pending).rejects.toThrow(WalletSessionUnavailableError);
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalled());
    changed.mockClear(); const listener = mock.listeners.get(event)!;
    listener({ topic: "other" }); expect(changed).not.toHaveBeenCalled();
    listener({ topic: "topic", ...(event === "session_update" ? { params: { namespaces: { eip155: { accounts: [`eip155:5042:${second}`], methods: ["eth_signTypedData_v4", "personal_sign"] } } } } : event === "session_event" ? { params: { chainId: "eip155:5042", event: { name: "accountsChanged", data: [second] } } } : {}) }); await rejected;
    expect(changed).toHaveBeenCalledExactlyOnceWith(...(event === "session_update" || event === "session_event" ? [null, "identity"] : [null])); expect(mock.listeners.size).toBe(0);
    listener({ topic: "topic" }); expect(changed).toHaveBeenCalledTimes(1);
    gate.reject(Error("There is no existing session matching the topic")); await Promise.resolve(); await Promise.resolve();
    expect(mock.request).toHaveBeenCalledTimes(1);
  });
  it.each(["session_update", "session_event"])("keeps the connection and pending approval active on a benign %s with the same identity and capabilities", async event => {
    const { mock, changed, live, connection } = await approvedWallet(), gate = deferred<unknown>(), payment = intent();
    mock.request.mockReturnValueOnce(gate.promise);
    const pending = connection.authorizeArc(payment);
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalled()); changed.mockClear();
    const renewed = { ...live, expiry: live.expiry + 60, namespaces: { eip155: { ...live.namespaces.eip155, methods: [...live.namespaces.eip155.methods].reverse() } } };
    mock.sessions.set("topic", renewed);
    mock.listeners.get(event)?.({ topic: "topic", params: event === "session_update" ? { namespaces: renewed.namespaces } : { chainId: "eip155:5042", event: { name: "accountsChanged", data: [signer.address] } } });
    expect(changed).not.toHaveBeenCalled(); expect(mock.disconnect).not.toHaveBeenCalled();
    expect(() => connection.assertActive?.()).not.toThrow(); expect(mock.listeners.size).toBe(5);
    gate.resolve(await signer.signTypedData(receiveData(payment))); await expect(pending).resolves.toMatchObject({ from: signer.address });
    connection.detach?.();
  });
  it.each(["account", "chain", "capability", "invalid"])("marks a proposed %s approval change as identity loss even before the SDK store updates", async change => {
    const { mock, changed, live } = await approvedWallet(); changed.mockClear();
    const namespaces = structuredClone(live.namespaces);
    if (change === "account") namespaces.eip155.accounts = [`eip155:5042:${second}`];
    if (change === "chain") namespaces.eip155.accounts = [`eip155:1:${signer.address}`];
    if (change === "capability") namespaces.eip155.methods = ["eth_signTypedData_v4"];
    mock.listeners.get("session_update")?.({ topic: "topic", params: { namespaces: change === "invalid" ? {} : namespaces } });
    expect(changed).toHaveBeenCalledExactlyOnceWith(null, "identity"); expect(mock.listeners.size).toBe(0);
  });
  it("preserves recovery when a WalletConnect account event reports a locked wallet", async () => {
    const { mock, changed } = await approvedWallet(); changed.mockClear();
    mock.listeners.get("session_event")?.({ topic: "topic", params: { chainId: "eip155:5042", event: { name: "accountsChanged", data: [] } } });
    expect(changed).toHaveBeenCalledExactlyOnceWith(null); expect(mock.listeners.size).toBe(0);
  });
  it("expires the connection without requiring another user action", async () => {
    vi.useFakeTimers();
    const { mock, changed, live, connection } = await approvedWallet(); changed.mockClear();
    await vi.advanceTimersByTimeAsync(live.expiry * 1000 - Date.now());
    expect(changed).toHaveBeenCalledExactlyOnceWith(null); expect(mock.listeners.size).toBe(0);
    expect(() => connection.assertActive?.()).toThrow(WalletSessionUnavailableError);
  });
  it("consumes SDK cleanup failures on explicit disconnect and approval changes", async () => {
    const { mock, changed, connection } = await approvedWallet();
    mock.disconnect.mockRejectedValue(Error("No matching key. session topic doesn't exist: topic")); changed.mockClear();
    await expect(connection.disconnect()).resolves.toBeUndefined();
    expect(changed).toHaveBeenCalledExactlyOnceWith(null); expect(mock.listeners.size).toBe(0);
    const updated = await approvedWallet(); updated.mock.disconnect.mockRejectedValue(Error("Topic deleted"));
    updated.live.namespaces.eip155.accounts = [`eip155:5042:${second}`];
    updated.mock.listeners.get("session_update")?.({ topic: "topic" }); await Promise.resolve();
    expect(updated.mock.listeners.size).toBe(0);
  });
  it("requires explicit reconnect and accepts a new session for the same wallet without retrying the failed signature", async () => {
    const lost = await approvedWallet();
    lost.mock.request.mockRejectedValueOnce(Error("There is no existing session matching the topic"));
    await expect(lost.connection.authorizeArc(intent())).rejects.toThrow(WalletSessionUnavailableError);
    const reconnected = await approvedWallet(arcSession("new-topic")), payment = intent();
    reconnected.mock.request.mockResolvedValueOnce(await signer.signTypedData(receiveData(payment)));
    await expect(reconnected.connection.authorizeArc(payment)).resolves.toMatchObject({ from: signer.address });
    expect(lost.mock.connect).toHaveBeenCalledTimes(1); expect(lost.mock.request).toHaveBeenCalledTimes(1);
    expect(reconnected.mock.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ topic: "new-topic", chainId: "eip155:5042" }));
    reconnected.connection.detach?.();
  });
  it("detaches pending approvals without disconnecting the reusable session or notifying the UI", async () => {
    const { mock, changed, connection } = await approvedWallet(), gate = deferred<unknown>();
    mock.request.mockReturnValueOnce(gate.promise);
    const pending = connection.authorizeArc(intent()), rejected = expect(pending).rejects.toThrow(WalletSessionUnavailableError);
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalled()); changed.mockClear(); connection.detach?.(); await rejected;
    gate.reject(Error("late rejection")); await Promise.resolve(); await Promise.resolve();
    expect(mock.disconnect).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); expect(mock.listeners.size).toBe(0);
  });
  it("restores an approved session without a new pairing and preserves it on detach", async () => {
    const mock = wc(), live = session(), client = await mock.getClient();
    Object.assign(client, { session: { get: vi.fn(() => live) } });
    const connection = await connectWalletConnect("a".repeat(32), 1, new AbortController().signal, vi.fn(), vi.fn(), async () => client, { topic: live.topic, address: first });
    expect(mock.connect).not.toHaveBeenCalled();
    expect(connection.account.address).toBe(first);
    connection.detach?.(); expect(mock.disconnect).not.toHaveBeenCalled(); expect(mock.listeners.size).toBe(0);
    const restored = await connectWalletConnect("a".repeat(32), 1, new AbortController().signal, vi.fn(), vi.fn(), async () => client, { topic: live.topic, address: first });
    await restored.disconnect(); expect(mock.disconnect).toHaveBeenCalledTimes(1);
  });
  it("rejects expired or different saved WalletConnect identities without starting a pairing", async () => {
    const mock = wc(), live = session(), client = await mock.getClient();
    Object.assign(client, { session: { get: () => live } });
    await expect(connectWalletConnect("a".repeat(32), 1, new AbortController().signal, vi.fn(), vi.fn(), async () => client, { topic: live.topic, address: second })).rejects.toThrow();
    live.expiry = 0;
    await expect(connectWalletConnect("a".repeat(32), 1, new AbortController().signal, vi.fn(), vi.fn(), async () => client, { topic: live.topic, address: first })).rejects.toThrow();
    expect(mock.connect).not.toHaveBeenCalled(); expect(mock.disconnect).toHaveBeenCalledTimes(2);
    expect(mock.disconnect.mock.calls.every(([args]) => args.topic === live.topic)).toBe(true);
  });
  it.each(["missing", "capability"])("retires a positively %s local restore and leaves unrelated approvals untouched", async kind => {
    const mock = wc(), live = arcSession(); mock.sessions.set("unrelated", arcSession("unrelated"));
    if (kind === "capability") { live.namespaces.eip155.methods = ["personal_sign"]; mock.sessions.set(live.topic, live); }
    await expect(connectWalletConnect("a".repeat(32), 5042, new AbortController().signal, vi.fn(), vi.fn(), mock.getClient,
      { topic: live.topic, address: signer.address })).rejects.toThrow();
    expect(mock.connect).not.toHaveBeenCalled(); expect(mock.ping).not.toHaveBeenCalled(); expect(mock.request).not.toHaveBeenCalled();
    expect(mock.disconnect).toHaveBeenCalledExactlyOnceWith({ topic: live.topic, reason: { code: 6000, message: "User disconnected" } });
    expect(mock.sessions.has("unrelated")).toBe(true); expect(mock.pairingDisconnect).not.toHaveBeenCalled();
  });
  it("does not retire a valid local session when restoration is cancelled during its lookup", async () => {
    const mock = wc(), live = arcSession(), abort = new AbortController(); mock.sessions.set(live.topic, live);
    mock.get.mockImplementationOnce(() => { abort.abort(); return live; });
    await expect(connectWalletConnect("a".repeat(32), 5042, abort.signal, vi.fn(), vi.fn(), mock.getClient,
      { topic: live.topic, address: signer.address })).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.sessions.has(live.topic)).toBe(true); expect(mock.disconnect).not.toHaveBeenCalled(); expect(mock.ping).not.toHaveBeenCalled();
  });
  it("requests only the connection scope and disconnects when account approval changes", async () => {
    const mock = wc(), changed = vi.fn();
    const pending = connectWalletConnect("a".repeat(32), 1, new AbortController().signal, vi.fn(), changed, mock.getClient);
    mock.gate.resolve(session());
    const connection = await pending;
    expect(connection.account.address).toBe(first);
    expect(mock.connect).toHaveBeenCalledWith({ requiredNamespaces: { eip155: { chains: ["eip155:1"], methods: ["eth_signTypedData_v4", "personal_sign"], events: ["accountsChanged", "chainChanged"] } } });
    mock.sessions.get("topic")!.namespaces.eip155.accounts = [`eip155:1:${second}`];
    mock.listeners.get("session_update")?.({ topic: "topic" });
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(null, "identity"));
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

describe("WalletConnect peer liveness before signing", () => {
  it("reschedules only its own extended session expiry without signing or dropping a valid approval", async () => {
    vi.useFakeTimers(); const { mock, changed, live, connection } = await approvedWallet(); changed.mockClear();
    live.expiry += 600; mock.listeners.get("session_extend")?.({ topic: "unrelated" });
    mock.listeners.get("session_extend")?.({ topic: "topic" }); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000); expect(() => connection.assertActive?.()).not.toThrow();
    expect(changed).not.toHaveBeenCalled(); expect(mock.request).not.toHaveBeenCalled(); expect(mock.ping).not.toHaveBeenCalled();
    connection.detach?.(); expect(mock.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps a restored local session saved until a non-signing peer response, then requests just one signature", async () => {
    vi.stubGlobal("location", { origin: "https://enclaveagent.tech" });
    const { mock, changed, connection } = await restoredWallet(), gate = deferred<void>(), states = vi.fn(), message = loginMessage();
    mock.ping.mockReturnValueOnce(gate.promise); mock.request.mockResolvedValueOnce(await signer.signMessage({ message }));
    connection.onPeerState?.(states);
    expect(connection.peerState).toBe("saved"); expect(mock.ping).not.toHaveBeenCalled(); expect(mock.connect).not.toHaveBeenCalled();
    const pending = connection.signIn(message);
    await vi.waitFor(() => expect(mock.ping).toHaveBeenCalledExactlyOnceWith({ topic: "topic" }));
    expect(connection.peerState).toBe("checking"); expect(mock.request).not.toHaveBeenCalled();
    gate.resolve(); await expect(pending).resolves.toMatch(/^0x/);
    expect(states.mock.calls).toEqual([["checking"], ["responsive"]]); expect(changed).not.toHaveBeenCalled();
    expect(mock.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ topic: "topic", request: expect.objectContaining({ method: "personal_sign" }) }));
    connection.detach?.();
  });

  it("does not ping a fresh QR approval, but checks an idle topic before its next payment signature", async () => {
    vi.useFakeTimers(); vi.stubGlobal("location", { origin: "https://enclaveagent.tech" });
    const { mock, connection } = await approvedWallet(), message = loginMessage();
    mock.request.mockResolvedValueOnce(await signer.signMessage({ message }));
    await connection.signIn(message); expect(mock.ping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    const payment = intent(); mock.request.mockResolvedValueOnce(await signer.signTypedData(receiveData(payment)));
    await connection.authorizeArc(payment);
    expect(mock.ping).toHaveBeenCalledExactlyOnceWith({ topic: "topic" }); expect(mock.request).toHaveBeenCalledTimes(2); connection.detach?.();
  });

  it("bounds a silent saved peer at twelve seconds without signing, forgetting approval or notifying identity loss", async () => {
    vi.useFakeTimers(); vi.stubGlobal("location", { origin: "https://enclaveagent.tech" });
    const { mock, changed, connection } = await restoredWallet(), gate = deferred<void>(); mock.ping.mockReturnValueOnce(gate.promise);
    const pending = connection.signIn(loginMessage()), rejected = expect(pending).rejects.toThrow(WalletPeerUnavailableError);
    await vi.advanceTimersByTimeAsync(11_999); expect(mock.request).not.toHaveBeenCalled(); expect(connection.peerState).toBe("checking");
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(connection.peerState).toBe("unconfirmed"); expect(() => connection.assertActive?.()).not.toThrow();
    expect(mock.sessions.has("topic")).toBe(true); expect(mock.disconnect).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
    gate.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(connection.peerState).toBe("responsive"); expect(mock.request).not.toHaveBeenCalled(); // A late ACK cannot revive the cancelled sign-in.
    const message = loginMessage(); mock.request.mockResolvedValueOnce(await signer.signMessage({ message }));
    await connection.signIn(message); expect(mock.ping).toHaveBeenCalledTimes(1); expect(mock.request).toHaveBeenCalledTimes(1); connection.detach?.();
  });

  it.each(["offline", "request-expired"])("preserves a valid local topic after a %s ping rejection and allows an explicit retry", async kind => {
    const { mock, changed, connection } = await restoredWallet();
    mock.ping.mockRejectedValueOnce(kind === "offline" ? Error("Relay unavailable") : { code: 8000, message: "Session request expired" });
    await expect(connection.checkPeer?.()).rejects.toThrow(WalletPeerUnavailableError);
    expect(connection.peerState).toBe("unconfirmed"); expect(mock.disconnect).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); expect(mock.request).not.toHaveBeenCalled();
    await connection.checkPeer?.(); expect(connection.peerState).toBe("responsive"); expect(mock.ping).toHaveBeenCalledTimes(2); connection.detach?.();
  });

  it.each([
    { error: { code: -32000, message: "There is no existing session matching the topic" } },
    { cause: { data: { message: "No matching key. keychain topic not found" } } },
  ])("retires only a definitely rejected old topic before either login or payment is signed", async cause => {
    const { mock, changed, connection } = await restoredWallet(), cleanup = deferred<void>();
    mock.sessions.set("unrelated", arcSession("unrelated")); mock.disconnect.mockReturnValueOnce(cleanup.promise); mock.ping.mockRejectedValueOnce(cause);
    await expect(connection.authorizeArc(intent())).rejects.toMatchObject({ code: "WALLET_SESSION_UNAVAILABLE", reason: "missing" });
    expect(mock.request).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledExactlyOnceWith(null);
    expect(mock.disconnect).toHaveBeenCalledExactlyOnceWith({ topic: "topic", reason: { code: 6000, message: "User disconnected" } });
    expect(mock.sessions.has("unrelated")).toBe(true); expect(mock.pairingDisconnect).not.toHaveBeenCalled(); cleanup.resolve();
  });

  it("shares one SDK ping across callers and never signs after their cancellation or after replacement", async () => {
    vi.stubGlobal("location", { origin: "https://enclaveagent.tech" });
    const { mock, changed, connection } = await restoredWallet(), gate = deferred<void>(), abort = new AbortController(), states = vi.fn();
    mock.ping.mockReturnValueOnce(gate.promise); connection.onPeerState?.(states);
    const login = connection.signIn(loginMessage(), abort.signal), rejected = expect(login).rejects.toMatchObject({ name: "AbortError" });
    const check = connection.checkPeer?.(), cancelled = expect(check).rejects.toThrow(WalletSessionUnavailableError);
    await vi.waitFor(() => expect(mock.ping).toHaveBeenCalledTimes(1)); abort.abort(); await rejected;
    connection.detach?.(); await cancelled; const notifications = states.mock.calls.length;
    const replacement = await approvedWallet(arcSession("replacement")); gate.reject(Error("There is no existing session matching the topic"));
    await Promise.resolve(); await Promise.resolve();
    expect(states).toHaveBeenCalledTimes(notifications); expect(changed).not.toHaveBeenCalled(); expect(mock.request).not.toHaveBeenCalled(); expect(mock.disconnect).not.toHaveBeenCalled();
    expect(() => replacement.connection.assertActive?.()).not.toThrow(); replacement.connection.detach?.();
  });

  it.each(["session_delete", "session_expire"])("cancels a pending peer check immediately on %s and ignores its late ACK", async event => {
    const { mock, changed, connection } = await restoredWallet(), gate = deferred<void>(); mock.ping.mockReturnValueOnce(gate.promise);
    const pending = connection.authorizeArc(intent()), rejected = expect(pending).rejects.toThrow(WalletSessionUnavailableError);
    await vi.waitFor(() => expect(mock.ping).toHaveBeenCalledTimes(1)); mock.listeners.get(event)?.({ topic: "topic" }); await rejected;
    gate.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(mock.request).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledExactlyOnceWith(null); expect(mock.disconnect).toHaveBeenCalledTimes(1); expect(mock.listeners.size).toBe(0);
  });

  it("does not treat a positive ping as permission proof when the actual signing request rejects its topic", async () => {
    const { mock, changed, connection } = await restoredWallet();
    mock.request.mockRejectedValueOnce({ error: { message: "There is no existing session matching the topic" } });
    await expect(connection.authorizeArc(intent())).rejects.toMatchObject({ reason: "missing" });
    expect(mock.ping).toHaveBeenCalledTimes(1); expect(mock.request).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledExactlyOnceWith(null);
    expect(mock.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("Arc network switching", () => {
  it("adds an unknown Arc chain with 18-decimal native USDC, then verifies the switch", async () => {
    const mock = browser();
    mock.request.mockRejectedValueOnce({ code: 4902 }).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce("0x13b2");
    await switchBrowserToArc(mock.wallet.provider);
    expect(mock.request.mock.calls.map(([args]) => args.method)).toEqual(["wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain", "eth_chainId"]);
    expect(mock.request).toHaveBeenNthCalledWith(2, { method: "wallet_addEthereumChain", params: [{ chainId: "0x13b2", chainName: "Arc Mainnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: ["https://rpc.mainnet.arc.io"], blockExplorerUrls: ["https://explorer.arc.io"] }] });
  });
  it("does not add a chain after a user rejection", async () => {
    const mock = browser(); mock.request.mockRejectedValueOnce({ code: 4001 });
    await expect(switchBrowserToArc(mock.wallet.provider)).rejects.toMatchObject({ code: 4001 });
    expect(mock.request).toHaveBeenCalledTimes(1);
  });
  it("rejects testnet or another chain despite a successful switch response", async () => {
    const mock = browser(); mock.request.mockResolvedValueOnce(null).mockResolvedValueOnce("0x4cef52");
    await expect(switchBrowserToArc(mock.wallet.provider)).rejects.toThrow("did not switch");
  });
  it("stops subsequent wallet prompts if the account changes during network approval", async () => {
    const mock = browser(); let current = true;
    mock.request.mockImplementationOnce(async () => { current = false; throw { code: 4902 }; });
    await expect(switchBrowserToArc(mock.wallet.provider, () => current)).rejects.toThrow("connection changed");
    expect(mock.request).toHaveBeenCalledTimes(1);
  });
});

describe("bounded wallet sign-in approval", () => {
  async function loginBrowser() {
    const mock = browser(), changed = vi.fn();
    mock.state.accounts = [signer.address]; mock.state.chain = "0x13b2";
    const connection = await connectBrowserWallet(mock.wallet, new AbortController().signal, changed);
    changed.mockClear();
    return { mock, changed, connection };
  }
  function longSession() { const live = arcSession(); live.expiry = Math.floor(Date.now() / 1000) + 600; return live; }
  function signInLocation() { vi.stubGlobal("location", { origin: "https://enclaveagent.tech" }); }

  it.each(["session_delete", "session_expire", "session_update", "session_event", "disconnect", "detach"])("cancels hung WalletConnect login immediately on %s without waiting for the wallet", async event => {
    signInLocation();
    const { mock, changed, connection } = await approvedWallet(longSession()), gate = deferred<unknown>();
    mock.request.mockReturnValueOnce(gate.promise);
    const pending = connection.signIn(loginMessage()), rejected = expect(pending).rejects.toThrow(WalletSessionUnavailableError);
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalledTimes(1)); changed.mockClear();
    if (event === "disconnect") await connection.disconnect();
    else if (event === "detach") connection.detach?.();
    else mock.listeners.get(event)?.({ topic: "topic", ...(event === "session_update"
      ? { params: { namespaces: { eip155: { accounts: [`eip155:5042:${second}`], methods: ["eth_signTypedData_v4", "personal_sign"] } } } }
      : event === "session_event" ? { params: { chainId: "eip155:5042", event: { name: "chainChanged", data: "0x1" } } } : {}) });
    await rejected;
    expect(mock.listeners.size).toBe(0);
    expect(changed).toHaveBeenCalledTimes(event === "detach" ? 0 : 1);
    const notifications = changed.mock.calls.length;
    gate.reject(Error("There is no existing session matching the topic"));
    await Promise.resolve(); await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(notifications); expect(mock.request).toHaveBeenCalledTimes(1);
  });

  it("times out a hung WalletConnect personal_sign at 60 seconds without deleting a slow wallet's approval", async () => {
    vi.useFakeTimers(); signInLocation();
    const { mock, changed, connection } = await approvedWallet(longSession()), gate = deferred<unknown>();
    mock.request.mockReturnValueOnce(gate.promise); changed.mockClear();
    const pending = connection.signIn(loginMessage()), rejected = expect(pending).rejects.toMatchObject({ code: "WALLET_PEER_UNAVAILABLE", reason: "timeout" });
    await vi.advanceTimersByTimeAsync(0); expect(mock.request).toHaveBeenCalledTimes(1);
    let completed = false; void pending.then(() => { completed = true; }, () => { completed = true; });
    await vi.advanceTimersByTimeAsync(59_999); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(changed).not.toHaveBeenCalled(); expect(mock.disconnect).not.toHaveBeenCalled();
    expect(connection.peerState).toBe("unconfirmed"); expect(() => connection.assertActive?.()).not.toThrow();
    expect(mock.listeners.size).toBe(5); expect(vi.getTimerCount()).toBe(1);
    gate.resolve(await signer.signMessage({ message: loginMessage() })); await Promise.resolve(); await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    const message = loginMessage(); mock.request.mockResolvedValueOnce(await signer.signMessage({ message }));
    await expect(connection.signIn(message)).resolves.toMatch(/^0x/);
    expect(mock.ping).toHaveBeenCalledExactlyOnceWith({ topic: "topic" }); expect(mock.request).toHaveBeenCalledTimes(2);
    connection.detach?.(); expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes a late missing-topic failure after cancellation without invalidating a later explicit login", async () => {
    signInLocation();
    const { mock, changed, connection } = await approvedWallet(longSession()), gate = deferred<unknown>(), cancel = new AbortController();
    mock.request.mockReturnValueOnce(gate.promise); changed.mockClear();
    const pending = connection.signIn(loginMessage(), cancel.signal), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalledTimes(1)); cancel.abort(); await rejected;
    expect(changed).not.toHaveBeenCalled(); expect(mock.disconnect).not.toHaveBeenCalled();
    const message = loginMessage(); mock.request.mockResolvedValueOnce(await signer.signMessage({ message }));
    await expect(connection.signIn(message)).resolves.toMatch(/^0x/);
    gate.reject(Error("There is no existing session matching the topic")); await Promise.resolve(); await Promise.resolve();
    expect(() => connection.assertActive?.()).not.toThrow(); expect(changed).not.toHaveBeenCalled();
    expect(mock.request).toHaveBeenCalledTimes(2); expect(mock.disconnect).not.toHaveBeenCalled(); connection.detach?.();
  });

  it("cancels the caller's earlier whole-flow timeout without retiring the approved WalletConnect topic", async () => {
    signInLocation();
    const { mock, changed, connection } = await approvedWallet(longSession()), gate = deferred<unknown>(), cancel = new AbortController();
    mock.request.mockReturnValueOnce(gate.promise); changed.mockClear();
    const pending = connection.signIn(loginMessage(), cancel.signal), rejected = expect(pending).rejects.toMatchObject({ reason: "timeout" });
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalledTimes(1));
    cancel.abort(new DOMException("Login timed out", "TimeoutError")); await rejected;
    expect(changed).not.toHaveBeenCalled(); expect(mock.disconnect).not.toHaveBeenCalled();
    expect(connection.peerState).toBe("unconfirmed"); expect(() => connection.assertActive?.()).not.toThrow();
    gate.reject(Error("late SDK failure")); await Promise.resolve(); await Promise.resolve();
    expect(mock.request).toHaveBeenCalledTimes(1); expect(mock.disconnect).not.toHaveBeenCalled(); connection.detach?.();
  });

  it("does not request a signature or invalidate an approved session for a pre-cancelled login", async () => {
    signInLocation();
    const { mock, changed, connection } = await approvedWallet(longSession()), cancel = new AbortController();
    changed.mockClear(); cancel.abort();
    await expect(connection.signIn(loginMessage(), cancel.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.request).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
    expect(() => connection.assertActive?.()).not.toThrow(); connection.detach?.();
  });

  it("clears the login timeout after a valid WalletConnect approval", async () => {
    vi.useFakeTimers(); signInLocation();
    const { mock, changed, connection } = await approvedWallet(longSession()), message = loginMessage();
    mock.request.mockResolvedValueOnce(await signer.signMessage({ message })); changed.mockClear();
    await expect(connection.signIn(message)).resolves.toMatch(/^0x/);
    expect(vi.getTimerCount()).toBe(1); // Only the live protocol-session expiry remains.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(() => connection.assertActive?.()).not.toThrow(); expect(changed).not.toHaveBeenCalled(); connection.detach?.();
  });

  it.each(["account", "network", "disconnect", "detach"])("cancels a hung browser login immediately on %s and discards a valid late signature", async event => {
    signInLocation();
    const { mock, changed, connection } = await loginBrowser(), gate = deferred<unknown>(), message = loginMessage();
    mock.request.mockImplementation(async ({ method }) => method === "personal_sign" ? gate.promise : method === "eth_chainId" ? mock.state.chain : mock.state.accounts);
    const pending = connection.signIn(message), rejected = expect(pending).rejects.toThrow(WalletSessionUnavailableError);
    await vi.waitFor(() => expect(mock.request.mock.calls.some(([args]) => args.method === "personal_sign")).toBe(true));
    if (event === "account") { mock.state.accounts = [second]; mock.listeners.get("accountsChanged")?.([second]); }
    if (event === "network") { mock.state.chain = "0x1"; mock.listeners.get("chainChanged")?.("0x1"); }
    if (event === "disconnect") await connection.disconnect();
    if (event === "detach") connection.detach?.();
    await rejected; await Promise.resolve(); await Promise.resolve();
    const notifications = changed.mock.calls.length, requests = mock.request.mock.calls.length;
    gate.resolve(await signer.signMessage({ message })); await Promise.resolve(); await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(notifications); expect(mock.request).toHaveBeenCalledTimes(requests);
    connection.detach?.();
  });

  it("bounds hanging browser account reads before signing and consumes their late response", async () => {
    signInLocation();
    const { mock, changed, connection } = await loginBrowser(), gate = deferred<unknown>(), cancel = new AbortController();
    mock.request.mockImplementation(async ({ method }) => method === "eth_accounts" ? gate.promise : mock.state.chain);
    const pending = connection.signIn(loginMessage(), cancel.signal), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve(); cancel.abort(); await rejected;
    gate.resolve([signer.address]); await Promise.resolve(); await Promise.resolve();
    expect(mock.request.mock.calls.some(([args]) => args.method === "personal_sign")).toBe(false);
    expect(changed).not.toHaveBeenCalled(); connection.detach?.();
  });

  it("bounds a hung browser signature and clears listeners without signing again", async () => {
    vi.useFakeTimers(); signInLocation();
    const { mock, changed, connection } = await loginBrowser(), gate = deferred<unknown>(), start = Date.now();
    mock.request.mockImplementation(async ({ method }) => method === "personal_sign" ? gate.promise : method === "eth_chainId" ? mock.state.chain : mock.state.accounts);
    const pending = connection.signIn(loginMessage()), rejected = expect(pending).rejects.toMatchObject({ reason: "timeout" });
    await vi.waitFor(() => expect(mock.request.mock.calls.some(([args]) => args.method === "personal_sign")).toBe(true));
    await vi.advanceTimersByTimeAsync(60_000 - (Date.now() - start)); await rejected;
    expect(changed).toHaveBeenCalledExactlyOnceWith(null); expect(mock.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(mock.request.mock.calls.filter(([args]) => args.method === "personal_sign")).toHaveLength(1);
    gate.reject(Error("late browser request failure")); await Promise.resolve(); await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
