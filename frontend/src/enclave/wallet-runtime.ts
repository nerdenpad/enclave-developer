import { WalletSessionUnavailableError, type WalletConnection } from "./wallet-session";
let connection: WalletConnection | null = null;
const listeners = new Set<(reason: WalletChangeReason) => void>();
export type WalletChangeReason = "connection" | "identity" | "disconnect";
export function walletChanged(reason: WalletChangeReason = "connection") { for (const listener of listeners) listener(reason); }
export function onWalletChanged(listener: (reason: WalletChangeReason) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function setPaymentWallet(value: WalletConnection | null, notify = true, reason: WalletChangeReason = "connection") { connection = value; if (notify) walletChanged(reason); }
export function paymentWallet(purpose: "sign-in" | "payment" = "payment"): WalletConnection {
  if (!connection) throw Error(purpose === "sign-in" ? "Connect a wallet before signing in" : "Connect a wallet before confirming payment");
  const current = connection;
  try { current.assertActive?.(); }
  catch (error) {
    // Validation may notify the UI synchronously. Never clear a replacement
    // connection installed by that callback.
    if (connection === current) { connection = null; walletChanged(error instanceof WalletSessionUnavailableError && error.reason === "changed" ? "identity" : "connection"); }
    throw error;
  }
  return current;
}
