import type { WalletConnection } from "./wallet-session";
let connection: WalletConnection | null = null;
const listeners = new Set<() => void>();
export function walletChanged() { for (const listener of listeners) listener(); }
export function onWalletChanged(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function setPaymentWallet(value: WalletConnection | null) { connection = value; walletChanged(); }
export function paymentWallet(): WalletConnection {
  if (!connection) throw Error("Connect a wallet before confirming payment");
  return connection;
}
