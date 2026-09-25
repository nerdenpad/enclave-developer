import { z } from "zod";
import arc from "./arc-mainnet.json";

export const walletProjectId = /^[a-f0-9]{32}$/i.test(import.meta.env["VITE_WALLETCONNECT_PROJECT_ID"] ?? "")
  ? String(import.meta.env["VITE_WALLETCONNECT_PROJECT_ID"]) : "";
export const connectionNetworks = [{ id: arc.chainId, name: arc.name }] as const;
const knownNetworks = [...connectionNetworks, { id: 1, name: "Ethereum" }, { id: 8453, name: "Base" }, { id: 42161, name: "Arbitrum" }, { id: 5042002, name: "Arc Testnet" }];
export const networkName = (id: number) => knownNetworks.find(network => network.id === id)?.name ?? `Chain ${id}`;

export interface BrowserProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}
export type BrowserWallet = { id: string; name: string; rdns?: string; provider: BrowserProvider };
function isProvider(value: unknown): value is BrowserProvider {
  if (!value || typeof value !== "object") return false;
  return "request" in value && typeof value.request === "function" && "on" in value && typeof value.on === "function"
    && "removeListener" in value && typeof value.removeListener === "function";
}

export function discoverWallets(target: Window, update: (wallets: BrowserWallet[]) => void): () => void {
  const wallets = new Map<string, BrowserWallet>();
  function announce(event: Event) {
    if (!(event instanceof CustomEvent)) return;
    const result = z.object({ info: z.object({ uuid: z.string().uuid(), rdns: z.string().min(1).max(200).optional(), name: z.string().trim().min(1).max(80) }), provider: z.unknown() }).safeParse(event.detail);
    if (!result.success || !isProvider(result.data.provider) || wallets.size >= 100) return;
    const { info, provider } = result.data;
    if (wallets.has(info.uuid)) return;
    if (wallets.get("browser-wallet")?.provider === provider) wallets.delete("browser-wallet");
    if ([...wallets.values()].some(wallet => wallet.provider === provider)) return;
    // Names are untrusted display text. Never inject wallet-provided HTML or SVG.
    wallets.set(info.uuid, { id: info.uuid, name: info.name, ...(info.rdns ? { rdns: info.rdns } : {}), provider });
    update([...wallets.values()]);
  }
  target.addEventListener("eip6963:announceProvider", announce);
  target.dispatchEvent(new Event("eip6963:requestProvider"));
  // Old extensions may only expose window.ethereum. Prefer discovered providers.
  const legacy: unknown = Reflect.get(target, "ethereum");
  if (!wallets.size && isProvider(legacy)) {
    wallets.set("browser-wallet", { id: "browser-wallet", name: "Browser wallet", provider: legacy });
    update([...wallets.values()]);
  }
  return () => target.removeEventListener("eip6963:announceProvider", announce);
}

const listing = z.object({
  id: z.string().min(1).max(128), name: z.string().trim().min(1).max(80),
  image_id: z.string().max(128).nullish(),
  mobile: z.object({ native: z.string().max(1024).nullish(), universal: z.string().max(1024).nullish() }).nullish(),
});
export type ListedWallet = z.infer<typeof listing>;
export function parseWalletDirectory(data: unknown): { wallets: ListedWallet[]; total: number } {
  const parsed = z.object({ listings: z.record(z.unknown()), total: z.number().int().nonnegative() }).parse(data);
  const wallets = new Map<string, ListedWallet>();
  for (const item of Object.values(parsed.listings).slice(0, 100)) {
    const value = listing.safeParse(item);
    if (value.success) wallets.set(value.data.id, value.data);
  }
  return { wallets: [...wallets.values()], total: parsed.total };
}
export async function fetchWalletDirectory(projectId: string, chainId: number, search: string, page: number, signal: AbortSignal) {
  if (!/^[a-f0-9]{32}$/i.test(projectId)) throw new Error("WalletConnect is not configured yet.");
  if (!connectionNetworks.some(network => network.id === chainId) || !Number.isSafeInteger(page) || page < 1) throw new Error("Invalid wallet directory request.");
  const url = new URL("https://explorer-api.walletconnect.com/v3/wallets");
  url.search = new URLSearchParams({ projectId, chains: `eip155:${chainId}`, sdks: "sign_v2", entries: "100", page: String(page), search: search.slice(0, 80) }).toString();
  const response = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
  if (!response.ok) throw new Error("The wallet directory is unavailable. Try the QR connection instead.");
  return parseWalletDirectory(await response.json());
}

export function pairingLink(wallet: ListedWallet, uri: string): string | null {
  if (!/^wc:[a-f0-9]{64}@2\?/.test(uri) || uri.length > 4096) return null;
  const universal = wallet.mobile?.universal;
  if (universal) {
    try {
      const url = new URL(universal);
      if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) {
        url.pathname = `${url.pathname.replace(/\/$/, "")}/wc`;
        url.searchParams.set("uri", uri);
        return url.href;
      }
    } catch { /* Use the native link if the registry has no usable universal link. */ }
  }
  const native = wallet.mobile?.native;
  // Permit app schemes only; browser/file/executable schemes are never launch targets.
  if (native && /^[a-z][a-z0-9+.-]{1,39}:\/\/[a-z0-9/._-]*$/i.test(native)
    && !/^(https?|javascript|data|file|vbscript|intent|blob|about|chrome|edge|ms-.*|shell|powershell):/i.test(native)) {
    const base = native.endsWith("://") ? native : `${native.replace(/\/+$/, "")}/`;
    return `${base}wc?uri=${encodeURIComponent(uri)}`;
  }
  return null;
}

export function walletError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && error.code === 4001) return "Connection declined in your wallet. You can try again.";
  if (error instanceof Error && error.name === "AbortError") return "Connection cancelled.";
  return "Could not connect the wallet. Unlock it and try again.";
}
