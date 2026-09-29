/** Read-only Arc preflight for an immutable model/code/policy listing. Never signs or sends. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodeFunctionData, formatUnits, http, isAddress, parseAbi, zeroHash } from "viem";

const registryAbi = parseAbi([
  "function owner() view returns (address)",
  "function encl() view returns (address)",
  "function listingStake() view returns (uint256)",
  "function idByHashes(bytes32,bytes32) view returns (uint256)",
  "function listingPolicy(uint256) view returns (bytes32 policyHash,uint64 policyVersion)",
  "function listWithPolicy(bytes32,bytes32,uint16,bytes32,uint64) returns (uint256)",
  "function approve(uint256)",
]);
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const hash = value => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && value.toLowerCase() !== zeroHash;
const usage = "Usage: node scripts/prepare-arc-model-listing.mjs --model MODEL_ID --code-hash 0x... --policy-hash 0x... --policy-version N [--provider 0x...] [--bps 0..10000] [--record PATH]. Read-only; no transaction is sent.";

export function parseOptions(args) {
  if (args.includes("--help")) return { help: true };
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!key?.startsWith("--") || !args[i + 1] || args[i + 1].startsWith("--") || values[key] !== undefined) throw new Error(usage);
    values[key] = args[i + 1];
  }
  if (Object.keys(values).some(key => !["--model", "--code-hash", "--policy-hash", "--policy-version", "--provider", "--bps", "--record"].includes(key))) throw new Error(usage);
  const model = values["--model"];
  const codeHash = values["--code-hash"];
  const policyHash = values["--policy-hash"];
  const version = values["--policy-version"];
  const bps = values["--bps"] ?? "0";
  if (typeof model !== "string" || !model || model.trim() !== model || model.length > 512 || /[\x00-\x1f\x7f:]/.test(model)) throw new Error("Use the final canonical model ID.");
  if (!hash(codeHash) || !hash(policyHash)) throw new Error("Final code and policy hashes must be nonzero bytes32 values.");
  if (!/^[1-9][0-9]*$/.test(version ?? "") || BigInt(version) > (1n << 64n) - 1n) throw new Error("Policy version must be a positive uint64.");
  if (!/^(0|[1-9][0-9]*)$/.test(bps) || Number(bps) > 10_000) throw new Error("Provider share must be 0..10000 basis points.");
  if (values["--provider"] && !isAddress(values["--provider"])) throw new Error("Provider must be an EVM address.");
  return { model, codeHash, policyHash, policyVersion: BigInt(version), bps: Number(bps), provider: values["--provider"], record: values["--record"] };
}

export async function prepare(options, client, record) {
  if (record.chainId !== 5042 || !isAddress(record.contracts?.ModelRegistry) || !isAddress(record.contracts?.ENCL)
    || !isAddress(record.roles?.administrator)) throw new Error("Deployment record is incomplete or not Arc Mainnet.");
  const chainId = await client.getChainId();
  if (chainId !== 5042) throw new Error("RPC is not Arc Mainnet.");
  const block = await client.getBlock();
  const registry = record.contracts.ModelRegistry;
  const modelHash = `0x${createHash("sha256").update(`model:${options.model}`).digest("hex")}`;
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber: block.number });
  const [owner, token, stake, existing] = await Promise.all([
    read(registry, registryAbi, "owner"), read(registry, registryAbi, "encl"),
    read(registry, registryAbi, "listingStake"), read(registry, registryAbi, "idByHashes", [modelHash, options.codeHash]),
  ]);
  if (owner.toLowerCase() !== record.roles.administrator.toLowerCase() || token.toLowerCase() !== record.contracts.ENCL.toLowerCase()) throw new Error("Arc registry owner or stake token differs from the deployment record.");
  const provider = options.provider ?? owner;
  const [balance, allowance, gas] = await Promise.all([
    read(token, tokenAbi, "balanceOf", [provider]), read(token, tokenAbi, "allowance", [provider, registry]),
    client.getBalance({ address: provider, blockNumber: block.number }),
  ]);
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error("Arc block changed during preflight.");
  const base = { chainId, block: String(block.number), blockHash: block.hash, model: options.model, modelHash,
    codeHash: options.codeHash, policyHash: options.policyHash, policyVersion: String(options.policyVersion),
    provider, registry, registryOwner: owner, listingStakeEncl: formatUnits(stake, 18),
    providerBalanceEncl: formatUnits(balance, 18), providerGasUsdc: formatUnits(gas, 18), existingListingId: String(existing),
    transactionsSent: 0, warning: "Use only final reviewed release hashes. The provider and registry owner must approve their own transactions in Arc wallets." };
  if (existing !== 0n) {
    const [existingPolicyHash, existingPolicyVersion] = await read(registry, registryAbi, "listingPolicy", [existing]);
    const policyMatches = existingPolicyHash.toLowerCase() === options.policyHash.toLowerCase() && existingPolicyVersion === options.policyVersion;
    return { ...base, status: policyMatches ? "already-listed-policy-match" : "already-listed-policy-mismatch",
      existingPolicyHash, existingPolicyVersion: String(existingPolicyVersion), transactions: [] };
  }
  if (balance < stake) return { ...base, status: "insufficient-encl-stake", transactions: [] };
  if (gas === 0n) return { ...base, status: "insufficient-gas", transactions: [] };
  const transactions = [];
  if (allowance < stake) transactions.push({ role: "provider", from: provider, to: token, value: "0",
    data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [registry, stake] }), purpose: "Approve exactly one listing stake" });
  transactions.push({ role: "provider", from: provider, to: registry, value: "0",
    data: encodeFunctionData({ abi: registryAbi, functionName: "listWithPolicy", args: [modelHash, options.codeHash, options.bps, options.policyHash, options.policyVersion] }),
    purpose: "Register the immutable model, code and policy binding" });
  return { ...base, status: "prepared-only", transactions, next: "After the listing is confirmed, wait at least one hour and have the registry owner call approve(listingId). Verify isApprovedWithPolicy before accepting inference." };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { console.log(usage); return; }
  const recordPath = options.record ?? fileURLToPath(new URL("../../.local/arc-deployment.json", import.meta.url));
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const client = createPublicClient({ transport: http("https://rpc.mainnet.arc.io", { timeout: 15_000, retryCount: 0 }) });
  console.log(JSON.stringify(await prepare(options, client, record), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Arc registry preflight failed."); process.exitCode = 1; });
}
