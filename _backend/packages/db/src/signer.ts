import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { BlockNotFoundError, TransactionReceiptNotFoundError, createWalletClient, encodeFunctionData, http, keccak256, publicActions, type Abi, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import type { Database } from "./client.js";
import { chainTransactions } from "./schema.js";

export type SignerOptions = { db: Database; rpcUrl: string; chainId: number; privateKey: Hex; confirmations?: number };
export type ContractCall = { address: Hex; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint };
export class TransactionRevertedError extends Error {
  constructor(readonly txHash: Hex) { super(`Transaction reverted: ${txHash}`); this.name = "TransactionRevertedError"; }
}
export class TransactionProofError extends Error {
  constructor(readonly txHash: Hex, reason: string) { super(`Transaction proof invalid for ${txHash}: ${reason}`); this.name = "TransactionProofError"; }
}
export class SignerNonceConflictError extends Error {
  constructor(readonly txHash: Hex, readonly nonce: bigint) {
    super(`Signer nonce ${nonce} was consumed without the recorded transaction ${txHash}; operator review required`);
    this.name = "SignerNonceConflictError";
  }
}

type JournalRow = typeof chainTransactions.$inferSelect;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
function confirmationDepth(opts: SignerOptions): number {
  const value = opts.confirmations ?? ([31337, 1337].includes(opts.chainId) ? 0 : 12);
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) throw new RangeError("Invalid signer confirmation depth");
  return value;
}
function client(opts: SignerOptions) {
  confirmationDepth(opts);
  return createWalletClient({ account: privateKeyToAccount(opts.privateKey), chain: { ...foundry, id: opts.chainId }, cacheTime: 0,
    pollingInterval: 100, transport: http(opts.rpcUrl, { timeout: 20_000, retryCount: 1 }) }).extend(publicActions);
}
type Wallet = ReturnType<typeof client>;
async function scopeFor(wallet: Wallet, chainId: number) {
  if (await wallet.getChainId() !== chainId) throw new Error("RPC chain ID does not match configured signer");
  const genesis = await wallet.getBlock({ blockNumber: 0n });
  if (!genesis.hash) throw new Error("RPC did not return a canonical genesis block");
  return `${chainId}:${genesis.hash}`;
}
async function lock(tx: Transaction, scope: string, signer: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`signer:${scope}:${signer}`}, 0))`);
}
async function blockHash(wallet: Wallet, number: bigint): Promise<Hex | undefined> {
  try { return (await wallet.getBlock({ blockNumber: number })).hash ?? undefined; }
  catch (error) { if (error instanceof BlockNotFoundError) return undefined; throw error; }
}
async function canonicalReceipt(wallet: Wallet, hash: Hex): Promise<TransactionReceipt | undefined> {
  let receipt: TransactionReceipt;
  try { receipt = await wallet.getTransactionReceipt({ hash }); }
  catch (error) { if (error instanceof TransactionReceiptNotFoundError) return undefined; throw error; }
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new TransactionProofError(hash, "RPC returned a different transaction");
  if ((await blockHash(wallet, receipt.blockNumber))?.toLowerCase() !== receipt.blockHash.toLowerCase()) return undefined;
  return receipt;
}
async function broadcast(wallet: Wallet, row: JournalRow): Promise<void> {
  try {
    const hash = await wallet.sendRawTransaction({ serializedTransaction: row.rawTransaction as Hex });
    if (hash.toLowerCase() !== row.txHash.toLowerCase()) throw new TransactionProofError(row.txHash as Hex, "RPC returned a different broadcast hash");
  }
  catch (error) {
    // Only this exact signed hash proves acceptance after an ambiguous RPC error.
    try {
      const observed = await wallet.getTransaction({ hash: row.txHash as Hex });
      if (observed.hash.toLowerCase() !== row.txHash.toLowerCase()) throw error;
    } catch { throw error; }
  }
}

/** Revalidate every recorded canonical proof before reserving a higher nonce.
 * Orphaned transactions are replayed using their committed bytes in nonce order.
 * Scanning the journal also supports deep forks, rather than assuming old confirmations are permanent.
 */
async function reconcileJournal(tx: Transaction, wallet: Wallet, scope: string, signer: string, depth: number): Promise<{ rows: JournalRow[]; recovered: JournalRow[] }> {
  const rows = await tx.select().from(chainTransactions).where(and(eq(chainTransactions.scope, scope), eq(chainTransactions.signer, signer))).orderBy(asc(chainTransactions.nonce));
  const recovered: JournalRow[] = [];
  const head = await wallet.getBlockNumber({ cacheTime: 0 });
  const headers = new Map<bigint, Hex | undefined>();
  for (const row of rows) {
    if ((row.status === "confirmed" || row.status === "reverted") && row.confirmedBlockNumber !== null && row.confirmedBlockHash !== null) {
      if (!headers.has(row.confirmedBlockNumber)) headers.set(row.confirmedBlockNumber, await blockHash(wallet, row.confirmedBlockNumber));
      if (headers.get(row.confirmedBlockNumber)?.toLowerCase() === row.confirmedBlockHash.toLowerCase() && head >= row.confirmedBlockNumber + BigInt(depth)) continue;
    }
    recovered.push(row);
    const receipt = await canonicalReceipt(wallet, row.txHash as Hex);
    if (receipt) {
      const finalized = head >= receipt.blockNumber + BigInt(depth);
      const state = {
        status: finalized ? (receipt.status === "success" ? "confirmed" : "reverted") : "broadcast",
        confirmedBlockNumber: finalized ? receipt.blockNumber : null,
        confirmedBlockHash: finalized ? receipt.blockHash : null,
        error: null, updatedAt: new Date(),
      };
      await tx.update(chainTransactions).set(state).where(eq(chainTransactions.id, row.id));
      Object.assign(row, state);
      continue;
    }
    const minedNonce = BigInt(await wallet.getTransactionCount({ address: wallet.account.address, blockTag: "latest" }));
    if (minedNonce > row.nonce) throw new SignerNonceConflictError(row.txHash as Hex, row.nonce);
    await broadcast(wallet, row);
    const state = { status: "broadcast", confirmedBlockNumber: null, confirmedBlockHash: null, error: null, updatedAt: new Date() };
    await tx.update(chainTransactions).set(state).where(eq(chainTransactions.id, row.id));
    Object.assign(row, state);
  }
  return { rows, recovered };
}

/** Persist signed bytes under a PostgreSQL signer lock before the first broadcast. */
export async function sendDurableTransaction(opts: SignerOptions, operationKey: string, call: ContractCall): Promise<Hex> {
  const wallet = client(opts);
  const scope = await scopeFor(wallet, opts.chainId);
  const signer = wallet.account.address.toLowerCase();
  // REASON: contract artifacts provide the runtime ABI consumed by viem.
  const data = encodeFunctionData({ abi: call.abi as Abi, functionName: call.functionName, args: call.args });
  const requestHash = keccak256(new TextEncoder().encode(`${call.address.toLowerCase()}:${call.value ?? 0n}:${data}`));
  const row = await opts.db.transaction(async (tx) => {
    await lock(tx, scope, signer);
    const [existing] = await tx.select().from(chainTransactions).where(and(eq(chainTransactions.scope, scope), eq(chainTransactions.operationKey, operationKey))).limit(1);
    if (existing && (existing.requestHash !== requestHash || existing.signer !== signer)) throw new Error("Transaction operation key reused with different parameters");
    const { rows } = await reconcileJournal(tx, wallet, scope, signer, confirmationDepth(opts));
    if (existing) return rows.find((candidate) => candidate.id === existing.id) ?? existing;
    const networkNonce = BigInt(await wallet.getTransactionCount({ address: wallet.account.address, blockTag: "pending" }));
    const last = rows.at(-1);
    if (last && last.nonce >= networkNonce) throw new Error(`Signer nonce gap before ${last.nonce}; committed transactions have not entered the canonical pending chain`);
    if (networkNonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Signer nonce exceeds safe integer range");
    const prepared = await wallet.prepareTransactionRequest({ account: wallet.account, to: call.address, data, value: call.value ?? 0n, nonce: Number(networkNonce) });
    const rawTransaction = await wallet.signTransaction(prepared);
    const txHash = keccak256(rawTransaction);
    const [inserted] = await tx.insert(chainTransactions).values({ scope, operationKey, requestHash, signer, nonce: networkNonce, rawTransaction, txHash }).returning();
    if (!inserted) throw new Error("Failed to persist signed transaction");
    return inserted;
  });
  if (row.status === "reverted") throw new TransactionRevertedError(row.txHash as Hex);
  if (row.status === "confirmed") return row.txHash as Hex;
  await broadcast(wallet, row);
  // A concurrent confirmer may already have finalized this immutable operation.
  await opts.db.update(chainTransactions).set({ status: "broadcast", updatedAt: new Date() })
    .where(and(eq(chainTransactions.id, row.id), inArray(chainTransactions.status, ["prepared", "broadcast"])));
  return row.txHash as Hex;
}

export async function confirmDurableTransaction(opts: SignerOptions, hash: Hex): Promise<TransactionReceipt> {
  const wallet = client(opts);
  const scope = await scopeFor(wallet, opts.chainId);
  const signer = wallet.account.address.toLowerCase();
  const depth = confirmationDepth(opts);
  const waited = await wallet.waitForTransactionReceipt({ hash, confirmations: depth + 1, timeout: 60_000 });
  if (waited.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new TransactionProofError(hash, "the transaction was replaced");
  const receipt = await opts.db.transaction(async (tx) => {
    await lock(tx, scope, signer);
    const proof = await canonicalReceipt(wallet, hash);
    if (!proof) throw new TransactionProofError(hash, "receipt is not in the canonical chain");
    if (await wallet.getBlockNumber({ cacheTime: 0 }) < proof.blockNumber + BigInt(depth)) throw new TransactionProofError(hash, "confirmation depth is insufficient");
    await tx.update(chainTransactions).set({ status: proof.status === "success" ? "confirmed" : "reverted", confirmedBlockNumber: proof.blockNumber, confirmedBlockHash: proof.blockHash, error: null, updatedAt: new Date() })
      .where(and(eq(chainTransactions.scope, scope), eq(chainTransactions.signer, signer), eq(chainTransactions.txHash, hash)));
    return proof;
  });
  if (receipt.status !== "success") throw new TransactionRevertedError(hash);
  return receipt;
}

export async function recoverSignerTransactions(opts: SignerOptions): Promise<number> {
  const wallet = client(opts);
  const scope = await scopeFor(wallet, opts.chainId);
  const signer = wallet.account.address.toLowerCase();
  const recovered = await opts.db.transaction(async (tx) => {
    await lock(tx, scope, signer);
    return (await reconcileJournal(tx, wallet, scope, signer, confirmationDepth(opts))).recovered;
  });
  for (const row of recovered) {
    try { await confirmDurableTransaction(opts, row.txHash as Hex); }
    catch (error) { if (!(error instanceof TransactionRevertedError)) throw error; }
  }
  return recovered.length;
}
