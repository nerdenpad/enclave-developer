import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, hashTypedData, http, zeroAddress, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { browserRpc, receiptTypedData, verifyOnchainReceipt, type PortableReceipt } from "../src/enclave/receipt-verifier";

// Disposable, unfunded outside Anvil. Never reads a project .env or a real wallet.
const image = "ghcr.io/foundry-rs/foundry@sha256:0c00cb0bda1ab1b91c9a6bf60f4c76c09c1a8870824b6d4718afbabacf6f9a17";
const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const endpoint = process.env["DOCKER_CONTEXT"]
  ? docker(["context", "inspect", process.env["DOCKER_CONTEXT"], "--format", "{{.Endpoints.docker.Host}}"])
  : process.env["DOCKER_HOST"] || docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
if (!/^(unix|npipe):\/\//.test(endpoint)) throw new Error("This test requires a local Docker engine.");
const artifacts = new URL("../../_backend/contracts/out-solc/", import.meta.url);
const artifact = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, artifacts), "utf8")) as { abi: Abi; bytecode: Hex };
const registryArtifact = artifact("ModelRegistry"), verifierArtifact = artifact("AttestationVerifier");
let container: string | undefined;
try {
  container = docker(["run", "--rm", "-d", "--publish", "127.0.0.1::8545", "--label", "enclave-purpose=receipt-verification-test", "--entrypoint", "anvil", image, "--host", "0.0.0.0", "--chain-id", "31337"]);
  if (!/^[a-f0-9]{64}$/.test(container)) throw new Error("Docker did not return a container ID.");
  const binding = docker(["port", container, "8545/tcp"]).match(/^127\.0\.0\.1:(\d+)$/);
  if (!binding) throw new Error("Expected a loopback-only ephemeral Anvil port.");
  const url = `http://127.0.0.1:${binding[1]}`;
  const publicClient = createPublicClient({ chain: anvil, transport: http(url, { retryCount: 0, timeout: 5000 }), pollingInterval: 100 });
  let ready = false;
  for (let i = 0; i < 30; i++) { try { ready = await publicClient.getChainId() === 31337; if (ready) break; } catch { /* Local startup only. */ } await new Promise(resolve => setTimeout(resolve, 500)); }
  assert(ready, "Local Anvil did not become ready");
  const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const wallet = createWalletClient({ account, chain: anvil, transport: http(url, { retryCount: 0 }) });
  const mined = async (hash: Hex) => { const tx = await publicClient.waitForTransactionReceipt({ hash }); assert.equal(tx.status, "success"); return tx; };
  const registry = (await mined(await wallet.deployContract({ ...registryArtifact, args: [zeroAddress, 0n] }))).contractAddress!;
  const verifier = (await mined(await wallet.deployContract({ ...verifierArtifact, args: [registry, signer.address] }))).contractAddress!;
  const h = (byte: string) => `0x${byte.repeat(32)}` as Hex;
  await mined(await wallet.writeContract({ address: registry, abi: registryArtifact.abi, functionName: "listWithPolicy", args: [h("02"), h("03"), 100, h("09"), 3n] }));
  await mined(await wallet.writeContract({ address: registry, abi: registryArtifact.abi, functionName: "bootstrapApprove", args: [1n] }));
  const receipt: PortableReceipt = { receiptVersion: 2, chainId: 31337, verifierAddress: verifier, nonce: h("01"), modelHash: h("02"), codeHash: h("03"), inHash: h("04"), outHash: h("05"), attRef: h("06"), ts: "1800000000", sig: `0x${"00".repeat(65)}`, typedHash: h("00") };
  const typed = receiptTypedData(receipt); receipt.sig = await signer.signTypedData(typed); receipt.typedHash = hashTypedData(typed);
  receipt.anchoredTx = (await mined(await wallet.writeContract({ address: verifier, abi: verifierArtifact.abi, functionName: "verifyReceipt", args: [typed.message, receipt.sig] }))).transactionHash;
  const trust = { chainId: 31337, verifierAddress: verifier, signer: signer.address };
  const rpc = browserRpc(url, new AbortController().signal);
  const verified = await verifyOnchainReceipt(receipt, trust, rpc);
  assert.equal(verified.anchor.status, "confirmed"); assert.equal(verified.policyBound, true); assert.equal(verified.policyVersion, "3"); assert.equal(verified.policyHash, h("09"));
  await mined(await wallet.writeContract({ address: registry, abi: registryArtifact.abi, functionName: "revoke", args: [1n] }));
  await assert.rejects(verifyOnchainReceipt(receipt, trust, rpc), /RPC request failed/);
  const results = new URL("../test-results/", import.meta.url); mkdirSync(results, { recursive: true });
  writeFileSync(new URL("receipt-chain.json", results), JSON.stringify({ receipt, trust, checked: verified, note: "Disposable local test chain only; removed after the check. Not a production receipt." }, null, 2));
  console.log(JSON.stringify({ network: "isolated-anvil", paidProviderCalls: 0, actualContractAcceptance: true, actualAnchorEvent: true, policyBinding: true, revocationRejected: true }));
} finally {
  // Only the container created by this invocation; no project volumes or existing chains.
  if (container && /^[a-f0-9]{64}$/.test(container)) docker(["stop", "--time", "3", container]);
}
