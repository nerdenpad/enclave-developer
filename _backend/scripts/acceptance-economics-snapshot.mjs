/** Read-only private acceptance snapshot. Run from _backend with node --env-file=.env.demo. */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const paymentStatuses = new Set(["open", "settling", "settlement_unknown", "settled", "consumed"]);
const receiptStatuses = new Set(["pending", "anchored", "failed"]);
export class SnapshotError extends Error { constructor(code, diagnostic) { super(code); this.code = code; this.diagnostic = diagnostic; } }
const errorNames = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "PostgresError", "AggregateError", "ConnectionError", "TimeoutError", "AbortError", "ContractFunctionExecutionError", "ContractFunctionRevertedError", "ContractFunctionZeroDataError", "CallExecutionError", "RpcRequestError", "HttpRequestError", "TimeoutError", "InvalidAddressError", "BlockNotFoundError", "UnknownRpcError"]);
const errorCodes = new Set(["42P01", "42703", "42883", "42601", "42501", "28P01", "28000", "3D000", "3F000", "08P01", "08006", "57014", "25006", "53300", "53400", "57P01", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ERR_INVALID_URL", "ERR_MODULE_NOT_FOUND", "ERR_INVALID_ARG_TYPE"]);
const rpcCodes = new Set([-32700, -32600, -32601, -32602, -32603, -32000, -32001, -32002, -32003, -32004, -32005, -32016]);
const diagnosticStages = new Set(["runtime", "chain", "database", "cleanup"]);
export function safeDiagnostic(error, stage) {
  const diagnostic = { stage: diagnosticStages.has(stage) ? stage : "runtime" };
  let current = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    if (errorNames.has(current.name)) { if (!diagnostic.name) diagnostic.name = current.name; else diagnostic.causeName = current.name; }
    if (errorCodes.has(current.code)) diagnostic.errorCode = current.code;
    if (typeof current.code === "number" && rpcCodes.has(current.code)) diagnostic.rpcCode = current.code;
    if (current.code === "42703") {
      const column = current.column ?? (typeof current.message === "string" ? current.message.match(/column "([a-z_][a-z0-9_]{0,62})" does not exist/i)?.[1] : undefined);
      if (typeof column === "string" && /^[a-z_][a-z0-9_]{0,62}$/i.test(column)) diagnostic.missingColumn = column;
    }
    if (current.code === "42P01") {
      const table = current.table ?? (typeof current.message === "string" ? current.message.match(/relation "([a-z_][a-z0-9_]{0,62})" does not exist/i)?.[1] : undefined);
      if (typeof table === "string" && /^[a-z_][a-z0-9_]{0,62}$/i.test(table)) diagnostic.missingTable = table;
    }
    if (current.code === "42883" && typeof current.message === "string" && /function (?:pg_catalog\.)?sha256\(bytea\) does not exist/.test(current.message)) diagnostic.missingFunction = "sha256(bytea)";
  }
  return diagnostic;
}
export function errorOutput(error) {
  return { ok: false, code: error instanceof SnapshotError ? error.code : "SNAPSHOT_FAILED", ...(error instanceof SnapshotError && error.diagnostic ? { diagnostic: error.diagnostic } : { diagnostic: safeDiagnostic(error, "runtime") }) };
}
function need(condition, code) { if (!condition) throw new SnapshotError(code); }
function hash(value) { need(typeof value === "string" && HASH.test(value), "DATABASE_SHAPE_INVALID"); return value.toLowerCase(); }
function nullableHash(value) { return value == null ? null : hash(value); }
function units(value) { const result = String(value); need(UINT.test(result), "DATABASE_SHAPE_INVALID"); return result; }
function count(value) { const result = Number(value); need(Number.isSafeInteger(result) && result >= 0, "DATABASE_SHAPE_INVALID"); return result; }
function status(value, allow) { return allow.has(value) ? value : "other"; }
export const usage = "From _backend: node --env-file=.env.demo scripts/acceptance-economics-snapshot.mjs --plan PLAN_PATH --wallet PUBLIC_ADDRESS [--from-block NUMBER] [--payment-id UUID] [--receipt-hash 0xBYTES32] [--idempotency-key UUID] [--label before-payment|after-payment|before-restart|after-restart]. Reads DATABASE_URL and ARC_RPC_URL only; never signs, logs in, migrates, or writes data. Optional identifiers come from the private runner journal; do not pass its bearer/key/ciphertext.";
export function options(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const allowed = new Set(["--plan", "--wallet", "--from-block", "--payment-id", "--receipt-hash", "--idempotency-key", "--label"]), values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    need(allowed.has(key) && !Object.hasOwn(values, key) && typeof value === "string" && value.trim() === value && value && !value.startsWith("--"), "ARGUMENTS_INVALID");
    values[key] = value;
  }
  need(values["--plan"] && ADDRESS.test(values["--wallet"] ?? ""), "ARGUMENTS_INVALID");
  need(!values["--from-block"] || /^(0|[1-9][0-9]{0,15})$/.test(values["--from-block"]), "ARGUMENTS_INVALID");
  for (const key of ["--payment-id", "--idempotency-key"]) need(!values[key] || UUID.test(values[key]), "ARGUMENTS_INVALID");
  need(!values["--receipt-hash"] || HASH.test(values["--receipt-hash"]), "ARGUMENTS_INVALID");
  need(!values["--label"] || ["before-payment", "after-payment", "before-restart", "after-restart"].includes(values["--label"]), "ARGUMENTS_INVALID");
  return { help: false, planPath: resolve(values["--plan"]), wallet: values["--wallet"].toLowerCase(), fromBlock: values["--from-block"] ? BigInt(values["--from-block"]) : undefined,
    paymentId: values["--payment-id"], receiptHash: values["--receipt-hash"]?.toLowerCase(), idempotencyKey: values["--idempotency-key"], label: values["--label"] ?? null };
}
export function scopeFromPlan(plan) {
  const release = plan?.release;
  need(plan?.schemaVersion === 1 && Number.isInteger(plan.confirmations) && plan.confirmations >= 1 && plan.confirmations <= 1000
    && release?.chainId === 5042 && release?.tcbVersion === 2 && HASH.test(release?.modelHash ?? "") && HASH.test(release?.codeHash ?? "")
    && HASH.test(release?.policyHash ?? "") && ADDRESS.test(release?.contracts?.UsageMeter ?? "") && ADDRESS.test(release?.contracts?.AttestationVerifier ?? "") && ADDRESS.test(release?.contracts?.USDC ?? ""), "PLAN_INVALID");
  return { chainId: 5042, receiptVersion: 2, modelHash: release.modelHash.toLowerCase(), codeHash: release.codeHash.toLowerCase(), policyHash: release.policyHash.toLowerCase(),
    meter: release.contracts.UsageMeter.toLowerCase(), verifier: release.contracts.AttestationVerifier.toLowerCase(), usdc: release.contracts.USDC.toLowerCase(),
    confirmations: plan.confirmations };
}
export async function databaseSnapshot(sql, scope, opts) {
  return sql.begin("isolation level repeatable read read only", async tx => {
    const [clock] = await tx`select transaction_timestamp() as at`;
    const accounts = await tx`select owner_hash from wallet_accounts where lower(address) = ${opts.wallet}`;
    need(accounts.length <= 1, "WALLET_OWNER_AMBIGUOUS");
    const owner = accounts[0]?.owner_hash ?? null;
    if (owner) hash(owner); // Validate internally. Never emit this private account identifier.
    const [global] = await tx`select count(*)::text as total, count(*) filter(where status = 'anchored')::text as anchored
      from receipts where receipt_version = ${scope.receiptVersion} and chain_id = ${scope.chainId}
      and lower(verifier_address) = ${scope.verifier} and lower(model_hash) = ${scope.modelHash} and lower(code_hash) = ${scope.codeHash}`;
    const [ownerReceipts] = await tx`select count(*)::text as total, count(*) filter(where status = 'anchored')::text as anchored
      from receipts where key_hash = ${owner} and receipt_version = ${scope.receiptVersion} and chain_id = ${scope.chainId}
      and lower(verifier_address) = ${scope.verifier} and lower(model_hash) = ${scope.modelHash} and lower(code_hash) = ${scope.codeHash}`;
    const paymentGroups = await tx`select case when status in ('open','settling','settlement_unknown','settled','consumed') then status else 'other' end as status,
      count(*)::text as count, coalesce(sum(amount_units),0)::text as amount from payments where key_hash = ${owner} group by 1 order by 1`;
    const [ownerUsage] = await tx`select calls, usdc_units::text as amount from usage where key_hash = ${owner}`;
    const [idemCount] = await tx`select count(*)::text as count from idempotency_keys where key_hash = ${owner}`;
    let payment = null, receipt = null, idempotency = null;
    if (opts.paymentId) {
      const rows = await tx`select id, status, amount_units::text as amount, settle_tx, receipt_hash,
        encode(sha256(convert_to(coalesce(authorization_json,''),'UTF8')),'hex') as authorization_digest
        from payments where key_hash = ${owner} and id = ${opts.paymentId}::uuid`;
      if (rows[0]) { const row = rows[0]; payment = { id: row.id, status: status(row.status, paymentStatuses), amountUnits: units(row.amount), settleTx: nullableHash(row.settle_tx), receiptHash: nullableHash(row.receipt_hash), authorizationSha256: hash(`0x${row.authorization_digest}`) }; }
    }
    const selectedReceipt = opts.receiptHash ?? payment?.receiptHash;
    if (selectedReceipt) {
      const [row] = await tx`select typed_hash, model_hash, code_hash, receipt_version, chain_id, verifier_address, status, anchored_tx,
        encode(sha256(convert_to(concat_ws('|',receipt_version::text,chain_id::text,lower(verifier_address),lower(model_hash),lower(code_hash),lower(in_hash),lower(out_hash),lower(att_ref),lower(nonce),ts::text,lower(sig)),'UTF8')),'hex') as signed_digest,
        encode(sha256(convert_to(coalesce(output_json,''),'UTF8')),'hex') as output_digest,
        encode(sha256(convert_to(coalesce(provider_proof_json,''),'UTF8')),'hex') as provider_digest
        from receipts where key_hash = ${owner} and lower(typed_hash) = ${selectedReceipt}`;
      if (row) {
        need(row.receipt_version === scope.receiptVersion && row.chain_id === scope.chainId && row.verifier_address?.toLowerCase() === scope.verifier
          && row.model_hash?.toLowerCase() === scope.modelHash && row.code_hash?.toLowerCase() === scope.codeHash, "RECEIPT_SCOPE_MISMATCH");
        receipt = { typedHash: hash(row.typed_hash), status: status(row.status, receiptStatuses), anchoredTx: nullableHash(row.anchored_tx),
          signedReceiptSha256: hash(`0x${row.signed_digest}`), encryptedOutputSha256: hash(`0x${row.output_digest}`), providerEvidenceSha256: hash(`0x${row.provider_digest}`) };
      }
    }
    if (opts.idempotencyKey) {
      const [row] = await tx`select typed_hash, request_hash, encode(sha256(convert_to(response_json,'UTF8')),'hex') as response_digest
        from idempotency_keys where key_hash = ${owner} and idempotency_key = ${opts.idempotencyKey}`;
      if (row) { need(!selectedReceipt || row.typed_hash.toLowerCase() === selectedReceipt, "IDEMPOTENCY_RECEIPT_MISMATCH");
        idempotency = { key: opts.idempotencyKey, typedHash: hash(row.typed_hash), requestHash: nullableHash(row.request_hash), cachedResponseSha256: hash(`0x${row.response_digest}`) }; }
    }
    if (opts.receiptHash && payment?.receiptHash) need(opts.receiptHash === payment.receiptHash, "PAYMENT_RECEIPT_MISMATCH");
    return { capturedAt: new Date(clock.at).toISOString(), walletOwnerMapped: Boolean(owner), ownerUsage: { calls: count(ownerUsage?.calls ?? 0), usdcUnits: units(ownerUsage?.amount ?? 0) },
      ownerPayments: paymentGroups.map(row => ({ status: status(row.status, paymentStatuses), count: count(row.count), amountUnits: units(row.amount) })),
      releaseReceipts: { total: count(global.total), anchored: count(global.anchored), ownerTotal: count(ownerReceipts.total), ownerAnchored: count(ownerReceipts.anchored) },
      ownerIdempotencyCount: count(idemCount.count), target: { payment, receipt, idempotency } };
  });
}
export async function chainSnapshot(client, scope, opts, viem) {
  need(await client.getChainId() === scope.chainId, "CHAIN_ID_MISMATCH");
  const latest = await client.getBlock(); need(latest.hash && latest.number !== null && latest.number >= BigInt(scope.confirmations), "CHAIN_BLOCK_INVALID");
  const head = await client.getBlock({ blockNumber: latest.number - BigInt(scope.confirmations) });
  need(head.hash && head.number === latest.number - BigInt(scope.confirmations), "CHAIN_BLOCK_INVALID");
  const blockNumber = head.number;
  const meterAbi = viem.parseAbi(["function spent(address) view returns(uint256)", "function settled(bytes32) view returns(bool)",
    "function usdc() view returns(address)", "event Settled(address indexed payer,uint256 amount,bytes32 indexed receiptHash,bool confidentialPath)"]);
  const tokenAbi = viem.parseAbi(["function balanceOf(address) view returns(uint256)"]);
  async function read(args) {
    need(["spent", "balanceOf", "usdc", "settled"].includes(args.functionName) && /^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(args.functionName), "CHAIN_FUNCTION_INVALID");
    try { return await client.readContract(args); }
    catch (error) { throw new SnapshotError("CHAIN_READ_FAILED", { ...safeDiagnostic(error, "chain"), functionName: args.functionName }); }
  }
  const [spent, balance, actualToken] = await Promise.all([
    read({ address: scope.meter, abi: meterAbi, functionName: "spent", args: [opts.wallet], blockNumber }),
    read({ address: scope.usdc, abi: tokenAbi, functionName: "balanceOf", args: [opts.wallet], blockNumber }),
    read({ address: scope.meter, abi: meterAbi, functionName: "usdc", blockNumber }),
  ]);
  need(actualToken.toLowerCase() === scope.usdc, "METER_TOKEN_MISMATCH");
  const paymentKey = opts.paymentId ? viem.keccak256(viem.stringToHex(opts.paymentId)) : null;
  const settled = paymentKey ? await read({ address: scope.meter, abi: meterAbi, functionName: "settled", args: [paymentKey], blockNumber }) : null;
  let eventWindow = null;
  if (opts.fromBlock !== undefined) {
    need(opts.fromBlock <= blockNumber && blockNumber - opts.fromBlock <= 10_000n, "BLOCK_WINDOW_INVALID");
    const logs = await client.getLogs({ address: scope.meter, event: viem.parseAbiItem("event Settled(address indexed payer,uint256 amount,bytes32 indexed receiptHash,bool confidentialPath)"),
      args: { payer: opts.wallet }, fromBlock: opts.fromBlock, toBlock: blockNumber, strict: true });
    need(logs.every(log => !log.removed && log.args.payer?.toLowerCase() === opts.wallet && typeof log.args.amount === "bigint"), "CHAIN_LOG_INVALID");
    const target = paymentKey ? logs.filter(log => log.args.receiptHash?.toLowerCase() === paymentKey.toLowerCase()) : [];
    eventWindow = { fromBlock: opts.fromBlock.toString(), toBlock: blockNumber.toString(), payerSettledCount: logs.length,
      payerSettledAmountUnits: units(logs.reduce((total, log) => total + log.args.amount, 0n)), targetSettledCount: target.length,
      targetSettledAmountUnits: units(target.reduce((total, log) => total + log.args.amount, 0n)),
      targetTransactions: target.map(log => ({ transactionHash: hash(log.transactionHash), blockHash: hash(log.blockHash), blockNumber: units(log.blockNumber), logIndex: count(log.logIndex) })) };
  }
  const canonical = await client.getBlock({ blockNumber }); need(canonical.hash === head.hash, "CHAIN_REORG");
  return { capturedAt: new Date(Number(head.timestamp) * 1000).toISOString(), latestBlockNumber: latest.number.toString(), confirmationDepth: scope.confirmations,
    blockNumber: blockNumber.toString(), blockHash: hash(head.hash),
    payerSpentUnits: units(spent), payerBalanceUnits: units(balance), paymentKey, paymentSettled: settled, eventWindow };
}
export async function main(args, env = process.env) {
  const opts = options(args); if (opts.help) { process.stdout.write(`${usage}\n`); return; }
  need(env.DATABASE_URL && env.ARC_RPC_URL, "RUNTIME_ENV_REQUIRED");
  const require = createRequire(resolve(process.cwd(), "package.json"));
  let viem, postgres;
  try { viem = require("viem"); postgres = require("postgres"); } catch { throw new SnapshotError("RUN_FROM_BACKEND_REQUIRED"); }
  let scope; try { scope = scopeFromPlan(JSON.parse(await readFile(opts.planPath, "utf8"))); } catch (error) { if (error instanceof SnapshotError) throw error; throw new SnapshotError("PLAN_INVALID"); }
  let sql, client;
  try {
    sql = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 10, idle_timeout: 5, connection: { statement_timeout: 15000 }, onnotice: () => {} });
    client = viem.createPublicClient({ transport: viem.http(env.ARC_RPC_URL, { retryCount: 0, timeout: 15000 }) });
  } catch (error) { throw new SnapshotError("SNAPSHOT_FAILED", safeDiagnostic(error, "runtime")); }
  let stage = "chain", failed = false;
  try {
    const chain = await chainSnapshot(client, scope, opts, viem);
    stage = "database";
    const database = await databaseSnapshot(sql, scope, opts);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, label: opts.label, wallet: opts.wallet, scope, chain, database }, null, 2)}\n`);
  } catch (error) {
    failed = true;
    throw error instanceof SnapshotError ? new SnapshotError(error.code, error.diagnostic ?? safeDiagnostic(error, stage)) : new SnapshotError("SNAPSHOT_FAILED", safeDiagnostic(error, stage));
  } finally {
    try { await sql.end({ timeout: 5 }); } catch (error) { if (!failed) throw new SnapshotError("SNAPSHOT_FAILED", safeDiagnostic(error, "cleanup")); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1; });
}
