import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { collectNoSpend, options } from "./collect-acceptance-no-spend.mjs";
import { scopeFromPlan } from "./acceptance-economics-snapshot.mjs";
const require = createRequire(resolve(process.cwd(), "package.json")), viem = require("viem");
// Entirely synthetic counters/identities. No private files, incidents, providers or RPC.
const h = "0x" + "12".repeat(32), id = "11111111-1111-4111-8111-111111111111", wallet = "0x" + "55".repeat(20);
const a = value => "0x" + value.repeat(20);
const plan = { schemaVersion: 1, confirmations: 12, expectedPriceUnits: "100000", release: { chainId: 5042, tcbVersion: 2,
  modelHash: h, codeHash: h, policyHash: h, contracts: { UsageMeter: a("22"), AttestationVerifier: a("33"), USDC: a("44") } } };
const scope = scopeFromPlan(plan), nonce = viem.keccak256(viem.stringToHex(id));
const counters = { ownerUsage: { calls: 0, usdcUnits: "0" }, releaseReceipts: { ownerTotal: 0 }, ownerIdempotencyCount: 0 };
const baseline = { schemaVersion: 1, wallet, scope, chain: { capturedAt: "2026-01-02T12:00:00Z", blockNumber: "100", payerSpentUnits: "0", payerBalanceUnits: "5000000" }, database: counters };
const snapshot = { schemaVersion: 1, wallet, scope, chain: { capturedAt: "2026-01-02T12:20:00Z", blockNumber: "200", blockHash: h,
  payerSpentUnits: "0", payerBalanceUnits: "5000000", paymentKey: nonce, paymentSettled: false,
  eventWindow: { fromBlock: "100", toBlock: "200", targetSettledCount: 0, targetSettledAmountUnits: "0", payerSettledCount: 0, payerSettledAmountUnits: "0", targetTransactions: [] } },
  database: { ...counters, target: { payment: { id, status: "open", amountUnits: "100000", settleTx: null, receiptHash: null,
    authorizationSha256: "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }, receipt: null, idempotency: null } } };
function fixture() {
  const reads = [], opts = { paymentId: id, nonce, journalSha256: h, reviewedBy: "Synthetic test", authorizationExpiresAt: "2026-01-02T12:15:00Z" };
  const client = { getChainId: async () => 5042, readContract: async call => { reads.push(call); return false; }, getLogs: async call => { reads.push(call); return []; },
    getBlock: async call => { reads.push(call); return { number: BigInt(snapshot.chain.blockNumber), hash: snapshot.chain.blockHash, timestamp: BigInt(Date.parse(snapshot.chain.capturedAt) / 1000) }; } };
  const sql = { begin: async (mode, fn) => { assert.equal(mode, "isolation level repeatable read read only"); return fn(async (strings, ...values) => {
    assert.equal(values[0], `payment:${id}:%`); assert.match(strings.join("?"), /from chain_transactions where operation_key like/);
    assert.doesNotMatch(strings.join("?"), /raw_transaction|authorization_json|response_json|select \*/);
    return [{ checked_at: "2026-01-02T12:21:00Z", count: "0" }];
  }); } };
  return { reads, input: { sql, client, viem, plan, planHash: h, baseline: structuredClone(baseline), snapshot: structuredClone(snapshot), opts } };
}
test("supplements the recorded snapshot without repeating settlement, spend, payment or usage reads", async () => {
  const { reads, input } = fixture(), proof = await collectNoSpend(input);
  assert.equal(proof.database.paymentSignedTransactionCount, 0); assert.equal(proof.chain.authorizationUsed, false);
  assert.equal(proof.chain.blockTimestamp, String(Date.parse(snapshot.chain.capturedAt) / 1000));
  assert.equal(proof.journalSha256, h); assert.equal(reads.filter(call => call.functionName).length, 1);
  assert.equal(reads[0].functionName, "authorizationState"); assert.equal(reads[0].blockNumber, BigInt(snapshot.chain.blockNumber));
  assert.deepEqual(reads[0].args, [snapshot.wallet, snapshot.chain.paymentKey]);
  assert.deepEqual(proof.database.ownerUsageCurrent, { calls: 0, usdcUnits: "0" });
  assert.ok(!JSON.stringify(proof).includes("authorizationSha256"));
});
test("refuses used/cancelled authorization, authorization events and signed payment transactions", async () => {
  for (const change of ["used", "event", "signed"]) {
    const { input } = fixture();
    if (change === "used") input.client.readContract = async () => true;
    if (change === "event") input.client.getLogs = async () => [{ args: { nonce: snapshot.chain.paymentKey } }];
    if (change === "signed") input.sql.begin = async (_mode, callback) => callback(async () => [{ checked_at: "2026-01-02T12:21:00Z", count: "1" }]);
    await assert.rejects(() => collectNoSpend(input));
  }
});
test("refuses mismatched nonce, dirty database state, changed economics or insufficient expiry coverage", async () => {
  for (const change of ["nonce", "auth", "usage", "settled", "expiry", "scope", "receipt"]) {
    const { input } = fixture();
    if (change === "nonce") input.opts.nonce = h;
    if (change === "auth") input.snapshot.database.target.payment.authorizationSha256 = h;
    if (change === "usage") input.snapshot.database.ownerUsage.calls = 1;
    if (change === "settled") input.snapshot.chain.paymentSettled = true;
    if (change === "expiry") input.opts.authorizationExpiresAt = "2026-01-02T12:30:00Z";
    if (change === "scope") input.snapshot.scope.chainId = 1;
    if (change === "receipt") input.snapshot.database.target.receipt = { typedHash: h };
    await assert.rejects(() => collectNoSpend(input));
  }
});
test("refuses block drift and protects output from extra private snapshot properties", async () => {
  const bad = fixture(); bad.input.client.getBlock = async () => ({ number: BigInt(snapshot.chain.blockNumber), hash: h, timestamp: 0n });
  await assert.rejects(() => collectNoSpend(bad.input), /CHAIN_REORG/);
  const good = fixture(); good.input.snapshot.database.ownerUsage.secret = "DO_NOT_EMIT"; good.input.baseline.database.ownerUsage.secret = "DO_NOT_EMIT";
  assert.ok(!JSON.stringify(await collectNoSpend(good.input)).includes("DO_NOT_EMIT"));
});
test("collector CLI requires all public bindings and exposes help without an environment", () => {
  assert.deepEqual(options(["--help"]), { help: true }); assert.throws(() => options([]));
  assert.throws(() => options(["--journal-sha256", "PRIVATE_KEY"]));
});
