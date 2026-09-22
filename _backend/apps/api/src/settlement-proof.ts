import { createPublicClient, decodeEventLog, http, keccak256, parseAbi, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { ConflictError } from "@enclave/core";
import type { Config } from "./config.js";

const abi = parseAbi(["event Settled(address indexed payer, uint256 amount, bytes32 indexed receiptHash, bool confidentialPath)"]);
function client(config: Config) { return createPublicClient({ chain: { ...foundry, id: config.ARC_CHAIN_ID }, transport: http(config.ARC_RPC_URL, { timeout: 15_000, retryCount: 1 }) }); }

export async function settlementScope(config: Config): Promise<string> {
  const rpc = client(config);
  if (await rpc.getChainId() !== config.ARC_CHAIN_ID) throw new ConflictError("Settlement RPC chain mismatch");
  const genesis = await rpc.getBlock({ blockNumber: 0n });
  return [config.ARC_CHAIN_ID, genesis.hash, config.USDC_ADDRESS.toLowerCase(), config.USAGE_METER_ADDRESS.toLowerCase(), privateKeyToAccount(config.DEPLOYER_PRIVATE_KEY).address.toLowerCase()].join(":");
}

export async function verifySettlementProof(config: Config, input: { paymentId: string; txHash: string; amount: bigint; confidential: boolean; payer?: Hex }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) throw new ConflictError("Payment transaction hash missing");
  const rpc = client(config);
  const receipt = await rpc.getTransactionReceipt({ hash: input.txHash as Hex });
  const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
  const head = await rpc.getBlockNumber({ cacheTime: 0 });
  const depth = config.CHAIN_CONFIRMATIONS ?? ([31337, 1337].includes(config.ARC_CHAIN_ID) ? 0 : 12);
  if (receipt.transactionHash.toLowerCase() !== input.txHash.toLowerCase() || receipt.status !== "success" || block.hash !== receipt.blockHash || head < receipt.blockNumber + BigInt(depth)) throw new ConflictError("Payment is not confirmed on the canonical chain");
  const payer = (input.payer ?? privateKeyToAccount(config.DEPLOYER_PRIVATE_KEY).address).toLowerCase();
  const paymentHash = keccak256(stringToHex(input.paymentId));
  const found = receipt.logs.some((event) => {
    if (event.address.toLowerCase() !== config.USAGE_METER_ADDRESS.toLowerCase()) return false;
    try {
      const { args } = decodeEventLog({ abi, eventName: "Settled", data: event.data, topics: event.topics });
      return args.payer.toLowerCase() === payer && args.receiptHash === paymentHash && args.confidentialPath === input.confidential && args.amount === (input.confidential ? 0n : input.amount);
    } catch { return false; }
  });
  if (!found) throw new ConflictError("Transaction does not prove the requested payment");
}
