import assert from "node:assert/strict";
import { createPublicClient, hashDomain, http, parseAbi } from "viem";
import arc from "../src/enclave/arc-mainnet.json" with { type: "json" };

// Read-only preflight. This script never loads a wallet key or sends a transaction.
const client = createPublicClient({ transport: http(arc.rpcUrl, { timeout: 15_000, retryCount: 0 }) });
const abi = parseAbi(["function name() view returns (string)", "function version() view returns (string)",
  "function decimals() view returns (uint8)", "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function authorizationState(address,bytes32) view returns (bool)"]);
try {
  assert.equal(await client.getChainId(), arc.chainId, "RPC chain does not match Arc Mainnet");
  const block = await client.getBlock();
  assert(block.hash && block.number !== null, "RPC returned no canonical block");
  const read = functionName => client.readContract({ address: arc.usdc.address, abi, functionName, blockNumber: block.number });
  const [name, version, decimals, domain, used] = await Promise.all([
    read("name"), read("version"), read("decimals"), read("DOMAIN_SEPARATOR"),
    client.readContract({ address: arc.usdc.address, abi, functionName: "authorizationState", blockNumber: block.number,
      args: ["0x1111111111111111111111111111111111111111", `0x${"00".repeat(32)}`] }),
  ]);
  assert.equal(name, arc.usdc.eip712Name, "Unexpected USDC signing name");
  assert.equal(version, arc.usdc.eip712Version, "Unexpected USDC signing version");
  assert.equal(decimals, arc.usdc.decimals, "Unexpected ERC-20 decimals");
  const computed = hashDomain({ domain: { name, version, chainId: arc.chainId, verifyingContract: arc.usdc.address }, types: {
    EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
  } });
  assert.equal(domain, computed, "USDC EIP-712 domain mismatch");
  assert.equal(domain, arc.usdc.domainSeparator, "USDC domain changed from the reviewed profile");
  assert.equal(typeof used, "boolean", "EIP-3009 read method unavailable");
  assert.equal((await client.getBlock({ blockNumber: block.number })).hash, block.hash, "Block changed during preflight");
  console.log(JSON.stringify({ network: arc.name, chainId: arc.chainId, checkedAt: new Date().toISOString(), block: String(block.number), blockHash: block.hash,
    token: arc.usdc.address, name, version, decimals, domainSeparator: domain, passed: true, transactionsSent: 0, paymentAcceptance: "not performed" }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ passed: false, error: error.shortMessage ?? error.message, transactionsSent: 0 }));
  process.exitCode = 1;
}
