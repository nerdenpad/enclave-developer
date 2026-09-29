import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, parseAbi } from "viem";
import { parseOptions, prepare } from "./prepare-arc-model-listing.mjs";

const administrator = "0x1111111111111111111111111111111111111111";
const registry = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const codeHash = `0x${"44".repeat(32)}`;
const policyHash = `0x${"55".repeat(32)}`;
const record = { chainId: 5042, contracts: { ModelRegistry: registry, ENCL: token }, roles: { administrator } };
const options = parseOptions(["--model", "z-ai/glm-5.3-flash", "--code-hash", codeHash, "--policy-hash", policyHash, "--policy-version", "1"]);

function rpc({ existing = 0n, existingPolicyHash = policyHash, balance = 2n * 10n ** 18n, allowance = 0n, gas = 10n ** 18n, owner = administrator } = {}) {
  const calls = [];
  return { calls, client: {
    async getChainId() { return 5042; },
    async getBlock() { return { number: 12n, hash: `0x${"aa".repeat(32)}` }; },
    async getBalance() { return gas; },
    async readContract(call) {
      calls.push(call);
      switch (call.functionName) {
        case "owner": return owner;
        case "encl": return token;
        case "listingStake": return 10n ** 18n;
        case "idByHashes": return existing;
        case "listingPolicy": return [existingPolicyHash, 1n];
        case "balanceOf": return balance;
        case "allowance": return allowance;
        default: throw Error(`Unexpected read ${call.functionName}`);
      }
    },
  } };
}

test("rejects missing final hashes, unsupported network and invalid shares", async () => {
  assert.throws(() => parseOptions(["--model", options.model, "--code-hash", codeHash, "--policy-hash", `0x${"00".repeat(32)}`, "--policy-version", "1"]));
  assert.throws(() => parseOptions(["--model", options.model, "--code-hash", codeHash, "--policy-hash", policyHash, "--policy-version", "1", "--bps", "10001"]));
  await assert.rejects(prepare(options, { getChainId: async () => 31337 }, record), /not Arc Mainnet/);
});

test("prepares exact approval and immutable policy listing without sending a transaction", async () => {
  const { client, calls } = rpc();
  const result = await prepare(options, client, record);
  assert.equal(result.status, "prepared-only");
  assert.equal(result.transactionsSent, 0);
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].to, token);
  assert.equal(result.transactions[1].to, registry);
  assert(calls.every(call => call.blockNumber === 12n));
  const listingAbi = parseAbi(["function listWithPolicy(bytes32,bytes32,uint16,bytes32,uint64) returns (uint256)"]);
  const decoded = decodeFunctionData({ abi: listingAbi, data: result.transactions[1].data });
  assert.equal(decoded.functionName, "listWithPolicy");
  assert.deepEqual(decoded.args, [result.modelHash, codeHash, 0, policyHash, 1n]);
});

test("does not prepare a duplicate or an unfunded listing", async () => {
  const existing = await prepare(options, rpc({ existing: 7n }).client, record);
  assert.equal(existing.status, "already-listed-policy-match");
  assert.deepEqual(existing.transactions, []);
  const wrongPolicy = await prepare(options, rpc({ existing: 7n, existingPolicyHash: codeHash }).client, record);
  assert.equal(wrongPolicy.status, "already-listed-policy-mismatch");
  assert.deepEqual(wrongPolicy.transactions, []);
  const unfunded = await prepare(options, rpc({ balance: 0n }).client, record);
  assert.equal(unfunded.status, "insufficient-encl-stake");
  assert.deepEqual(unfunded.transactions, []);
  const noGas = await prepare(options, rpc({ gas: 0n }).client, record);
  assert.equal(noGas.status, "insufficient-gas");
  assert.deepEqual(noGas.transactions, []);
});

test("fails when the registry owner differs from the reviewed record", async () => {
  await assert.rejects(prepare(options, rpc({ owner: token }).client, record), /differs/);
});
