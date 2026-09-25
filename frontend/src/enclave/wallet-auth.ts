import { recoverMessageAddress, stringToHex, type Hex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { z } from "zod";
import type { WalletConnection } from "./wallet-session";

export function validateLoginMessage(message: string, address: string, origin: string, nonce?: string) {
  const data = parseSiweMessage(message), now = Date.now();
  if (message.length > 2048 || data.domain !== new URL(origin).host || data.uri !== `${origin}/dashboard`
    || data.address?.toLowerCase() !== address.toLowerCase() || data.chainId !== 5042 || data.version !== "1"
    || data.statement !== "Sign in to Enclave. This does not authorize a payment."
    || !/^[a-f0-9]{48}$/.test(data.nonce ?? "") || (nonce !== undefined && data.nonce !== nonce)
    || !data.issuedAt || data.issuedAt.getTime() > now + 5000 || now - data.issuedAt.getTime() > 300_000
    || !data.expirationTime || data.expirationTime.getTime() <= now || data.expirationTime.getTime() > now + 305_000) {
    throw Error("The login message does not match this site, wallet or session");
  }
}
export async function signLoginMessage(message: string, address: string, request: (args: { method: string; params: unknown[] }) => Promise<unknown>): Promise<Hex> {
  validateLoginMessage(message, address, location.origin);
  const signature = z.string().regex(/^0x[a-fA-F0-9]{130}$/).parse(await request({ method: "personal_sign", params: [stringToHex(message), address] })) as Hex;
  if ((await recoverMessageAddress({ message, signature })).toLowerCase() !== address.toLowerCase()) throw Error("Login signature does not match the selected wallet");
  validateLoginMessage(message, address, location.origin);
  return signature;
}

async function authRequest(path: string, body?: unknown, token?: string) {
  const response = await fetch(`/api/v1/auth/wallet/${path}`, { method: body === undefined ? "GET" : "POST", credentials: "omit",
    headers: { "content-type": "application/json", ...(token ? { "x-api-key": token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw Error(response.status === 429 ? "Too many login attempts. Please wait a few minutes." : "Wallet login failed or expired. Please try again.");
  return response.json() as Promise<unknown>;
}
export async function walletLoginAvailable(): Promise<boolean> {
  try {
    const config = z.object({ enabled: z.literal(true), origin: z.string(), chainId: z.literal(5042) }).parse(await authRequest("config"));
    return config.origin === location.origin;
  } catch { return false; }
}
export async function logoutWallet(token: string) { await authRequest("logout", {}, token); }
export async function loginWallet(wallet: WalletConnection, stillCurrent: () => boolean) {
  const address = wallet.account.address;
  const check = () => {
    if (!stillCurrent() || wallet.account.address.toLowerCase() !== address.toLowerCase() || wallet.account.chainId !== 5042) throw Error("Wallet changed during login. Connect to Arc and try again.");
  };
  check();
  const c = z.object({ id: z.string().regex(/^[a-f0-9]{48}$/), message: z.string().max(2048) }).parse(await authRequest("challenge", { address }));
  check(); validateLoginMessage(c.message, address, location.origin, c.id);
  const signature = await wallet.signIn(c.message);
  check();
  const result = z.object({ token: z.string().regex(/^enws_[a-f0-9]{64}$/), address: z.string(), expiresAt: z.string().datetime() }).parse(await authRequest("verify", { id: c.id, signature }));
  try {
    check();
    if (result.address.toLowerCase() !== address.toLowerCase() || Date.parse(result.expiresAt) <= Date.now() || Date.parse(result.expiresAt) > Date.now() + 1_805_000) throw Error("Invalid login session");
    return result;
  } catch (error) { void logoutWallet(result.token).catch(() => {}); throw error; }
}
