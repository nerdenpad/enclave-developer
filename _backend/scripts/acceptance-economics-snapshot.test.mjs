import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { options, scopeFromPlan, databaseSnapshot, chainSnapshot, SnapshotError, safeDiagnostic, errorOutput } from "./acceptance-economics-snapshot.mjs";
const require = createRequire(resolve(process.cwd(), "package.json"));
const viem = require("viem");
const h = "0x" + "ab".repeat(32), privateOwner = "0x" + "cd".repeat(32);
const wallet = "0x" + "11".repeat(20), meter = "0x" + "22".repeat(20), verifier = "0x" + "33".repeat(20), usdc = "0x" + "44".repeat(20);
const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const scope = scopeFromPlan({ schemaVersion: 1, confirmations: 12, release: { chainId: 5042, tcbVersion: 2, modelHash: h, codeHash: h, policyHash: h, contracts: { UsageMeter: meter, AttestationVerifier: verifier, USDC: usdc } } });
test("arguments accept public IDs only and reject unknown, duplicate, missing, or malformed values", () => {
  assert.deepEqual(options(["--help"]), { help: true });
  assert.equal(options(["--plan", "plan.json", "--wallet", wallet, "--from-block", "123", "--payment-id", uuid, "--receipt-hash", h, "--idempotency-key", uuid]).fromBlock, 123n);
  for (const args of [[], ["--help", "--wallet", wallet], ["--plan", "plan.json", "--wallet", wallet, "--wallet", wallet], ["--plan", "plan.json", "--wallet", wallet, "--token", "SECRET"], ["--plan", "plan.json", "--wallet", wallet, "--from-block", "-1"], ["--plan", "plan.json", "--wallet", wallet, "--payment-id", "SECRET"], ["--plan", "plan.json", "--wallet", wallet, "--receipt-hash", "SECRET"]]) assert.throws(() => options(args), SnapshotError);
});
test("snapshot scope requires exact Arc v2 hashes and explicit contract addresses", () => {
  assert.equal(scope.receiptVersion, 2);
  for (const release of [{ chainId: 31337 }, { chainId: 5042, tcbVersion: 1 }, { chainId: 5042, tcbVersion: 2 }]) assert.throws(() => scopeFromPlan({ schemaVersion: 1, release }), SnapshotError);
});
function sqlFixture({ mapped = true, wrongReceipt = false, wrongPayment = false } = {}) {
  const statements = [];
  const sql = { begin: async (mode, fn) => {
    assert.equal(mode, "isolation level repeatable read read only");
    return fn(async (strings, ...values) => {
      const query = strings.join("?"); statements.push({ query, values });
      assert.match(query.trim(), /^select /i);
      assert.doesNotMatch(query, /(?:select\s+|,\s*)(?:token_hash|quote_json|authorization_json|response_json|sig)\s*(?:,|from)/i);
      if (query.includes("transaction_timestamp")) return [{ at: "2026-10-01T15:00:00Z" }];
      if (query.includes("from wallet_accounts")) { assert.deepEqual(values, [wallet]); return mapped ? [{ owner_hash: privateOwner }] : []; }
      if (query.includes("from receipts where receipt_version")) return [{ total: "3", anchored: "2" }];
      if (query.includes("from receipts where key_hash") && query.includes("count(*)")) { assert.equal(values[0], mapped ? privateOwner : null); return [{ total: mapped ? "1" : "0", anchored: mapped ? "1" : "0" }]; }
      if (query.includes("group by 1")) return mapped ? [{ status: "consumed", count: "1", amount: "100000" }] : [];
      if (query.includes("from usage")) return mapped ? [{ calls: 1, amount: "100000" }] : [];
      if (query.includes("from idempotency_keys") && query.includes("count(*)")) return [{ count: mapped ? "1" : "0" }];
      if (query.includes("authorization_digest")) return [{ id: uuid, status: "consumed", amount: "100000", settle_tx: h, receipt_hash: wrongPayment ? "0x" + "01".repeat(32) : h, authorization_digest: h.slice(2) }];
      if (query.includes("signed_digest")) return [{ typed_hash: h, receipt_version: 2, chain_id: 5042, verifier_address: verifier, model_hash: wrongReceipt ? "0x" + "01".repeat(32) : h, code_hash: h, status: "anchored", anchored_tx: h, signed_digest: h.slice(2), output_digest: h.slice(2), provider_digest: h.slice(2) }];
      if (query.includes("response_digest")) return [{ typed_hash: h, request_hash: h, response_digest: h.slice(2) }];
      assert.fail(`Unknown query ${query}`);
    });
  } };
  return { sql, statements };
}
test("wallet ownership uses persistent mapping; output contains only counts, identifiers and SQL-computed digests", async () => {
  const fixture = sqlFixture();
  const result = await databaseSnapshot(fixture.sql, scope, { wallet, paymentId: uuid, receiptHash: h, idempotencyKey: uuid });
  assert.deepEqual(result.ownerUsage, { calls: 1, usdcUnits: "100000" });
  assert.deepEqual(result.releaseReceipts, { total: 3, anchored: 2, ownerTotal: 1, ownerAnchored: 1 });
  assert.equal(result.target.idempotency.cachedResponseSha256, h);
  assert.equal(result.target.receipt.providerEvidenceSha256, h);
  assert.ok(fixture.statements.some(({ query }) => query.includes("sha256(convert_to(response_json")));
  assert.ok(fixture.statements.some(({ query }) => query.includes("sha256(convert_to(coalesce(provider_proof_json")));
  assert.ok(!JSON.stringify(result).includes(privateOwner));
  assert.ok(!JSON.stringify(result).includes("response_json"));
});
test("before first wallet login reports unmapped owner and zero owner metrics", async () => {
  const { sql } = sqlFixture({ mapped: false });
  const result = await databaseSnapshot(sql, scope, { wallet });
  assert.equal(result.walletOwnerMapped, false);
  assert.deepEqual(result.ownerUsage, { calls: 0, usdcUnits: "0" });
  assert.equal(result.releaseReceipts.ownerTotal, 0);
  assert.equal(result.ownerIdempotencyCount, 0);
});
test("target receipt and payment mismatches fail closed", async () => {
  for (const input of [{ wrongReceipt: true }, { wrongPayment: true }]) await assert.rejects(() => databaseSnapshot(sqlFixture(input).sql, scope, { wallet, paymentId: uuid, receiptHash: h }), SnapshotError);
});
function chainFixture({ chainId = 5042, reorg = false, wrongToken = false, badLog = false } = {}) {
  const calls = []; let blocks = 0;
  const key = viem.keccak256(viem.stringToHex(uuid));
  const client = {
    getChainId: async () => chainId,
    getBlock: async args => { calls.push(args); blocks++; return { number: args?.blockNumber ?? 112n, timestamp: 1790866800n, hash: reorg && blocks > 2 ? "0x" + "ef".repeat(32) : h }; },
    readContract: async args => { calls.push(args); assert.equal(args.blockNumber, 100n); return { spent: 100000n, balanceOf: 4000000n, usdc: wrongToken ? wallet : usdc, settled: true }[args.functionName]; },
    getLogs: async args => { calls.push(args); assert.equal(args.toBlock, 100n); assert.equal(args.fromBlock, 90n); return [{ removed: badLog, transactionHash: h, blockHash: h, blockNumber: 99n, logIndex: 0, args: { payer: wallet, amount: 100000n, receiptHash: key, confidentialPath: false } }]; },
  };
  return { client, calls, key };
}
test("chain metrics bind payer/payment and read all counters at one canonical block", async () => {
  const fixture = chainFixture();
  const result = await chainSnapshot(fixture.client, scope, { wallet, fromBlock: 90n, paymentId: uuid }, viem);
  assert.equal(result.payerSpentUnits, "100000");
  assert.equal(result.latestBlockNumber, "112");
  assert.equal(result.blockNumber, "100");
  assert.equal(result.confirmationDepth, 12);
  assert.equal(result.paymentKey, fixture.key);
  assert.equal(result.paymentSettled, true);
  assert.equal(result.eventWindow.targetSettledCount, 1);
  assert.equal(result.eventWindow.targetSettledAmountUnits, "100000");
  assert.equal(result.eventWindow.payerSettledCount, 1);
  assert.equal(result.eventWindow.targetTransactions[0].transactionHash, h);
});
test("default snapshot does no unbounded log query", async () => {
  const { client } = chainFixture(); client.getLogs = () => assert.fail("unexpected logs");
  const result = await chainSnapshot(client, scope, { wallet }, viem);
  assert.equal(result.eventWindow, null);
  assert.equal(result.paymentSettled, null);
});
test("chain mismatch, reorg, token drift, removed log and oversized range fail closed", async () => {
  for (const flags of [{ chainId: 31337 }, { reorg: true }, { wrongToken: true }, { badLog: true }]) await assert.rejects(() => chainSnapshot(chainFixture(flags).client, scope, { wallet, fromBlock: 90n, paymentId: uuid }, viem), SnapshotError);
  const fixture = chainFixture(); fixture.client.getBlock = async args => ({ number: args?.blockNumber ?? 20000n, timestamp: 1790866800n, hash: h }); fixture.client.readContract = async args => ({ spent: 0n, balanceOf: 0n, usdc })[args.functionName];
  await assert.rejects(() => chainSnapshot(fixture.client, scope, { wallet, fromBlock: 0n }, viem), /BLOCK_WINDOW_INVALID/);
});
test("diagnostics expose only allowlisted names/codes and identifier-shaped schema fields", () => {
  const secret = "postgres://private-user:PRIVATE_PASSWORD@private-host/private-db";
  const missing = { name: "PostgresError", code: "42703", message: 'column "receipt_version" does not exist', query: `select SECRET`, parameters: [secret], detail: secret };
  assert.deepEqual(safeDiagnostic(missing, "database"), { stage: "database", name: "PostgresError", errorCode: "42703", missingColumn: "receipt_version" });
  assert.deepEqual(safeDiagnostic({ name: "PostgresError", code: "42P01", message: 'relation "wallet_accounts" does not exist' }, "database"), { stage: "database", name: "PostgresError", errorCode: "42P01", missingTable: "wallet_accounts" });
  const output = errorOutput(new SnapshotError("SNAPSHOT_FAILED", safeDiagnostic({ name: secret, code: secret, column: secret, message: secret, cause: { name: "HttpRequestError", message: secret } }, "chain")));
  assert.equal(output.diagnostic.name, "HttpRequestError");
  assert.ok(!JSON.stringify(output).includes(secret));
  assert.ok(!JSON.stringify(errorOutput(missing)).includes("parameters"));
  assert.deepEqual(safeDiagnostic({ name: "PostgresError", code: "42703", column: secret, message: secret }, "database"), { stage: "database", name: "PostgresError", errorCode: "42703" });
  assert.equal(safeDiagnostic({ name: "PostgresError", code: "42883", message: 'function sha256(bytea) does not exist' }, "database").missingFunction, "sha256(bytea)");
  assert.equal(safeDiagnostic({ name: "RpcRequestError", code: -32000, message: secret }, "chain").rpcCode, -32000);
  assert.ok(!Object.hasOwn(safeDiagnostic({ name: "RpcRequestError", code: -987654, message: secret }, "chain"), "rpcCode"));
});
test("failed contract reads identify only the fixed function and safe RPC code", async () => {
  const { client } = chainFixture();
  client.readContract = async () => { throw { name: "ContractFunctionExecutionError", message: "PRIVATE_RPC_URL", cause: { name: "RpcRequestError", code: -32000, message: "PRIVATE_RPC_URL" } }; };
  await assert.rejects(() => chainSnapshot(client, scope, { wallet }, viem), error => {
    assert.equal(error.code, "CHAIN_READ_FAILED");
    assert.equal(error.diagnostic.functionName, "spent");
    assert.equal(error.diagnostic.rpcCode, -32000);
    assert.ok(!JSON.stringify(errorOutput(error)).includes("PRIVATE_RPC_URL"));
    return true;
  });
});
