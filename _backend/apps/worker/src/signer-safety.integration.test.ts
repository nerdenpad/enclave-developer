import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { chainTransactions, confirmDurableTransaction, createDb, recoverSignerTransactions, sendDurableTransaction, SignerNonceConflictError } from "@enclave/db";
import { createTestClient, createWalletClient, http, parseAbi, parseEther, publicActions, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { z } from "zod";

describe.skipIf(process.env.ENCLAVE_INTEGRATION !== "1")("durable signer canonical fork recovery", () => {
  let db: ReturnType<typeof createDb>["db"];
  let sql: ReturnType<typeof createDb>["sql"];
  let rpcUrl: string;
  let token: Hex;
  const abi = parseAbi(["function mint(address to, uint256 amount)", "function balanceOf(address owner) view returns (uint256)"]);
  beforeAll(() => {
    const env = z.object({ ENCLAVE_INTEGRATION: z.literal("1"), DATABASE_URL: z.string(), ARC_RPC_URL: z.string(), USDC_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(process.env);
    ({ db, sql } = createDb(env.DATABASE_URL));
    rpcUrl = env.ARC_RPC_URL;
    token = `0x${env.USDC_ADDRESS.slice(2)}`;
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  async function isolatedSigner() {
    // A new funded account confines intentional nonce conflicts to this disposable test.
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const transport = http(rpcUrl);
    const wallet = createWalletClient({ account, chain: foundry, transport, cacheTime: 0, pollingInterval: 50 }).extend(publicActions);
    const test = createTestClient({ chain: foundry, transport, mode: "anvil" });
    expect(await wallet.getChainId()).toBe(31337);
    await test.setBalance({ address: account.address, value: parseEther("10") });
    const opts = { db, rpcUrl, chainId: 31337, privateKey };
    const mint = (amount: bigint) => ({ address: token, abi, functionName: "mint", args: [account.address, amount] });
    const balance = () => wallet.readContract({ address: token, abi, functionName: "balanceOf", args: [account.address] });
    const journal = () => db.select().from(chainTransactions).where(eq(chainTransactions.signer, account.address.toLowerCase())).orderBy(asc(chainTransactions.nonce));
    return { opts, account, wallet, test, mint, balance, journal };
  }

  it("replays an orphaned confirmed transaction with its original hash before allocating the next nonce", async () => {
    const s = await isolatedSigner();
    const snapshot = await s.test.snapshot();
    const operation = `fork:${randomUUID()}`;
    const original = await sendDurableTransaction(s.opts, operation, s.mint(19n));
    const proof = await confirmDurableTransaction(s.opts, original);
    expect(await s.balance()).toBe(19n);
    await s.test.revert({ id: snapshot });
    await s.test.mine({ blocks: 2, interval: 1 });
    expect(await s.balance()).toBe(0n);

    expect(await recoverSignerTransactions(s.opts)).toBe(1);
    expect(await s.balance()).toBe(19n);
    expect(await sendDurableTransaction(s.opts, operation, s.mint(19n))).toBe(original);
    const [recovered] = await s.journal();
    expect(recovered).toMatchObject({ txHash: original, status: "confirmed", nonce: 0n });
    expect(recovered!.confirmedBlockNumber).toBeGreaterThan(proof.blockNumber);
    expect(recovered!.confirmedBlockHash).not.toBe(proof.blockHash);
    const next = await sendDurableTransaction(s.opts, `after-fork:${randomUUID()}`, s.mint(5n));
    await confirmDurableTransaction(s.opts, next);
    expect((await s.journal()).map((row) => row.nonce)).toEqual([0n, 1n]);
    expect(await s.balance()).toBe(24n);
  });

  it("fails closed when another transaction consumes the orphaned nonce", async () => {
    const s = await isolatedSigner();
    const snapshot = await s.test.snapshot();
    const original = await sendDurableTransaction(s.opts, `replace:${randomUUID()}`, s.mint(7n));
    await confirmDurableTransaction(s.opts, original);
    await s.test.revert({ id: snapshot });
    const replacement = await s.wallet.writeContract({ address: token, abi, functionName: "mint", args: [s.account.address, 3n], nonce: 0 });
    expect((await s.wallet.waitForTransactionReceipt({ hash: replacement })).status).toBe("success");
    expect(replacement).not.toBe(original);
    const operation = `must-not-reserve:${randomUUID()}`;
    await expect(sendDurableTransaction(s.opts, operation, s.mint(11n))).rejects.toBeInstanceOf(SignerNonceConflictError);
    await expect(recoverSignerTransactions(s.opts)).rejects.toBeInstanceOf(SignerNonceConflictError);
    expect(await db.select().from(chainTransactions).where(and(eq(chainTransactions.signer, s.account.address.toLowerCase()), eq(chainTransactions.operationKey, operation)))).toHaveLength(0);
    expect(await s.balance()).toBe(3n);
    expect(await s.journal()).toHaveLength(1);
  });
});
