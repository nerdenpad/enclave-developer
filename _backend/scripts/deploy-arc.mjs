import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  http,
  parseEther,
  publicActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Deploys Enclave contracts on Arc Mainnet against the reviewed USDC token.
// Never deploys MockUSDC. Never prints private keys. Requires explicit env inputs.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, "contracts/out-solc");
const arc = JSON.parse(readFileSync(path.resolve(root, "../frontend/src/enclave/arc-mainnet.json"), "utf8"));

function required(name) {
  const value = process.env[name];
  assert(value, `Missing ${name}`);
  return value;
}

function art(name) {
  return JSON.parse(readFileSync(path.join(outDir, `${name}.json`), "utf8"));
}

function checksum(bytecode) {
  return createHash("sha256").update(bytecode).digest("hex");
}

const adminKey = required("ARC_ADMIN_PRIVATE_KEY");
assert(/^0x[0-9a-fA-F]{64}$/.test(adminKey), "ARC_ADMIN_PRIVATE_KEY must be a 32-byte hex key");
const relay = required("ARC_RELAY_ADDRESS");
const treasury = required("ARC_TREASURY_ADDRESS");
const team = process.env.ARC_TEAM_ADDRESS || privateKeyToAccount(adminKey).address;
const providers = process.env.ARC_PROVIDERS_ADDRESS || team;
const ecosystem = process.env.ARC_ECOSYSTEM_ADDRESS || team;
const receiptSigner = required("ARC_RECEIPT_SIGNER");
const rpc = process.env.ARC_RPC_URL || arc.rpcUrl;
const output = process.env.ARC_DEPLOYMENT_OUT || path.resolve(root, "../.local/arc-deployment.json");

assert(/^0x[0-9a-fA-F]{40}$/.test(relay), "Invalid ARC_RELAY_ADDRESS");
assert(/^0x[0-9a-fA-F]{40}$/.test(treasury), "Invalid ARC_TREASURY_ADDRESS");
assert(/^0x[0-9a-fA-F]{40}$/.test(receiptSigner), "Invalid ARC_RECEIPT_SIGNER");

const chain = defineChain({
  id: arc.chainId,
  name: arc.name,
  nativeCurrency: arc.nativeCurrency,
  rpcUrls: { default: { http: [rpc] } },
});

const account = privateKeyToAccount(adminKey);
assert(account.address !== relay, "Admin and relay must be distinct");
assert(account.address !== treasury, "Admin and treasury must be distinct");

const wallet = createWalletClient({
  account,
  chain,
  transport: http(rpc, { timeout: 30_000, retryCount: 1 }),
}).extend(publicActions);

const chainId = await wallet.getChainId();
assert.equal(chainId, arc.chainId, `Wrong chain: ${chainId}`);

const startedBalance = await wallet.getBalance({ address: account.address });
assert(startedBalance >= parseEther("1"), `Admin balance too low: ${formatUnits(startedBalance, 18)} USDC`);

async function deploy(name, args = []) {
  const { abi, bytecode } = art(name);
  assert(/^0x[0-9a-f]+$/i.test(bytecode), `Missing bytecode for ${name}; compile first`);
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await wallet.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${name} deploy failed`);
  assert(receipt.contractAddress, `${name} missing address`);
  console.log(JSON.stringify({
    event: "deployed",
    contract: name,
    address: receipt.contractAddress,
    tx: hash,
    gasUsed: String(receipt.gasUsed),
    bytecodeSha256: checksum(bytecode),
  }));
  return { address: receipt.contractAddress, abi };
}

async function send(label, address, abi, functionName, args) {
  const data = encodeFunctionData({ abi, functionName, args });
  const hash = await wallet.sendTransaction({ to: address, data });
  const receipt = await wallet.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${label} reverted`);
  console.log(JSON.stringify({ event: "configured", label, tx: hash, gasUsed: String(receipt.gasUsed) }));
  return hash;
}

const fees = await deploy("FeeVault", [arc.usdc.address]);
const encl = await deploy("ENCL", [treasury, team, providers, ecosystem, parseEther("1000000")]);
const listingStake = parseEther("1");
const registry = await deploy("ModelRegistry", [encl.address, listingStake]);
const verifier = await deploy("AttestationVerifier", [registry.address, receiptSigner]);
const meter = await deploy("UsageMeter", [arc.usdc.address, fees.address]);
const staking = await deploy("InsuranceStaking", [encl.address]);
const mandate = await deploy("AgentMandate", []);

await send("FeeVault.setSplit", fees.address, fees.abi, "setSplit", [treasury, staking.address, providers, ecosystem]);
await send("UsageMeter.setMandate", meter.address, meter.abi, "setMandate", [mandate.address]);
await send("UsageMeter.setModelRegistry", meter.address, meter.abi, "setModelRegistry", [registry.address]);
await send("InsuranceStaking.configureRewards", staking.address, staking.abi, "configureRewards", [arc.usdc.address]);
await send("UsageMeter.setRelay", meter.address, meter.abi, "setRelay", [relay]);

const owner = await wallet.readContract({ address: meter.address, abi: meter.abi, functionName: "owner" });
const configuredRelay = await wallet.readContract({ address: meter.address, abi: meter.abi, functionName: "relay" });
const configuredUsdc = await wallet.readContract({ address: meter.address, abi: meter.abi, functionName: "usdc" });
assert.equal(owner.toLowerCase(), account.address.toLowerCase(), "Unexpected UsageMeter owner");
assert.equal(configuredRelay.toLowerCase(), relay.toLowerCase(), "Relay not configured");
assert.equal(configuredUsdc.toLowerCase(), arc.usdc.address.toLowerCase(), "USDC mismatch");

const endedBalance = await wallet.getBalance({ address: account.address });
const record = {
  deployedAt: new Date().toISOString(),
  chainId: arc.chainId,
  rpcUrl: rpc,
  explorerUrl: arc.explorerUrl,
  deployer: account.address,
  receiptSigner,
  roles: { administrator: account.address, relay, treasury, team, providers, ecosystem },
  usdc: arc.usdc,
  contracts: {
    FeeVault: fees.address,
    ENCL: encl.address,
    ModelRegistry: registry.address,
    AttestationVerifier: verifier.address,
    UsageMeter: meter.address,
    InsuranceStaking: staking.address,
    AgentMandate: mandate.address,
  },
  gas: {
    adminStartUsdc: formatUnits(startedBalance, 18),
    adminEndUsdc: formatUnits(endedBalance, 18),
    spentUsdc: formatUnits(startedBalance - endedBalance, 18),
  },
  notes: [
    "MockUSDC was not deployed.",
    "Model listings still require ENCL stake and a one-hour approval timelock.",
    "Public browser checkout remains a separate frontend release flag.",
  ],
};

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ event: "complete", output, spentUsdc: record.gas.spentUsdc, usageMeter: meter.address, verifier: verifier.address }));
