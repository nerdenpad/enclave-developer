import { afterEach, describe, expect, it, vi } from "vitest";
import type SignClient from "@walletconnect/sign-client";
import { accountFromSession, connectBrowserWallet, connectWalletConnect, parseChainId, switchBrowserToArc, WalletSessionUnavailableError } from "./wallet-session";
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
  const request = vi.fn<({ topic, chainId, request }: { topic: string; chainId: string; request: { method: string; params: unknown[] } }) => Promise<unknown>>().mockResolvedValue(undefined);
  const connect = vi.fn().mockResolvedValue({ uri: `wc:${"a".repeat(64)}@2?symKey=test`, approval: () => gate.promise.then(value => { sessions.set(value.topic, value); return value; }) });
  const get = vi.fn((topic: string) => { const value = sessions.get(topic); if (!value) throw Error(`No matching key. session topic doesn't exist: ${topic}`); return value; });
  const client = { connect, disconnect, request, session: { get }, core: { pairing: { disconnect: pairingDisconnect } }, on: (event: string, fn: (value: SessionEvent) => void) => listeners.set(event, fn), off: (event: string) => listeners.delete(event) };
  return { gate, sessions, get, request, listeners, disconnect, pairingDisconnect, connect, getClient: async () => client as unknown as SignClient };
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
    if (change === "account") live.namespaces.eip155.accounts = [`eip155:5042:${second}`];
    if (change === "chain") live.namespaces.eip155.accounts = [`eip155:1:${signer.address}`];
    if (change === "expiry") live.expiry = Math.floor(Date.now() / 1000) - 1;
    if (change === "method") live.namespaces.eip155.methods = ["personal_sign"];
    if (change === "topic") live.topic = "replacement";
    changed.mockClear();
    await expect(connection.authorizeArc(intent())).rejects.toThrow(WalletSessionUnavailableError);
    expect(mock.request).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledExactlyOnceWith(...(change === "expiry" || change === "topic" ? [null] : [null, "identity"]));
    expect(mock.listeners.size).toBe(0);
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
    expect(() => connection.assertActive?.()).not.toThrow(); expect(mock.listeners.size).toBe(4);
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
    expect(mock.connect).not.toHaveBeenCalled(); expect(mock.disconnect).not.toHaveBeenCalled();
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

