import { z } from "zod";
import type SignClient from "@walletconnect/sign-client";
import type { BrowserWallet } from "./wallets";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const addresses = z.array(address).max(100);
export type WalletAccount = { address: string; chainId: number; name: string; transport: "browser" | "walletconnect" };
export type WalletConnection = { account: WalletAccount; disconnect: () => Promise<void> };
export type AccountListener = (account: WalletAccount | null) => void;
const abortError = () => new DOMException("Connection cancelled", "AbortError");
export function parseChainId(value: unknown): number {
  const parsed = z.union([z.number(), z.string().regex(/^(0x[0-9a-f]+|[1-9][0-9]*)$/i)]).parse(value);
  const id = Number(parsed);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid chain ID");
  return id;
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function connectBrowserWallet(wallet: BrowserWallet, signal: AbortSignal, changed: AccountListener): Promise<WalletConnection> {
  if (signal.aborted) throw abortError();
  const { provider } = wallet;
  await abortable(provider.request({ method: "eth_requestAccounts" }), signal);
  let active = true, revision = 0;
  let account: WalletAccount | null = null;
  const stop = () => {
    if (!active) return;
    active = false; revision++;
    provider.removeListener("accountsChanged", refreshEvent);
    provider.removeListener("chainChanged", refreshEvent);
    provider.removeListener("disconnect", disconnected);
  };
  const disconnected = () => { stop(); changed(null); };
  async function refresh() {
    const current = ++revision;
    const [rawAccounts, rawChain] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
    if (!active || current !== revision) return;
    const selected = addresses.parse(rawAccounts)[0];
    if (!selected) { disconnected(); return; }
    account = { address: selected, chainId: parseChainId(rawChain), name: wallet.name, transport: "browser" };
    changed(account);
  }
  function refreshEvent() { void refresh().catch(disconnected); }
  provider.on("accountsChanged", refreshEvent);
  provider.on("chainChanged", refreshEvent);
  provider.on("disconnect", disconnected);
  signal.addEventListener("abort", stop, { once: true });
  try {
    await abortable(refresh(), signal);
    if (signal.aborted) throw abortError();
    if (!account) throw new Error("Wallet has no available account");
    return { account, disconnect: async () => { stop(); changed(null); } };
  } catch (error) { stop(); throw error; }
  finally { signal.removeEventListener("abort", stop); }
}

let clientPromise: Promise<SignClient> | undefined;
async function loadClient(projectId: string): Promise<SignClient> {
  if (!/^[a-f0-9]{32}$/i.test(projectId)) throw new Error("WalletConnect project ID missing");
  clientPromise ??= import("@walletconnect/sign-client").then(({ default: Client }) => Client.init({
    projectId, logger: "silent", telemetryEnabled: false, customStoragePrefix: "enclave-wallet",
    metadata: { name: "Enclave", description: "Inference receipts and verification", url: "https://enclaveagent.tech", icons: ["https://enclaveagent.tech/assets/enclave-logo.png"] },
  })).catch(error => { clientPromise = undefined; throw error; });
  return clientPromise;
}

export function accountFromSession(session: unknown, chainId: number): WalletAccount {
  const parsed = z.object({ expiry: z.number(), peer: z.object({ metadata: z.object({ name: z.string().min(1).max(80) }) }),
    namespaces: z.record(z.object({ accounts: z.array(z.string()), methods: z.array(z.string()) })) }).parse(session);
  if (parsed.expiry <= Date.now() / 1000) throw new Error("Wallet session expired");
  const namespace = parsed.namespaces["eip155"] ?? parsed.namespaces[`eip155:${chainId}`];
  const selected = namespace?.accounts.find(value => value.startsWith(`eip155:${chainId}:`));
  if (!selected || !namespace?.methods.includes("eth_signTypedData_v4")) throw new Error("Required wallet capabilities not approved");
  return { address: address.parse(selected.split(":")[2]), chainId, name: parsed.peer.metadata.name, transport: "walletconnect" };
}

export async function connectWalletConnect(projectId: string, chainId: number, signal: AbortSignal, showUri: (uri: string) => void, changed: AccountListener,
  getClient: (id: string) => Promise<SignClient> = loadClient): Promise<WalletConnection> {
  if (signal.aborted) throw abortError();
  parseChainId(chainId);
  const client = await abortable(getClient(projectId), signal);
  if (signal.aborted) throw abortError();
  const proposal = await client.connect({ requiredNamespaces: { eip155: { chains: [`eip155:${chainId}`], methods: ["eth_signTypedData_v4"], events: ["accountsChanged", "chainChanged"] } } });
  const reason = { code: 6000, message: "User disconnected" };
  let acceptedTopic: string | undefined;
  const cancelPairing = () => {
    const topic = proposal.uri?.match(/^wc:([a-f0-9]{64})@2\?/i)?.[1];
    if (topic) void client.core.pairing.disconnect({ topic }).catch(() => {});
  };
  // Approval may arrive after Escape/unmount. Close that session instead of reconnecting the UI.
  const approval = proposal.approval().then(async session => {
    if (signal.aborted) { await client.disconnect({ topic: session.topic, reason }).catch(() => {}); throw abortError(); }
    acceptedTopic = session.topic;
    return session;
  });
  signal.addEventListener("abort", cancelPairing, { once: true });
  try {
    if (signal.aborted) { cancelPairing(); throw abortError(); }
    if (proposal.uri) showUri(proposal.uri);
    const session = await abortable(approval, signal);
    const account = accountFromSession(session, chainId);
    if (signal.aborted) throw abortError();
    let active = true;
    const cleanup = () => {
      active = false;
      clearTimeout(expiryTimer);
      client.off("session_delete", dropped); client.off("session_expire", dropped);
      client.off("session_update", updated); client.off("session_event", updated);
    };
    const disconnect = async () => {
      if (!active) return;
      cleanup(); changed(null);
      await client.disconnect({ topic: session.topic, reason });
    };
    const dropped = (event: { topic: string }) => { if (active && event.topic === session.topic) { cleanup(); changed(null); } };
    // A changed approval needs an explicit reconnection; never keep a stale payment identity.
    const updated = (event: { topic: string }) => { if (active && event.topic === session.topic) void disconnect().catch(() => {}); };
    const expiryTimer = setTimeout(() => { void disconnect().catch(() => {}); }, Math.min(2_147_483_647, Math.max(0, session.expiry * 1000 - Date.now())));
    client.on("session_delete", dropped); client.on("session_expire", dropped);
    client.on("session_update", updated); client.on("session_event", updated);
    changed(account);
    return { account, disconnect };
  } catch (error) {
    cancelPairing();
    if (acceptedTopic) await client.disconnect({ topic: acceptedTopic, reason }).catch(() => {});
    // Always consume eventual rejection even when cancelled before awaiting approval.
    void approval.catch(() => {});
    throw error;
  } finally { signal.removeEventListener("abort", cancelPairing); }
}
