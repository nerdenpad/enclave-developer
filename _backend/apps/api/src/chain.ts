import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sendDurableTransaction, confirmDurableTransaction, type ContractCall, type Database } from "@enclave/db";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeFunctionData, http, keccak256, maxUint256, parseAbi, parseAbiItem, publicActions, stringToHex, zeroHash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { isConfiguredAddress } from "@enclave/core";
import type { Config } from "./config.js";
import { parseEventLogs, type Abi } from "viem";
import { AppError, ConflictError } from "@enclave/core";
import type { TransferAuthorization } from "./x402-v2.js";

type Artifact = { abi: readonly unknown[] };

function artifact(name: string): Artifact {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../contracts/out-solc/${name}.json`, import.meta.url)), "utf8"),
  ) as Artifact;
}

export function addressConfigured(value: string): boolean {
  return isConfiguredAddress(value);
}

export function paymentIdToBytes32(paymentId: string): Hex {
  return keccak256(stringToHex(paymentId));
}

function walletFor(config: Config, db?: Database, operation: string = randomUUID()) {
  const account = privateKeyToAccount(config.DEPLOYER_PRIVATE_KEY);
  const wallet = createWalletClient({
    account,
    chain: { ...foundry, id: config.ARC_CHAIN_ID },
    pollingInterval: config.NODE_ENV === "test" ? 25 : 4_000,
    transport: http(config.ARC_RPC_URL),
  }).extend(publicActions);
  if (db) {
    const opts = { db, rpcUrl: config.ARC_RPC_URL, chainId: config.ARC_CHAIN_ID, privateKey: config.DEPLOYER_PRIVATE_KEY,
      ...(config.CHAIN_CONFIRMATIONS !== undefined ? { confirmations: config.CHAIN_CONFIRMATIONS } : {}),
    };
    let step = 0;
    wallet.writeContract = ((call: ContractCall) => sendDurableTransaction(opts, `${operation}:${step++}`, call)) as typeof wallet.writeContract;
    wallet.waitForTransactionReceipt = (({ hash }: { hash: Hex }) => confirmDurableTransaction(opts, hash)) as typeof wallet.waitForTransactionReceipt;
  }
  return { account, wallet };
}

async function confirmed(wallet: ReturnType<typeof walletFor>["wallet"], hash: Hex) {
  const receipt = await wallet.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return receipt;
}

// Each development gateway uses one funded signer. Serialize complete actions (including
// approve -> settle), rather than individual sends, so allowance and nonces cannot race.
// Multiple gateway processes still need a dedicated signer service/distributed lease.
const walletActions = new Map<string, Promise<unknown>>();
function serialized<T extends object>(config: Config, actions: T, names: Array<keyof T>): T {
  const key = `${config.ARC_RPC_URL}:${config.ARC_CHAIN_ID}:${privateKeyToAccount(config.DEPLOYER_PRIVATE_KEY).address}`;
  for (const name of names) {
    const action = actions[name] as (...args: unknown[]) => Promise<unknown>;
    actions[name] = ((...args: unknown[]) => {
      const previous = walletActions.get(key) ?? Promise.resolve();
      const result = previous.then(() => action(...args));
      const tail = result.then(() => undefined, () => undefined);
      walletActions.set(key, tail);
      void tail.then(() => { if (walletActions.get(key) === tail) walletActions.delete(key); });
      return result;
    }) as T[keyof T];
  }
  return actions;
}

export type PaymentAuthorization = { from: Hex; validAfter: string; validBefore: string; signature: Hex };
export type SettlementContext = { listingId?: number | null; agentId?: string | null; authorization?: PaymentAuthorization; mode?: "mock" | "authorized" };

export function createFacilitator(config: Config, db?: Database) {
  const { account } = walletFor(config);
  const usdc = artifact("MockUSDC");
  const meter = artifact("UsageMeter");

  return serialized(config, {
    payer: account.address,
    async settle(paymentId: string, amount: bigint, confidential = false, context: SettlementContext = {}): Promise<Hex> {
      const { wallet } = walletFor(config, db, `payment:${paymentId}`);
      const receiptHash = paymentIdToBytes32(paymentId);
      if (context.mode === "authorized") {
        if (confidential) throw new Error("Confidential authorization adapter is not configured");
        const auth = context.authorization;
        if (!auth) throw new Error("A signed USDC receive authorization is required");
        const tx = await wallet.writeContract({ address: config.USAGE_METER_ADDRESS as Hex, abi: meter.abi, functionName: "settleAuthorized",
          args: [auth.from, amount, receiptHash, BigInt(context.listingId ?? 0), context.agentId ? paymentIdToBytes32(context.agentId) : zeroHash,
            BigInt(auth.validAfter), BigInt(auth.validBefore), auth.signature] });
        await confirmed(wallet, tx);
        return tx;
      }
      if (confidential) {
        const settle = await wallet.writeContract({
          address: config.USAGE_METER_ADDRESS as Hex,
          abi: meter.abi,
          functionName: "settleConfidential",
          args: [account.address, stringToHex("shielded"), receiptHash],
        });
        await confirmed(wallet, settle);
        return settle;
      }
      const mint = await wallet.writeContract({
        address: config.USDC_ADDRESS as Hex,
        abi: usdc.abi,
        functionName: "mint",
        args: [account.address, amount],
      });
      await confirmed(wallet, mint);
      const approve = await wallet.writeContract({
        address: config.USDC_ADDRESS as Hex,
        abi: usdc.abi,
        functionName: "approve",
        args: [config.USAGE_METER_ADDRESS as Hex, maxUint256],
      });
      await confirmed(wallet, approve);
      const settle = await wallet.writeContract({
        address: config.USAGE_METER_ADDRESS as Hex,
        abi: meter.abi,
        functionName: context.listingId ? "settleModel" : context.agentId ? "settleAgent" : "settle",
        args: context.listingId
          ? [account.address, amount, receiptHash, BigInt(context.listingId), context.agentId ? paymentIdToBytes32(context.agentId) : zeroHash]
          : context.agentId ? [account.address, paymentIdToBytes32(context.agentId), amount, receiptHash] : [account.address, amount, receiptHash],
      });
      await confirmed(wallet, settle);
      return settle;
    },
  }, ["settle"]);
}

export function createStaking(config: Config, db?: Database) {
  const { account, wallet } = walletFor(config, db);
  const token = artifact("ENCL");
  const staking = artifact("InsuranceStaking");
  return serialized(config, {
    address: account.address,
    async stake(amount: bigint): Promise<Hex> {
      const approve = await wallet.writeContract({
        address: config.ENCL_TOKEN_ADDRESS as Hex,
        abi: token.abi,
        functionName: "approve",
        args: [config.INSURANCE_STAKING_ADDRESS as Hex, maxUint256],
      });
      await confirmed(wallet, approve);
      const tx = await wallet.writeContract({
        address: config.INSURANCE_STAKING_ADDRESS as Hex,
        abi: staking.abi,
        functionName: "stake",
        args: [amount],
      });
      await confirmed(wallet, tx);
      return tx;
    },
    async unstake(amount: bigint): Promise<Hex> {
      const tx = await wallet.writeContract({
        address: config.INSURANCE_STAKING_ADDRESS as Hex,
        abi: staking.abi,
        functionName: "unstake",
        args: [amount],
      });
      await confirmed(wallet, tx);
      return tx;
    },
    async stakedOf(who = account.address): Promise<bigint> {
      const client = createPublicClient({ chain: { ...foundry, id: config.ARC_CHAIN_ID }, transport: http(config.ARC_RPC_URL) });
      return client.readContract({
        address: config.INSURANCE_STAKING_ADDRESS as Hex,
        abi: staking.abi,
        functionName: "staked",
        args: [who],
      }) as Promise<bigint>;
    },
  }, ["stake", "unstake"]);
}

export function createMarketplace(config: Config, db?: Database) {
  const { wallet } = walletFor(config, db);
  const registry = artifact("ModelRegistry");
  const token = artifact("ENCL");
  const client = createPublicClient({ chain: { ...foundry, id: config.ARC_CHAIN_ID }, transport: http(config.ARC_RPC_URL) });
  return serialized(config, {
    async list(modelHash: Hex, codeHash: Hex, bps: number): Promise<{ tx: Hex; id: bigint }> {
      const stake = (await wallet.readContract({
        address: config.MODEL_REGISTRY_ADDRESS as Hex,
        abi: registry.abi,
        functionName: "listingStake",
      })) as bigint;
      if (stake > 0n && addressConfigured(config.ENCL_TOKEN_ADDRESS)) {
        const approve = await wallet.writeContract({
          address: config.ENCL_TOKEN_ADDRESS as Hex,
          abi: token.abi,
          functionName: "approve",
          args: [config.MODEL_REGISTRY_ADDRESS as Hex, maxUint256],
        });
        await confirmed(wallet, approve);
      }
      const tx = await wallet.writeContract({
        address: config.MODEL_REGISTRY_ADDRESS as Hex,
        abi: registry.abi,
        functionName: "list",
        args: [modelHash, codeHash, bps],
      });
      await confirmed(wallet, tx);
      const count = await wallet.readContract({
        address: config.MODEL_REGISTRY_ADDRESS as Hex,
        abi: registry.abi,
        functionName: "idByHashes",
        args: [modelHash, codeHash],
      });
      return { tx, id: count as bigint };
    },
    async bootstrapApprove(id: bigint): Promise<Hex> {
      const tx = await wallet.writeContract({
        address: config.MODEL_REGISTRY_ADDRESS as Hex,
        abi: registry.abi,
        functionName: "bootstrapApprove",
        args: [id],
      });
      await confirmed(wallet, tx);
      return tx;
    },
    async bootstrapRestore(id: bigint): Promise<Hex> {
      const tx = await wallet.writeContract({
        address: config.MODEL_REGISTRY_ADDRESS as Hex,
        abi: registry.abi,
        functionName: "bootstrapRestore",
        args: [id],
      });
      await confirmed(wallet, tx);
      return tx;
    },
    async revoke(id: bigint): Promise<Hex> {
      const tx = await wallet.writeContract({
        address: config.MODEL_REGISTRY_ADDRESS as Hex,
        abi: registry.abi,
        functionName: "revoke",
        args: [id],
      });
      await confirmed(wallet, tx);
      return tx;
    },
    async isApproved(modelHash: Hex, codeHash: Hex): Promise<boolean> {
      return client.readContract({
        address: config.MODEL_REGISTRY_ADDRESS as Hex,
        abi: registry.abi,
        functionName: "isApproved",
        args: [modelHash, codeHash],
      }) as Promise<boolean>;
    },
  }, ["list", "bootstrapApprove", "bootstrapRestore", "revoke"]);
}

export function createMandator(config: Config, db?: Database) {
  const { wallet } = walletFor(config, db);
  const mandate = artifact("AgentMandate");
  return serialized(config, {
    async open(agentId: string, dailyLimit: bigint): Promise<Hex> {
      const { wallet } = walletFor(config, db, `agent:${agentId}:open`);
      const tx = await wallet.writeContract({
        address: config.AGENT_MANDATE_ADDRESS as Hex,
        abi: mandate.abi,
        functionName: "open",
        args: [paymentIdToBytes32(agentId), dailyLimit],
      });
      await confirmed(wallet, tx);
      return tx;
    },
    async spend(agentId: string, amount: bigint): Promise<Hex> {
      const tx = await wallet.writeContract({
        address: config.AGENT_MANDATE_ADDRESS as Hex,
        abi: mandate.abi,
        functionName: "spend",
        args: [paymentIdToBytes32(agentId), amount],
      });
      await confirmed(wallet, tx);
      return tx;
    },
  }, ["open", "spend"]);
}

export function createFeeOps(config: Config, db?: Database) {
  const { wallet } = walletFor(config, db);
  const fees = artifact("FeeVault");
  const usdc = artifact("MockUSDC");
  const client = createPublicClient({ chain: { ...foundry, id: config.ARC_CHAIN_ID }, transport: http(config.ARC_RPC_URL) });
  return serialized(config, {
    async distribute(): Promise<Hex> {
      const tx = await wallet.writeContract({
        address: config.FEE_VAULT_ADDRESS as Hex,
        abi: fees.abi,
        functionName: "distribute",
      });
      await confirmed(wallet, tx);
      return tx;
    },
    async queueBuyback(amount: bigint): Promise<Hex> {
      const tx = await wallet.writeContract({
        address: config.FEE_VAULT_ADDRESS as Hex,
        abi: fees.abi,
        functionName: "queueBuyback",
        args: [amount],
      });
      await confirmed(wallet, tx);
      return tx;
    },
    async balances() {
      const read = (who: Hex) =>
        client.readContract({
          address: config.USDC_ADDRESS as Hex,
          abi: usdc.abi,
          functionName: "balanceOf",
          args: [who],
        }) as Promise<bigint>;
      const vault = config.FEE_VAULT_ADDRESS as Hex;
      const [vaultBal, treasury, stakers, providers, ecosystem] = await Promise.all([
        read(vault),
        client.readContract({ address: vault, abi: fees.abi, functionName: "treasury" }) as Promise<Hex>,
        client.readContract({ address: vault, abi: fees.abi, functionName: "stakers" }) as Promise<Hex>,
        client.readContract({ address: vault, abi: fees.abi, functionName: "providers" }) as Promise<Hex>,
        client.readContract({ address: vault, abi: fees.abi, functionName: "ecosystem" }) as Promise<Hex>,
      ]);
      return { vaultBal, treasury, stakers, providers, ecosystem };
    },
  }, ["distribute", "queueBuyback"]);
}

export function meterConfigured(config: Config): boolean {
  return addressConfigured(config.USAGE_METER_ADDRESS);
}

export function stakingConfigured(config: Config): boolean {
  return addressConfigured(config.INSURANCE_STAKING_ADDRESS) && addressConfigured(config.ENCL_TOKEN_ADDRESS);
}

export function marketplaceConfigured(config: Config): boolean {
  return addressConfigured(config.MODEL_REGISTRY_ADDRESS);
}

export function mandateConfigured(config: Config): boolean {
  return addressConfigured(config.AGENT_MANDATE_ADDRESS);
}

const x402TokenAbi = parseAbi([
  "function authorizationState(address authorizer,bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const authorizationUsedEvent = parseAbiItem("event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)");
function x402Client(config: Config) {
  return createPublicClient({ chain: { ...foundry, id: config.ARC_CHAIN_ID }, transport: http(config.ARC_RPC_URL, { timeout: 15_000, retryCount: 1 }), cacheTime: 0 });
}

/** Recovery supports direct token calls, including the SDK's bytes and v/r/s overloads.
 * Arbitrary multicall logs cannot prove which signed authorization produced a deposit.
 */
export async function verifyX402FundingProof(config: Config, auth: TransferAuthorization, txHash: Hex): Promise<{ blockNumber: bigint; blockHash: Hex }> {
  const rpc = x402Client(config);
  if (await rpc.getChainId() !== config.ARC_CHAIN_ID) throw new ConflictError("x402 funding chain mismatch");
  const [receipt, transaction] = await Promise.all([rpc.getTransactionReceipt({ hash: txHash }), rpc.getTransaction({ hash: txHash })]);
  const [block, head] = await Promise.all([rpc.getBlock({ blockNumber: receipt.blockNumber }), rpc.getBlockNumber()]);
  const depth = config.CHAIN_CONFIRMATIONS ?? ([31337, 1337].includes(config.ARC_CHAIN_ID) ? 0 : 12);
  const token = config.USDC_ADDRESS.toLowerCase();
  if (receipt.transactionHash.toLowerCase() !== txHash.toLowerCase() || transaction.hash.toLowerCase() !== txHash.toLowerCase() || receipt.status !== "success" || receipt.blockHash !== block.hash || transaction.blockHash !== block.hash || head < receipt.blockNumber + BigInt(depth) || transaction.to?.toLowerCase() !== token || transaction.value !== 0n) throw new ConflictError("x402 funding is not a canonical direct token transfer");
  const decoded = decodeFunctionData({ abi: x402TokenAbi, data: transaction.input });
  if (decoded.functionName !== "transferWithAuthorization") throw new ConflictError("x402 funding authorization mismatch");
  const args = decoded.args;
  if (args[0].toLowerCase() !== auth.from.toLowerCase() || args[1].toLowerCase() !== config.USAGE_METER_ADDRESS.toLowerCase() || args[1].toLowerCase() !== auth.to.toLowerCase() || args[2] !== BigInt(auth.value) || args[3] !== BigInt(auth.validAfter) || args[4] !== BigInt(auth.validBefore) || args[5].toLowerCase() !== auth.nonce.toLowerCase()) throw new ConflictError("x402 funding authorization mismatch");
  const signature = args.length === 7 ? args[6] : `0x${args[7].slice(2)}${args[8].slice(2)}${args[6].toString(16).padStart(2, "0")}`;
  if (signature.toLowerCase() !== auth.signature.toLowerCase()) throw new ConflictError("x402 funding signature mismatch");
  const logs = receipt.logs.filter((log) => log.address.toLowerCase() === token);
  const used = parseEventLogs({ abi: x402TokenAbi, eventName: "AuthorizationUsed", logs, strict: true }).some(({ args: row }) => row.authorizer.toLowerCase() === auth.from.toLowerCase() && row.nonce.toLowerCase() === auth.nonce.toLowerCase());
  const paid = parseEventLogs({ abi: x402TokenAbi, eventName: "Transfer", logs, strict: true }).some(({ args: row }) => row.from.toLowerCase() === auth.from.toLowerCase() && row.to.toLowerCase() === auth.to.toLowerCase() && row.value === BigInt(auth.value));
  if (!used || !paid) throw new ConflictError("x402 funding requires both authorization and transfer events");
  return { blockNumber: receipt.blockNumber, blockHash: block.hash! };
}

async function findX402Funding(config: Config, auth: TransferAuthorization, fromBlock: bigint): Promise<Hex | undefined> {
  const rpc = x402Client(config);
  const head = await rpc.getBlockNumber();
  if (fromBlock > head) throw new ConflictError("x402 challenge chain history was reorganized");
  // Recovery cannot use a block older than EVM blockhash's window; bound every reconciler scan.
  const oldestRecoverable = head > 255n ? head - 255n : 0n;
  for (let cursor = fromBlock > oldestRecoverable ? fromBlock : oldestRecoverable; cursor <= head; cursor += 2_000n) {
    const toBlock = cursor + 1_999n > head ? head : cursor + 1_999n;
    const logs = await rpc.getLogs({ address: config.USDC_ADDRESS as Hex, event: authorizationUsedEvent,
      args: { authorizer: auth.from as Hex, nonce: auth.nonce as Hex }, fromBlock: cursor, toBlock });
    for (const log of logs) {
      if (!log.transactionHash || log.removed) continue;
      await verifyX402FundingProof(config, auth, log.transactionHash);
      return log.transactionHash;
    }
  }
  return undefined;
}

export function createX402Facilitator(config: Config, db: Database) {
  const meter = artifact("UsageMeter");
  return {
    async assertSupported(): Promise<void> {
      try {
        const rpc = x402Client(config);
        if (await rpc.getChainId() !== config.ARC_CHAIN_ID || await rpc.readContract({ address: config.USAGE_METER_ADDRESS as Hex, abi: meter.abi, functionName: "X402_VERSION" }) !== 2n) throw new Error("Unsupported meter");
      } catch { throw new AppError("X402_UNAVAILABLE", "Configured UsageMeter does not support x402 v2 settlement", 503); }
    },
    blockNumber: () => x402Client(config).getBlockNumber(),
    async admission(auth: TransferAuthorization): Promise<{ blockNumber: string; blockHash: Hex }> {
      const rpc = x402Client(config);
      if (await rpc.getChainId() !== config.ARC_CHAIN_ID) throw new ConflictError("x402 admission chain mismatch");
      const block = await rpc.getBlock();
      const used = await rpc.readContract({ address: config.USDC_ADDRESS as Hex, abi: x402TokenAbi, functionName: "authorizationState", args: [auth.from as Hex, auth.nonce as Hex], blockNumber: block.number });
      if (used || !block.hash || (await rpc.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new ConflictError("x402 authorization must be unused at canonical admission");
      return { blockNumber: block.number.toString(), blockHash: block.hash };
    },
    async settle(paymentId: string, auth: TransferAuthorization, context: { listingId?: number | null; agentId?: string | null; admission: { blockNumber: string; blockHash: Hex }; fundingTx?: Hex }): Promise<{ tx: Hex; fundingTx?: Hex }> {
      const rpc = x402Client(config);
      const admissionBlock = BigInt(context.admission.blockNumber);
      if ((await rpc.getBlock({ blockNumber: admissionBlock })).hash !== context.admission.blockHash) throw new ConflictError("x402 admission chain history was reorganized");
      const code = await rpc.getCode({ address: auth.from as Hex });
      if (code && code !== "0x") throw new ConflictError("x402 supports externally owned payer accounts only");
      const args = [auth.from, BigInt(auth.value), paymentIdToBytes32(paymentId), BigInt(context.listingId ?? 0), context.agentId ? paymentIdToBytes32(context.agentId) : zeroHash,
        BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, auth.signature] as const;
      let fundingTx = context.fundingTx;
      if (!fundingTx) {
        try {
          const { wallet } = walletFor(config, db, `x402:${paymentId}:transfer`);
          const tx = await wallet.writeContract({ address: config.USAGE_METER_ADDRESS as Hex, abi: meter.abi, functionName: "settleTransferAuthorized", args });
          await confirmed(wallet, tx);
          return { tx };
        } catch (error) {
          // An unknown send never authorizes a second debit: recovery consumes only an already proven deposit.
          fundingTx = await findX402Funding(config, auth, admissionBlock + 1n);
          if (!fundingTx) throw error;
        }
      }
      const funding = await verifyX402FundingProof(config, auth, fundingTx);
      if (funding.blockNumber <= admissionBlock) throw new ConflictError("x402 funding must follow durable admission");
      const { wallet } = walletFor(config, db, `x402:${paymentId}:prepaid:${fundingTx}`);
      const tx = await wallet.writeContract({ address: config.USAGE_METER_ADDRESS as Hex, abi: meter.abi, functionName: "settlePrepaidTransfer", args: [...args, { number: funding.blockNumber, hash: funding.blockHash }] });
      await confirmed(wallet, tx);
      await verifyX402FundingProof(config, auth, fundingTx);
      return { tx, fundingTx };
    },
  };
}

export function createRegistryApproval(config: Config, db?: Database) {
  const { wallet } = walletFor(config, db);
  const registry = artifact("ModelRegistry");
  const client = createPublicClient({ chain: { ...foundry, id: config.ARC_CHAIN_ID }, transport: http(config.ARC_RPC_URL) });
  return serialized(config, {
    async status(id: bigint) {
      const [row, timelock, block] = await Promise.all([
        client.readContract({ address: config.MODEL_REGISTRY_ADDRESS as Hex, abi: registry.abi, functionName: "listings", args: [id] }) as Promise<readonly [Hex, Hex, Hex, bigint, number, bigint, boolean, boolean]>,
        client.readContract({ address: config.MODEL_REGISTRY_ADDRESS as Hex, abi: registry.abi, functionName: "TIMELOCK" }) as Promise<bigint>,
        client.getBlock(),
      ]);
      const availableAt = row[3] + timelock;
      const state = BigInt(row[2]) === 0n ? "missing" : row[7] ? "revoked" : row[6] ? "approved" : block.timestamp >= availableAt ? "ready" : "pending";
      return { listingId: id.toString(), state, availableAt: availableAt.toString(), chainTimestamp: block.timestamp.toString(), provider: row[2], listingBps: row[4] };
    },
    async approve(id: bigint): Promise<Hex> {
      const tx = await wallet.writeContract({ address: config.MODEL_REGISTRY_ADDRESS as Hex, abi: registry.abi, functionName: "approve", args: [id] });
      await confirmed(wallet, tx);
      return tx;
    },
  }, ["approve"]);
}

export function createEconomicOps(config: Config, db?: Database) {
  const { account, wallet } = walletFor(config, db);
  const fees = artifact("FeeVault");
  const staking = artifact("InsuranceStaking");
  const token = artifact("MockUSDC");
  const client = createPublicClient({ chain: { ...foundry, id: config.ARC_CHAIN_ID }, transport: http(config.ARC_RPC_URL) });
  const readFee = (functionName: string) => client.readContract({ address: config.FEE_VAULT_ADDRESS as Hex, abi: fees.abi, functionName });
  function feeLogs(receipt: Awaited<ReturnType<typeof confirmed>>, eventName: string) {
    return parseEventLogs({ abi: fees.abi as Abi, eventName, logs: receipt.logs.filter((log) => log.address.toLowerCase() === config.FEE_VAULT_ADDRESS.toLowerCase()) });
  }
  return serialized(config, {
    address: account.address,
    async pendingRewards(who = account.address): Promise<bigint> {
      return client.readContract({ address: config.INSURANCE_STAKING_ADDRESS as Hex, abi: staking.abi, functionName: "pendingRewards", args: [who] }) as Promise<bigint>;
    },
    async claimRewards() {
      const tx = await wallet.writeContract({ address: config.INSURANCE_STAKING_ADDRESS as Hex, abi: staking.abi, functionName: "claimRewards" });
      const receipt = await confirmed(wallet, tx);
      const events = parseEventLogs({ abi: staking.abi as Abi, eventName: "RewardsClaimed", logs: receipt.logs.filter((log) => log.address.toLowerCase() === config.INSURANCE_STAKING_ADDRESS.toLowerCase()) });
      const args = events[0]?.args as { who: Hex; amount: bigint } | undefined;
      if (!args) throw new Error("Confirmed reward claim did not emit RewardsClaimed");
      return { tx, amount: args.amount, staker: args.who };
    },
    async buybackStatus() {
      const [reserved, bps, router, tokenOut, recipient, balance] = await Promise.all([
        readFee("reservedBuyback") as Promise<bigint>, readFee("buybackReserveBps") as Promise<number>,
        readFee("buybackRouter") as Promise<Hex>, readFee("buybackToken") as Promise<Hex>, readFee("buybackRecipient") as Promise<Hex>,
        client.readContract({ address: config.USDC_ADDRESS as Hex, abi: token.abi, functionName: "balanceOf", args: [config.FEE_VAULT_ADDRESS] }) as Promise<bigint>,
      ]);
      return { reserved, treasuryBps: bps, router, tokenOut, recipient, availableForDistribution: balance - reserved };
    },
    async configureBuyback(router: Hex, tokenOut: Hex, recipient: Hex): Promise<Hex> {
      const tx = await wallet.writeContract({ address: config.FEE_VAULT_ADDRESS as Hex, abi: fees.abi, functionName: "configureBuyback", args: [router, tokenOut, recipient] });
      await confirmed(wallet, tx);
      return tx;
    },
    async setBuybackReserve(treasuryBps: number): Promise<Hex> {
      const tx = await wallet.writeContract({ address: config.FEE_VAULT_ADDRESS as Hex, abi: fees.abi, functionName: "setBuybackReserveBps", args: [treasuryBps] });
      await confirmed(wallet, tx);
      return tx;
    },
    async executeBuyback(amountIn: bigint, minOut: bigint, deadline: bigint) {
      const tx = await wallet.writeContract({ address: config.FEE_VAULT_ADDRESS as Hex, abi: fees.abi, functionName: "executeBuyback", args: [amountIn, minOut, deadline] });
      const receipt = await confirmed(wallet, tx);
      const args = feeLogs(receipt, "BuybackExecuted")[0]?.args as { amountIn: bigint; amountOut: bigint; recipient: Hex } | undefined;
      if (!args) throw new Error("Confirmed buyback did not emit BuybackExecuted");
      return { tx, amountIn: args.amountIn, amountOut: args.amountOut, recipient: args.recipient };
    },
    async distributeWithAccounting() {
      const tx = await wallet.writeContract({ address: config.FEE_VAULT_ADDRESS as Hex, abi: fees.abi, functionName: "distribute" });
      const receipt = await confirmed(wallet, tx);
      const args = feeLogs(receipt, "Distributed")[0]?.args as { treasuryAmt: bigint; stakersAmt: bigint; providersAmt: bigint; ecosystemAmt: bigint } | undefined;
      if (!args) throw new Error("Confirmed distribution did not emit Distributed");
      const reserve = feeLogs(receipt, "BuybackReserved")[0]?.args as { amount: bigint } | undefined;
      return { tx, treasury: args.treasuryAmt, stakers: args.stakersAmt, providers: args.providersAmt, ecosystem: args.ecosystemAmt, reserved: reserve?.amount ?? 0n };
    },
  }, ["claimRewards", "configureBuyback", "setBuybackReserve", "executeBuyback", "distributeWithAccounting"]);
}
