import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createPublicClient, encodeDeployData, formatUnits, http, parseEther, zeroAddress } from "viem";
import arc from "../src/enclave/arc-mainnet.json" with { type: "json" };

// No wallet, signing key, env-file loading or send-transaction API is used.
// Stand-in constructor addresses are only for estimation, never funding targets.
const address = index => `0x${index.toString(16).padStart(40, "0")}`;
const contracts = [
  ["ENCL", [address(1), address(2), address(3), address(4), parseEther("1000000")]],
  ["FeeVault", [arc.usdc.address]],
  ["ModelRegistry", [address(5), parseEther("1")]],
  ["AttestationVerifier", [address(6), address(7)]],
  ["UsageMeter", [arc.usdc.address, address(8)]],
  ["InsuranceStaking", [address(5)]],
  ["AgentMandate", []],
];
const client = createPublicClient({ transport: http(arc.rpcUrl, { timeout: 20_000, retryCount: 0 }) });
try {
  assert.equal(await client.getChainId(), arc.chainId, "Wrong chain");
  const gasPrice = await client.getGasPrice();
  assert(gasPrice > 0n, "Invalid gas price");
  const rows = [];
  for (const [name, args] of contracts) {
    const artifact = JSON.parse(readFileSync(new URL(`../../_backend/contracts/out-solc/${name}.json`, import.meta.url), "utf8"));
    assert(/^0x[0-9a-f]+$/i.test(artifact.bytecode), `Compile ${name} first`);
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
    const gas = await client.estimateGas({ account: zeroAddress, data });
    rows.push({ contract: name, gas: String(gas), estimatedUsdc: formatUnits(gas * gasPrice, 18),
      bytecodeSha256: createHash("sha256").update(artifact.bytecode).digest("hex") });
  }
  const deploymentGas = rows.reduce((sum, row) => sum + BigInt(row.gas), 0n);
  // Explicit planning allowances; these are not RPC measurements of configuration or paid requests.
  const configurationGasAllowance = 2_000_000n;
  const perRequestGasAllowance = 750_000n;
  const planningGasPrice = gasPrice * 5n;
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), chainId: arc.chainId, transactionsSent: 0,
    scope: "Read-only constructor estimates; configuration and request allowances are assumptions. Not an approved deployment plan.",
    gasPriceNativeUnits: String(gasPrice), contracts: rows,
    deploymentOnlyUsdc: formatUnits(deploymentGas * gasPrice, 18),
    planning: { feeMultiplier: 5, configurationGasAllowance: String(configurationGasAllowance), perRequestGasAllowance: String(perRequestGasAllowance),
      deploymentAndConfigurationReserveUsdc: formatUnits((deploymentGas + configurationGasAllowance) * planningGasPrice, 18),
      perRequestNetworkAllowanceUsdc: formatUnits(perRequestGasAllowance * planningGasPrice, 18),
      excludes: ["Model inference", "Hosting", "Wallet transfers and bridges", "Revenue distribution", "Token economics approval", "Failed or repeated transactions"] },
    fundingInstructions: "Do not fund stand-in addresses. Re-estimate with approved parameters and actual addresses before deployment." }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ passed: false, transactionsSent: 0, error: error.shortMessage ?? error.message }));
  process.exitCode = 1;
}
