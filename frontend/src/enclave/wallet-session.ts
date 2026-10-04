import { z } from "zod";
import { signLoginMessage } from "./wallet-auth";
import type SignClient from "@walletconnect/sign-client";
import type { BrowserWallet } from "./wallets";
import arc from "./arc-mainnet.json";
import { signArcPayment, type ArcPaymentIntent, type ArcAuthorization } from "./arc-payment";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const addresses = z.array(address).max(100);
export type WalletAccount = { address: string; chainId: number; name: string; transport: "browser" | "walletconnect" };
export type WalletConnection = { account: WalletAccount; disconnect: () => Promise<void>; detach?: () => void; topic?: string; switchToArc?: () => Promise<void>; assertActive?: () => void;
  signIn: (message: string, signal?: AbortSignal) => Promise<`0x${string}`>;
  authorizeArc: (intent: ArcPaymentIntent) => Promise<ArcAuthorization> };
export type AccountListener = (account: WalletAccount | null, reason?: "connection" | "identity") => void;
export class WalletSessionUnavailableError extends Error {
  readonly code = "WALLET_SESSION_UNAVAILABLE";
  constructor(readonly reason: "missing" | "expired" | "changed" | "disconnected" | "timeout" = "disconnected") {
    super(reason === "timeout" ? "Wallet sign-in timed out. Reconnect your wallet on Arc Mainnet and try again."
      : `Wallet session ${reason === "changed" ? "changed" : reason === "expired" ? "expired" : "is unavailable"}. Reconnect your wallet on Arc Mainnet.`);
    this.name = "WalletSessionUnavailableError";
  }
}
const abortError = () => new DOMException("Connection cancelled", "AbortError");
const LOGIN_TIMEOUT_MS = 60_000;
type PendingApproval = (error: Error) => void;

/** Cancel locally without publishing or retrying an eventual wallet signature. */
function guardLogin<T>(run: (signal: AbortSignal) => Promise<T>, pending: Set<PendingApproval>,
  signal: AbortSignal | undefined, timedOut: (error: WalletSessionUnavailableError) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const operation = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); pending.delete(cancel); signal?.removeEventListener("abort", aborted); };
    const cancel = (error: Error) => {
      if (settled) return;
      settled = true; cleanup(); operation.abort(); reject(error);
    };
    const timeout = () => { if (settled) return; const error = new WalletSessionUnavailableError("timeout"); cancel(error); timedOut(error); };
    const aborted = () => { if (signal?.reason?.name === "TimeoutError") timeout(); else cancel(abortError()); };
    if (signal?.aborted) { aborted(); return; }
    pending.add(cancel);
    signal?.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(timeout, LOGIN_TIMEOUT_MS);
    // The rejection handler stays attached after cancellation so late SDK or
    // provider failures never escape as unhandled rejections.
    void Promise.resolve().then(() => {
      if (operation.signal.aborted) throw abortError();
      return run(operation.signal);
    }).then(value => {
      if (settled) return;
      settled = true; cleanup(); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    });
  });
}
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

export async function connectBrowserWallet(wallet: BrowserWallet, signal: AbortSignal, changed: AccountListener, restoreAddress?: string): Promise<WalletConnection> {
  if (signal.aborted) throw abortError();
  const { provider } = wallet;
  if (!restoreAddress) await abortable(provider.request({ method: "eth_requestAccounts" }), signal);
  let active = true, revision = 0;
  let pendingIdentityChange = false;
  let account: WalletAccount | null = null;
  const pendingLogins = new Set<PendingApproval>();
  const cancelLogins = (error: WalletSessionUnavailableError) => { for (const cancel of pendingLogins) cancel(error); };
  const stop = () => {
    if (!active) return;
    active = false; revision++;
    cancelLogins(new WalletSessionUnavailableError());
    provider.removeListener("accountsChanged", accountsChanged);
    provider.removeListener("chainChanged", chainChanged);
    provider.removeListener("disconnect", disconnected);
  };
  const drop = (reason?: "identity") => { if (!active) return; stop(); if (reason) changed(null, reason); else changed(null); };
  const disconnected = () => drop();
  async function refresh() {
    const current = ++revision;
    const [rawAccounts, rawChain] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
    if (!active || current !== revision) return;
    const selected = addresses.parse(rawAccounts)[0];
    if (!selected) { drop(pendingIdentityChange ? "identity" : undefined); return; }
    const next = { address: selected, chainId: parseChainId(rawChain), name: wallet.name, transport: "browser" as const };
    const identityChanged = pendingIdentityChange || (account && (account.address.toLowerCase() !== next.address.toLowerCase() || account.chainId !== next.chainId));
    account = next;
    pendingIdentityChange = false;
    if (identityChanged) { cancelLogins(new WalletSessionUnavailableError("changed")); changed(account, "identity"); }
    else changed(account);
  }
  function refreshEvent() {
    const current = revision + 1, identityChanged = pendingIdentityChange;
    void refresh().catch(() => { if (active && current === revision) drop(identityChanged ? "identity" : undefined); });
  }
  function reportIdentity(next: WalletAccount) {
    pendingIdentityChange = true; revision++; account = next;
    cancelLogins(new WalletSessionUnavailableError("changed")); changed(next, "identity");
  }
  function accountsChanged(value: unknown) {
    if (!active) return;
    const parsed = addresses.safeParse(value);
    if (parsed.success && !parsed.data.length) { drop(); return; }
    const selected = parsed.success ? parsed.data[0] : undefined;
    if (account && selected && account.address.toLowerCase() !== selected.toLowerCase()) reportIdentity({ ...account, address: selected });
    refreshEvent();
  }
  function chainChanged(value: unknown) {
    if (!active) return;
    let chain: number | undefined;
    try { chain = parseChainId(value); } catch { /* Read the provider if its event payload is malformed. */ }
    if (account && chain !== undefined && account.chainId !== chain) reportIdentity({ ...account, chainId: chain });
    refreshEvent();
  }
  provider.on("accountsChanged", accountsChanged);
  provider.on("chainChanged", chainChanged);
  provider.on("disconnect", disconnected);
  signal.addEventListener("abort", stop, { once: true });
  try {
    await abortable(refresh(), signal);
    if (signal.aborted) throw abortError();
    if (!account) throw new Error("Wallet has no available account");
    if (restoreAddress && (account as WalletAccount).address.toLowerCase() !== restoreAddress.toLowerCase()) throw Error("Selected wallet changed");
    const assertActive = () => { if (!active || !account) throw new WalletSessionUnavailableError(); };
    return { detach: stop, assertActive, get account() { assertActive(); return account!; },
      signIn: (message, signal) => guardLogin(async loginSignal => {
        const before = revision, payer = account?.address;
        const ensureCurrent = () => {
          if (loginSignal.aborted) throw abortError();
          assertActive();
          if (revision !== before || !payer) throw new WalletSessionUnavailableError("changed");
        };
        const request = (args: Parameters<typeof provider.request>[0]) => {
          ensureCurrent();
          return abortable(provider.request(args), loginSignal);
        };
        const check = async () => {
          ensureCurrent();
          const [rawAccounts, rawChain] = await Promise.all([request({ method: "eth_accounts" }), request({ method: "eth_chainId" })]);
          ensureCurrent();
          if (addresses.parse(rawAccounts)[0]?.toLowerCase() !== payer!.toLowerCase() || parseChainId(rawChain) !== arc.chainId) throw Error("Wallet changed during login");
        };
        await check();
        const signature = await signLoginMessage(message, payer!, request);
        await check(); return signature;
      }, pendingLogins, signal, () => drop()),
      authorizeArc: async intent => {
        const before = revision;
        const check = async () => {
          if (!active || revision !== before) throw Error("Wallet changed during payment approval");
          const [accounts, chain] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
          if (!active || revision !== before || addresses.parse(accounts)[0]?.toLowerCase() !== intent.payer.toLowerCase() || parseChainId(chain) !== arc.chainId) throw Error("Select the payer wallet on Arc Mainnet");
        };
        await check();
        const result = await signArcPayment(intent, args => provider.request(args));
        await check(); return result;
      }, disconnect: async () => { stop(); changed(null); }, switchToArc: async () => {
      if (!active) throw new Error("Wallet disconnected");
      const initialAddress = account?.address;
      await switchBrowserToArc(provider, () => active && initialAddress === account?.address);
      if (!active) throw new Error("Wallet disconnected");
      await refresh();
    } };
  } catch (error) { stop(); throw error; }
  finally { signal.removeEventListener("abort", stop); }
}

/** User action only: request a network change, never a signature or transaction. */
export async function switchBrowserToArc(provider: BrowserWallet["provider"], stillCurrent: () => boolean = () => true): Promise<void> {
  const ensureCurrent = () => { if (!stillCurrent()) throw new Error("Wallet connection changed"); };
  ensureCurrent();
  try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: arc.chainIdHex }] }); }
  catch (error) {
    ensureCurrent();
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== 4902) throw error;
    await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: arc.chainIdHex, chainName: arc.name,
      nativeCurrency: arc.nativeCurrency, rpcUrls: [arc.rpcUrl], blockExplorerUrls: [arc.explorerUrl] }] });
    ensureCurrent();
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: arc.chainIdHex }] });
  }
  ensureCurrent();
  if (parseChainId(await provider.request({ method: "eth_chainId" })) !== arc.chainId) throw new Error("Wallet did not switch to Arc Mainnet");
  ensureCurrent();
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

const sessionSchema = z.object({ expiry: z.number().finite(), peer: z.object({ metadata: z.object({ name: z.string().min(1).max(80) }) }),
  namespaces: z.record(z.object({ accounts: z.array(z.string()), methods: z.array(z.string()) })) });
function sessionNamespace(session: z.infer<typeof sessionSchema>, chainId: number) {
  return session.namespaces[`eip155:${chainId}`] ?? session.namespaces["eip155"];
}
export function accountFromSession(session: unknown, chainId: number): WalletAccount {
  parseChainId(chainId);
  const parsed = sessionSchema.parse(session);
  if (parsed.expiry <= Date.now() / 1000) throw new Error("Wallet session expired");
  const namespace = sessionNamespace(parsed, chainId);
  const selected = namespace?.accounts.find(value => new RegExp(`^eip155:${chainId}:0x[a-fA-F0-9]{40}$`).test(value));
  if (!selected || !namespace?.methods.includes("eth_signTypedData_v4")) throw new Error("Required wallet capabilities not approved");
  return { address: address.parse(selected.split(":")[2]), chainId, name: parsed.peer.metadata.name, transport: "walletconnect" };
}

function unavailableRequest(error: unknown): WalletSessionUnavailableError | null {
  const message = typeof error === "string" ? error : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === 6000) return new WalletSessionUnavailableError();
  if (typeof code === "number" && [5100, 5101, 5102, 5103, 5104].includes(code)) return new WalletSessionUnavailableError("changed");
  if (/\b(?:session|topic)\b/i.test(message) && /(?:no (?:existing |matching )?session|no matching key|does(?:n't| not) exist|not found|missing|expired|deleted)/i.test(message)) {
    return new WalletSessionUnavailableError(/expired/i.test(message) ? "expired" : "missing");
  }
  return null;
}

export async function connectWalletConnect(projectId: string, chainId: number, signal: AbortSignal, showUri: (uri: string) => void, changed: AccountListener,
  getClient: (id: string) => Promise<SignClient> = loadClient, restore?: { topic: string; address: string }): Promise<WalletConnection> {
  if (signal.aborted) throw abortError();
  parseChainId(chainId);
  const client = await abortable(getClient(projectId), signal);
  if (signal.aborted) throw abortError();
  const proposal = restore ? { uri: undefined, approval: async () => client.session.get(restore.topic) } : await client.connect({ requiredNamespaces: { eip155: { chains: [`eip155:${chainId}`], methods: ["eth_signTypedData_v4", "personal_sign"], events: ["accountsChanged", "chainChanged"] } } });
  const reason = { code: 6000, message: "User disconnected" };
  let acceptedTopic: string | undefined;
  const cancelPairing = () => {
    const topic = proposal.uri?.match(/^wc:([a-f0-9]{64})@2\?/i)?.[1];
    if (topic) void client.core.pairing.disconnect({ topic }).catch(() => {});
  };
  // Approval may arrive after Escape/unmount. Close that session instead of reconnecting the UI.
  const approval = proposal.approval().then(async session => {
    if (signal.aborted) { if (!restore) await client.disconnect({ topic: session.topic, reason }).catch(() => {}); throw abortError(); }
    acceptedTopic = session.topic;
    return session;
  });
  signal.addEventListener("abort", cancelPairing, { once: true });
  try {
    if (signal.aborted) { cancelPairing(); throw abortError(); }
    if (proposal.uri) showUri(proposal.uri);
    const session = await abortable(approval, signal);
    const topic = z.string().min(1).max(256).parse(session.topic);
    const initial = client.session.get(topic);
    const account = accountFromSession(initial, chainId);
    const approvalScope = (value: unknown) => {
      const namespace = sessionNamespace(sessionSchema.parse(value), chainId);
      return JSON.stringify({ accounts: namespace?.accounts.map(value => value.toLowerCase()).sort(), methods: namespace?.methods.slice().sort() });
    };
    const approvedScope = approvalScope(initial);
    if (restore && account.address.toLowerCase() !== restore.address.toLowerCase()) throw Error("Selected wallet changed");
    if (signal.aborted) throw abortError();
    let active = true;
    let unavailable = new WalletSessionUnavailableError();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const pendingRequests = new Set<PendingApproval>();
    const cleanup = () => {
      if (!active) return;
      active = false;
      clearTimeout(expiryTimer);
      client.off("session_delete", dropped); client.off("session_expire", expired);
      client.off("session_update", updated); client.off("session_event", updated);
      for (const reject of pendingRequests) reject(unavailable);
      pendingRequests.clear();
    };
    const invalidate = (error: WalletSessionUnavailableError) => {
      if (!active) return;
      unavailable = error;
      cleanup();
      if (error.reason === "changed") changed(null, "identity"); else changed(null);
    };
    const check = (method?: string) => {
      if (!active) throw unavailable;
      let fresh;
      try { fresh = client.session.get(topic); }
      catch (cause) { const error = unavailableRequest(cause) ?? new WalletSessionUnavailableError("missing"); invalidate(error); throw error; }
      try {
        if (fresh.topic !== topic) throw new WalletSessionUnavailableError("missing");
        if (fresh.expiry <= Date.now() / 1000) throw new WalletSessionUnavailableError("expired");
        const current = accountFromSession(fresh, chainId);
        if (current.address.toLowerCase() !== account.address.toLowerCase()
          || approvalScope(fresh) !== approvedScope
          || (method && !sessionNamespace(sessionSchema.parse(fresh), chainId)?.methods.includes(method))) throw new WalletSessionUnavailableError("changed");
        return fresh;
      } catch (cause) {
        const error = cause instanceof WalletSessionUnavailableError ? cause : new WalletSessionUnavailableError("changed");
        invalidate(error); throw error;
      }
    };
    const disconnect = async () => {
      if (!active) return;
      invalidate(new WalletSessionUnavailableError());
      // A locally missing session is already disconnected. Do not let SDK cleanup
      // failures turn lifecycle callbacks into unhandled promise rejections.
      await client.disconnect({ topic, reason }).catch(() => {});
    };
    const dropped = (event: { topic: string }) => { if (event.topic === topic) invalidate(new WalletSessionUnavailableError("missing")); };
    const expired = (event: { topic: string }) => { if (event.topic === topic) invalidate(new WalletSessionUnavailableError("expired")); };
    // Keep valid same-identity updates active. Only a proven account, chain or
    // capability change invalidates the authenticated request's identity.
    const updated = (event: { topic: string; params?: { namespaces?: unknown; chainId?: unknown; event?: { name: string; data: unknown } } }) => {
      if (active && event.topic === topic) {
        let changeReason: WalletSessionUnavailableError["reason"] | undefined;
        try {
          const fresh = check(), params = event.params;
          if (params?.namespaces !== undefined) {
            try {
              const proposed = { ...fresh, namespaces: params.namespaces };
              if (accountFromSession(proposed, chainId).address.toLowerCase() !== account.address.toLowerCase() || approvalScope(proposed) !== approvedScope) changeReason = "changed";
            } catch { changeReason = "changed"; }
          }
          if (typeof params?.chainId === "string" && /^eip155:[1-9][0-9]*$/.test(params.chainId) && params.chainId !== `eip155:${chainId}`) changeReason = "changed";
          if (params?.event?.name === "accountsChanged") {
            const accounts = addresses.safeParse(params.event.data);
            if (accounts.success) {
              if (!accounts.data.length && changeReason !== "changed") changeReason = "missing";
              else if (accounts.data[0] && accounts.data[0].toLowerCase() !== account.address.toLowerCase()) changeReason = "changed";
            }
          }
          if (params?.event?.name === "chainChanged") {
            let chain: number | undefined;
            try { chain = parseChainId(params.event.data); } catch { /* The fresh approved scope remains authoritative. */ }
            if (chain !== undefined && chain !== chainId) changeReason = "changed";
          }
        } catch {
          // The fresh session check already notified the UI. Close any remaining
          // SDK session without allowing a missing-topic cleanup error to escape.
          void client.disconnect({ topic, reason }).catch(() => {}); return;
        }
        if (!changeReason) return;
        invalidate(new WalletSessionUnavailableError(changeReason));
        void client.disconnect({ topic, reason }).catch(() => {});
      }
    };
    const scheduleExpiry = () => {
      const fresh = check();
      expiryTimer = setTimeout(() => { try { scheduleExpiry(); } catch { /* check already invalidated the connection. */ } }, Math.min(2_147_483_647, Math.max(0, fresh.expiry * 1000 - Date.now())));
    };
    const request = (args: { method: string; params: unknown[] }, requestSignal?: AbortSignal): Promise<unknown> => {
      if (requestSignal?.aborted) return Promise.reject(abortError());
      check(args.method);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (success: boolean, value: unknown) => {
          if (settled) return;
          settled = true; pendingRequests.delete(cancel); requestSignal?.removeEventListener("abort", aborted);
          if (success) resolve(value); else reject(value);
        };
        const cancel = (error: Error) => finish(false, error);
        const aborted = () => cancel(abortError());
        pendingRequests.add(cancel);
        requestSignal?.addEventListener("abort", aborted, { once: true });
        const failed = (cause: unknown) => {
          if (settled) return;
          const error = unavailableRequest(cause);
          if (error) { invalidate(error); finish(false, error); return; }
          try { check(args.method); finish(false, cause); } catch (error) { finish(false, error); }
        };
        if (requestSignal?.aborted) { aborted(); return; }
        try {
          void client.request({ topic, chainId: `eip155:${arc.chainId}`, request: args }).then(value => {
            if (settled) return;
            try { check(args.method); finish(true, value); } catch (error) { finish(false, error); }
          }, failed).catch(error => finish(false, error));
        } catch (error) { failed(error); }
      });
    };
    client.on("session_delete", dropped); client.on("session_expire", expired);
    client.on("session_update", updated); client.on("session_event", updated);
    scheduleExpiry();
    changed(account);
    return { assertActive: () => { check(); }, get account() { check(); return account; }, disconnect, detach: cleanup, topic, signIn: (message, signal) => guardLogin(async loginSignal => {
      if (loginSignal.aborted) throw abortError();
      check("personal_sign");
      if (chainId !== arc.chainId) throw Error("Reconnect your wallet on Arc Mainnet");
      const signature = await signLoginMessage(message, account.address, args => request(args, loginSignal));
      if (loginSignal.aborted) throw abortError();
      check("personal_sign"); return signature;
    }, pendingRequests, signal, error => {
      invalidate(error);
      void client.disconnect({ topic, reason }).catch(() => {});
    }), authorizeArc: async intent => {
      check("eth_signTypedData_v4");
      if (chainId !== arc.chainId || account.address.toLowerCase() !== intent.payer.toLowerCase()) throw Error("Reconnect the payer wallet on Arc Mainnet");
      const result = await signArcPayment(intent, request);
      check("eth_signTypedData_v4");
      return result;
    } };
  } catch (error) {
    cancelPairing();
    if (acceptedTopic && !restore) await client.disconnect({ topic: acceptedTopic, reason }).catch(() => {});
    // Always consume eventual rejection even when cancelled before awaiting approval.
    void approval.catch(() => {});
    throw error;
  } finally { signal.removeEventListener("abort", cancelPairing); }
}
