import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createPublicClient, formatUnits, getAddress, http, parseEther, zeroAddress } from "viem";
import arc from "../src/enclave/arc-mainnet.json" with { type: "json" };

// Public addresses only. Checks do not establish ownership or grant signing access.
const reserves = { administrator: "2", relay: "10", treasury: "0", testPayer: "3" };
try {
  const input = process.argv[2];
  assert(input, "Usage: npm run check:arc-wallets -- .local/arc-wallets.json");
  assert(statSync(input).size <= 16384, "Wallet address file is too large");
  const config = JSON.parse(readFileSync(input, "utf8"));
  assert(config && typeof config === "object" && !Array.isArray(config), "Expected an address map");
  assert.deepEqual(Object.keys(config).sort(), Object.keys(reserves).sort(), "Supply exactly four public wallet addresses, without private keys");
  const addresses = Object.fromEntries(Object.keys(reserves).map(role => {
    assert(typeof config[role] === "string" && /^0x[0-9a-fA-F]{40}$/.test(config[role]), `Missing or invalid public address: ${role}`);
    const address = getAddress(config[role]);
    assert(address !== zeroAddress && address.toLowerCase() !== arc.usdc.address.toLowerCase(), `Invalid wallet: ${role}`);
    return [role, address];
  }));
  assert(new Set(Object.values(addresses).map(value => value.toLowerCase())).size === 4, "Use distinct wallets for administration, relay, treasury and testing");
  const client = createPublicClient({ transport: http(arc.rpcUrl, { timeout: 15000, retryCount: 0 }) });
  assert.equal(await client.getChainId(), arc.chainId, "Wrong RPC chain");
  const block = await client.getBlock();
  assert(block.number !== null && block.hash, "Missing block");
  const wallets = await Promise.all(Object.entries(addresses).map(async ([role, address]) => {
    const [balance, code] = await Promise.all([client.getBalance({ address, blockNumber: block.number }), client.getCode({ address, blockNumber: block.number })]);
    const required = parseEther(reserves[role]);
    const supported = role === "treasury" || !code || code === "0x";
    return { role, address, balanceUsdc: formatUnits(balance, 18), suggestedReserveUsdc: reserves[role],
      shortfallUsdc: formatUnits(balance < required ? required - balance : 0n, 18), supportedAccount: supported,
      ready: supported && balance >= required };
  }));
  assert.equal((await client.getBlock({ blockNumber: block.number })).hash, block.hash, "Block changed during check");
  const ready = wallets.every(wallet => wallet.ready);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), chainId: arc.chainId, block: String(block.number),
    wallets, ready, transactionsSent: 0, ownershipVerified: false,
    note: "Suggested startup reserves, not a fee quote. Token and native balances are the same USDC; counted once. Payment acceptance and secure signing setup are separate." }, null, 2));
  if (!ready) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ ready: false, transactionsSent: 0, error: error.shortMessage ?? error.message }));
  process.exitCode = 1;
}
