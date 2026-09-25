import { z } from "zod";
import { connectBrowserWallet, connectWalletConnect, type AccountListener, type WalletConnection } from "./wallet-session";
import { discoverWallets, walletProjectId, type BrowserWallet } from "./wallets";

const key = "enclave.wallet.selection";
const selection = z.object({
  transport: z.enum(["browser", "walletconnect"]), address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.number().int().positive(), id: z.string().max(200).optional(), rdns: z.string().max(200).optional(),
  topic: z.string().min(1).max(256).optional(),
});
// Only a public selection hint. Login tokens, signatures and payment approvals never go here.
export function forgetWallet() { try { localStorage.removeItem(key); } catch { /* Storage may be disabled. */ } }
export function rememberWallet(connection: WalletConnection, browser: BrowserWallet | null) {
  try { localStorage.setItem(key, JSON.stringify({ ...connection.account, id: browser?.id, rdns: browser?.rdns, topic: connection.topic })); } catch { /* Connection still works for this page. */ }
}
export async function restoreWallet(signal: AbortSignal, changed: AccountListener): Promise<WalletConnection | null> {
  let saved: z.infer<typeof selection>;
  try { const raw = localStorage.getItem(key); if (!raw) return null; saved = selection.parse(JSON.parse(raw)); }
  catch { forgetWallet(); return null; }
  // Suppress initial account events until the remembered identity has been checked.
  let ready = false;
  const updated: AccountListener = value => { if (ready) changed(value); };
  try {
    let result: WalletConnection;
    if (saved.transport === "walletconnect") {
      if (!saved.topic) throw Error("No saved session");
      result = await connectWalletConnect(walletProjectId, saved.chainId, signal, () => {}, updated, undefined, { topic: saved.topic, address: saved.address });
    } else {
      const wallet = await new Promise<BrowserWallet>((resolve, reject) => {
        let stop: (() => void) | undefined;
        const finish = (wallet?: BrowserWallet) => { clearTimeout(timer); signal.removeEventListener("abort", abort); stop?.(); wallet ? resolve(wallet) : reject(Error("Saved wallet unavailable")); };
        const abort = () => finish();
        const timer = setTimeout(() => finish(), 1500);
        if (signal.aborted) { finish(); return; }
        signal.addEventListener("abort", abort, { once: true });
        let matched = false;
        stop = discoverWallets(window, wallets => {
          const match = wallets.find(wallet => saved.rdns ? wallet.rdns === saved.rdns : wallet.id === saved.id);
          if (match && !matched) { matched = true; finish(match); }
        });
        if (matched) stop();
      });
      result = await connectBrowserWallet(wallet, signal, updated, saved.address);
    }
    if (signal.aborted) { result.detach?.(); return null; }
    ready = true;
    return result;
  } catch { if (!signal.aborted) forgetWallet(); return null; }
}
