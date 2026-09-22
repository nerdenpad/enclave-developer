import { config as loadDotenv } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createWalletClient, http, parseEther, publicActions, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { measurementOf, sha256Hex } from "@enclave/core";
import { loadOrCreateCvmKeys } from "../apps/api/src/cvm-store.ts";

loadDotenv();

type Artifact = { abi: readonly unknown[]; bytecode: Hex };

function art(name: string): Artifact {
  return JSON.parse(readFileSync(path.resolve("contracts/out-solc", `${name}.json`), "utf8")) as Artifact;
}

function patchEnv(updates: Record<string, string>) {
  const envPath = path.resolve(process.env.ENCLAVE_DEPLOY_ENV_PATH ?? ".env");
  let text = readFileSync(envPath, "utf8");
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.trim()}\n${line}\n`;
  }
  writeFileSync(envPath, text);
}

async function main() {
  const pk = (process.env.DEPLOYER_PRIVATE_KEY ??
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
  const rpc = process.env.ARC_RPC_URL ?? "http://127.0.0.1:8545";
  const { stored } = await loadOrCreateCvmKeys();
  const signer = privateKeyToAccount(stored.enclavePrivateKey).address;
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    account,
    chain: foundry,
    pollingInterval: process.env.NODE_ENV === "test" ? 25 : 4_000,
    transport: http(rpc),
  }).extend(publicActions);

  async function deploy(name: string, args: unknown[] = []) {
    const { abi, bytecode } = art(name);
    const hash = await wallet.deployContract({ abi, bytecode, args });
    const receipt = await wallet.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) {
      throw new Error(`no address for ${name}`);
    }
    console.log(name, receipt.contractAddress);
    return { address: receipt.contractAddress, abi };
  }

  const usdc = await deploy("MockUSDC");
  const fees = await deploy("FeeVault", [usdc.address]);
  const encl = await deploy("ENCL", [account.address, account.address, account.address, account.address, parseEther("1000000")]);
  const listingStake = parseEther("1");
  const registry = await deploy("ModelRegistry", [encl.address, listingStake]);
  const verifier = await deploy("AttestationVerifier", [registry.address, signer]);
  const meter = await deploy("UsageMeter", [usdc.address, fees.address]);
  const staking = await deploy("InsuranceStaking", [encl.address]);
  const mandate = await deploy("AgentMandate");
  const confidential = await deploy("MockConfidentialTransfer");
  const splitHash = await wallet.writeContract({
    address: fees.address,
    abi: fees.abi,
    functionName: "setSplit",
    args: [account.address, staking.address, account.address, account.address],
  });
  await wallet.waitForTransactionReceipt({ hash: splitHash });
  const confHash = await wallet.writeContract({
    address: meter.address,
    abi: meter.abi,
    functionName: "setConfidential",
    args: [confidential.address],
  });
  await wallet.waitForTransactionReceipt({ hash: confHash });
  for (const [contract, functionName, args] of [
    [mandate, "setSettlementMeter", [meter.address]],
    [meter, "setMandate", [mandate.address]],
    [meter, "setModelRegistry", [registry.address]],
    [staking, "configureRewards", [usdc.address]],
  ] as const) {
    const hash = await wallet.writeContract({ address: contract.address, abi: contract.abi, functionName, args });
    const receipt = await wallet.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Configuration reverted: ${functionName}`);
  }

  const policy = {
    version: Number(process.env.TCB_POLICY_VERSION ?? "1"),
    servingImageId: process.env.SERVING_IMAGE_ID ?? "enclave-echo-v1",
    requireCpuTee: true as const,
    requireGpuCc: true as const,
  };
  const modelHash = sha256Hex("model:echo");
  const codeHash = measurementOf(policy);
  const approveEncl = await wallet.writeContract({
    address: encl.address,
    abi: encl.abi,
    functionName: "approve",
    args: [registry.address, listingStake],
  });
  await wallet.waitForTransactionReceipt({ hash: approveEncl });
  const listHash = await wallet.writeContract({
    address: registry.address,
    abi: registry.abi,
    functionName: "list",
    args: [modelHash, codeHash, 0],
  });
  await wallet.waitForTransactionReceipt({ hash: listHash });
  const approveHash = await wallet.writeContract({
    address: registry.address,
    abi: registry.abi,
    functionName: "bootstrapApprove",
    args: [1n],
  });
  await wallet.waitForTransactionReceipt({ hash: approveHash });

  const updates = {
    ATTESTATION_VERIFIER_ADDRESS: verifier.address,
    MODEL_REGISTRY_ADDRESS: registry.address,
    USAGE_METER_ADDRESS: meter.address,
    FEE_VAULT_ADDRESS: fees.address,
    ENCL_TOKEN_ADDRESS: encl.address,
    USDC_ADDRESS: usdc.address,
    INSURANCE_STAKING_ADDRESS: staking.address,
    AGENT_MANDATE_ADDRESS: mandate.address,
    CONFIDENTIAL_TRANSFER_ADDRESS: confidential.address,
    ENCLAVE_SIGNER: signer,
  };
  patchEnv(updates);
  writeFileSync(path.resolve(process.env.ENCLAVE_ADDRESSES_PATH ?? "data/addresses.json"), `${JSON.stringify({ ...updates, deployer: account.address }, null, 2)}\n`);
  console.log("enclaveSigner", signer);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
