/** Supplement existing exact snapshots; no signing, wallet key/bearer, or state writes. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SnapshotError, safeDiagnostic, scopeFromPlan } from "./acceptance-economics-snapshot.mjs";
const HASH = /^0x[0-9a-fA-F]{64}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emptyHash = "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
function need(condition, code) { if (!condition) throw new SnapshotError(code); }
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const sha = bytes => `0x${createHash("sha256").update(bytes).digest("hex")}`;
export function options(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const allowed = new Set(["--plan", "--baseline", "--snapshot", "--journal-sha256", "--payment-id", "--nonce", "--authorization-expires-at", "--reviewed-by"]), values = {};
  for (let i = 0; i < args.length; i++) { const key = args[i], value = args[++i]; need(allowed.has(key) && !Object.hasOwn(values, key) && typeof value === "string" && value && !value.startsWith("--"), "ARGUMENTS_INVALID"); values[key] = value; }
  need([...allowed].every(key => values[key]) && HASH.test(values["--journal-sha256"]) && HASH.test(values["--nonce"]) && UUID.test(values["--payment-id"])
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(values["--authorization-expires-at"])
    && Number.isFinite(Date.parse(values["--authorization-expires-at"])) && /^[a-zA-Z0-9 _.-]{1,128}$/.test(values["--reviewed-by"]), "ARGUMENTS_INVALID");
  return { help: false, plan: resolve(values["--plan"]), baseline: resolve(values["--baseline"]), snapshot: resolve(values["--snapshot"]), journalSha256: values["--journal-sha256"].toLowerCase(),
    paymentId: values["--payment-id"], nonce: values["--nonce"].toLowerCase(), authorizationExpiresAt: values["--authorization-expires-at"], reviewedBy: values["--reviewed-by"] };
}
export async function collectNoSpend({ sql, client, viem, plan, planHash, baseline, snapshot, opts }) {
  const scope = scopeFromPlan(plan), payment = snapshot?.database?.target?.payment, window = snapshot?.chain?.eventWindow;
  const wallet = snapshot?.wallet;
  need(baseline?.schemaVersion === 1 && snapshot?.schemaVersion === 1 && /^0x[0-9a-f]{40}$/i.test(wallet ?? "") && same(wallet, baseline.wallet), "SNAPSHOT_SCOPE_MISMATCH");
  for (const source of [baseline, snapshot]) for (const key of Object.keys(scope)) need(source.scope?.[key] === scope[key], "SNAPSHOT_SCOPE_MISMATCH");
  for (const source of [baseline, snapshot]) need(Number.isSafeInteger(source.database?.ownerUsage?.calls) && source.database.ownerUsage.calls >= 0
    && /^(0|[1-9][0-9]{0,77})$/.test(source.database.ownerUsage.usdcUnits) && Number.isSafeInteger(source.database?.releaseReceipts?.ownerTotal)
    && source.database.releaseReceipts.ownerTotal >= 0 && Number.isSafeInteger(source.database?.ownerIdempotencyCount) && source.database.ownerIdempotencyCount >= 0, "SNAPSHOT_SHAPE_INVALID");
  need(same(viem.keccak256(viem.stringToHex(opts.paymentId)), opts.nonce) && same(snapshot.chain.paymentKey, opts.nonce)
    && payment?.id === opts.paymentId && payment.status === "open" && payment.amountUnits === plan.expectedPriceUnits && payment.settleTx === null && payment.receiptHash === null
    && same(payment.authorizationSha256, emptyHash) && snapshot.database.target.receipt === null && snapshot.database.target.idempotency === null, "PAYMENT_NOT_PROVEN_OPEN_UNSUBMITTED");
  need(snapshot.chain.paymentSettled === false && window && window.fromBlock === baseline.chain.blockNumber && window.toBlock === snapshot.chain.blockNumber
    && window.targetSettledCount === 0 && window.targetSettledAmountUnits === "0" && window.payerSettledCount === 0 && window.payerSettledAmountUnits === "0" && window.targetTransactions?.length === 0, "SETTLEMENT_NOT_PROVEN_UNUSED");
  need(snapshot.chain.payerSpentUnits === baseline.chain.payerSpentUnits && snapshot.chain.payerBalanceUnits === baseline.chain.payerBalanceUnits
    && snapshot.database.ownerUsage.calls === baseline.database.ownerUsage.calls && snapshot.database.ownerUsage.usdcUnits === baseline.database.ownerUsage.usdcUnits
    && snapshot.database.releaseReceipts.ownerTotal === baseline.database.releaseReceipts.ownerTotal && snapshot.database.ownerIdempotencyCount === baseline.database.ownerIdempotencyCount, "RECOVERY_ECONOMICS_CHANGED");
  const fromBlock = BigInt(window.fromBlock), blockNumber = BigInt(snapshot.chain.blockNumber), expiresAt = Date.parse(opts.authorizationExpiresAt);
  const baselineAt = Date.parse(baseline.chain.capturedAt), blockAt = Date.parse(snapshot.chain.capturedAt);
  need(fromBlock <= blockNumber && blockNumber - fromBlock <= 10_000n && Number.isFinite(baselineAt) && Number.isFinite(blockAt)
    && baselineAt <= expiresAt - 600_000 && blockAt >= expiresAt, "EXPIRED_AUTHORIZATION_WINDOW_NOT_COVERED");
  need(await client.getChainId() === 5042, "CHAIN_ID_MISMATCH");
  const tokenAbi = viem.parseAbi(["function authorizationState(address,bytes32) view returns(bool)"]);
  const unused = await client.readContract({ address: scope.usdc, abi: tokenAbi, functionName: "authorizationState", args: [wallet, opts.nonce], blockNumber });
  need(unused === false, "TOKEN_AUTHORIZATION_USED_OR_CANCELLED");
  const logs = await client.getLogs({ address: scope.usdc, event: viem.parseAbiItem("event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)"),
    args: { authorizer: wallet, nonce: opts.nonce }, fromBlock, toBlock: blockNumber, strict: true });
  need(logs.length === 0, "TOKEN_AUTHORIZATION_EVENT_PRESENT");
  const block = await client.getBlock({ blockNumber });
  need(block.number === blockNumber && same(block.hash, snapshot.chain.blockHash) && Number(block.timestamp) * 1000 === blockAt, "CHAIN_REORG");
  const supplement = await sql.begin("isolation level repeatable read read only", async tx => {
    const [row] = await tx`select transaction_timestamp() as checked_at, count(*)::text as count
      from chain_transactions where operation_key like ${`payment:${opts.paymentId}:%`}`;
    need(row?.count === "0", "DURABLE_SIGNED_PAYMENT_TRANSACTION_PRESENT");
    return { checkedAt: new Date(row.checked_at).toISOString() };
  });
  return { schemaVersion: 1, status: "operator-reviewed-no-spend", checkedAt: supplement.checkedAt, reviewedBy: opts.reviewedBy, planHash, journalSha256: opts.journalSha256,
    payer: wallet, paymentId: opts.paymentId, paymentNonce: opts.nonce, admissionFailure: { httpStatus: 503, title: "INFERENCE_ATTESTATION_FAILED" },
    database: { paymentStatus: "open", paymentSettleTx: null, paymentReceiptHash: null, paymentAuthorizationStored: false, paymentSignedTransactionCount: 0,
      ownerReceiptCountBefore: baseline.database.releaseReceipts.ownerTotal, ownerReceiptCountCurrent: snapshot.database.releaseReceipts.ownerTotal,
      ownerIdempotencyCountBefore: baseline.database.ownerIdempotencyCount, ownerIdempotencyCountCurrent: snapshot.database.ownerIdempotencyCount,
      ownerUsageBefore: { calls: baseline.database.ownerUsage.calls, usdcUnits: baseline.database.ownerUsage.usdcUnits },
      ownerUsageCurrent: { calls: snapshot.database.ownerUsage.calls, usdcUnits: snapshot.database.ownerUsage.usdcUnits } },
    chain: { chainId: 5042, fromBlock: fromBlock.toString(), blockNumber: blockNumber.toString(), blockTimestamp: block.timestamp.toString(), blockHash: block.hash,
      canonical: true, eventWindowCoversOriginalAttempt: true, paymentSettled: false, authorizationUsed: false, settledEventCount: 0, authorizationUsedEventCount: 0 } };
}
async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.help) { process.stdout.write("From _backend: node --env-file=.env.demo scripts/collect-acceptance-no-spend.mjs --plan PATH --baseline PATH --snapshot PATH --journal-sha256 HASH --payment-id UUID --nonce HASH --authorization-expires-at Z_TIMESTAMP --reviewed-by OPERATOR. Operator must first confirm these exact snapshots and recorded 503 admission failure. Supplements only signed-transaction count, USDC authorization state/events and canonical block check; no writes/signing/new request.\n"); return; }
  need(process.env.DATABASE_URL && process.env.ARC_RPC_URL, "RUNTIME_ENV_REQUIRED");
  const require = createRequire(resolve(process.cwd(), "package.json")), postgres = require("postgres"), viem = require("viem");
  const planBytes = await readFile(opts.plan), plan = JSON.parse(planBytes.toString("utf8")), baseline = JSON.parse(await readFile(opts.baseline, "utf8")), snapshot = JSON.parse(await readFile(opts.snapshot, "utf8"));
  const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10, connection: { statement_timeout: 15000 }, onnotice: () => {} });
  const client = viem.createPublicClient({ transport: viem.http(process.env.ARC_RPC_URL, { retryCount: 0, timeout: 15000 }) });
  try { process.stdout.write(`${JSON.stringify(await collectNoSpend({ sql, client, viem, plan, planHash: sha(planBytes), baseline, snapshot, opts }), null, 2)}\n`); }
  finally { await sql.end({ timeout: 5 }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error instanceof SnapshotError ? error.code : "NO_SPEND_COLLECTION_FAILED", diagnostic: safeDiagnostic(error, "runtime") })}\n`); process.exitCode = 1;
});
