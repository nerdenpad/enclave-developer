/** Local operator-reviewed recovery only. No API/RPC, keys, signing, or new payment. */
import { readFile, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, recoverTypedDataAddress, stringToHex, type Hex } from "viem";
import { z } from "zod";
import { sha256Hex, decryptAesGcm } from "@enclave/core";
import { ACCEPTANCE_PROMPT, AcceptanceError, acceptancePlanSchema, acceptanceStateSchema, createAcceptanceStore, preparePrivateAcceptanceDirectory,
  type AcceptancePlan, type AcceptanceState } from "./accept-near-arc.js";
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/), address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const usage = z.object({ calls: z.number().int().nonnegative(), usdcUnits: uint }).strict();
export const settlementRecoveryProofSchema = z.object({
  schemaVersion: z.literal(1), status: z.literal("operator-reviewed-no-spend"), checkedAt: z.string().datetime(), reviewedBy: z.string().min(1).max(128),
  planHash: hash, journalSha256: hash, payer: address, paymentId: z.string().uuid(), paymentNonce: hash,
  admissionFailure: z.object({ httpStatus: z.literal(503), title: z.literal("INFERENCE_ATTESTATION_FAILED") }).strict(),
  database: z.object({ paymentStatus: z.literal("open"), paymentSettleTx: z.null(), paymentReceiptHash: z.null(), paymentAuthorizationStored: z.literal(false),
    paymentSignedTransactionCount: z.literal(0), ownerReceiptCountBefore: z.number().int().nonnegative(), ownerReceiptCountCurrent: z.number().int().nonnegative(),
    ownerIdempotencyCountBefore: z.number().int().nonnegative(), ownerIdempotencyCountCurrent: z.number().int().nonnegative(),
    ownerUsageBefore: usage, ownerUsageCurrent: usage }).strict(),
  chain: z.object({ chainId: z.literal(5042), fromBlock: uint, blockNumber: uint, blockTimestamp: uint, blockHash: hash, canonical: z.literal(true),
    eventWindowCoversOriginalAttempt: z.literal(true), paymentSettled: z.literal(false), authorizationUsed: z.literal(false), settledEventCount: z.literal(0), authorizationUsedEventCount: z.literal(0) }).strict(),
}).strict();
export type SettlementRecoveryProof = z.infer<typeof settlementRecoveryProofSchema>;
const receiveTypes = { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] } as const;
function need(condition: unknown, code: string): asserts condition { if (!condition) throw new AcceptanceError(code); }
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
export async function rearmOriginalSettlement(plan: AcceptancePlan, state: AcceptanceState, proof: SettlementRecoveryProof, journalSha256: string, now: number, action: "rearm" | "archive-aborted" = "rearm") {
  const checkedProof = settlementRecoveryProofSchema.safeParse(proof);
  need(checkedProof.success, "RECOVERY_PROOF_INVALID"); proof = checkedProof.data;
  need(state.phase === "settlement-starting" && state.completionPosts === 0 && !state.result && !state.settleTx && !state.expectedReceiptHash
    && state.paymentId && state.authorization && state.session && state.request && state.walletAuth, "RECOVERY_STATE_NOT_ELIGIBLE");
  need(state.planHash === proof.planHash && same(journalSha256, proof.journalSha256) && state.paymentId === proof.paymentId
    && same(state.authorization.from, proof.payer) && same(state.walletAuth.address, proof.payer)
    && state.ownerHash === sha256Hex(`wallet:${plan.walletAuthOrigin}:${proof.payer.toLowerCase()}`)
    && same(proof.paymentNonce, keccak256(stringToHex(state.paymentId))), "RECOVERY_PROOF_SCOPE_MISMATCH");
  const checkedAt = Date.parse(proof.checkedAt);
  need(checkedAt <= now + 30_000 && now - checkedAt <= 60_000 && BigInt(proof.chain.fromBlock) <= BigInt(proof.chain.blockNumber), "RECOVERY_PROOF_STALE_OR_INVALID");
  const db = proof.database;
  need(db.ownerUsageBefore.calls === db.ownerUsageCurrent.calls && db.ownerUsageBefore.usdcUnits === db.ownerUsageCurrent.usdcUnits
    && db.ownerReceiptCountBefore === db.ownerReceiptCountCurrent && db.ownerIdempotencyCountBefore === db.ownerIdempotencyCountCurrent, "RECOVERY_ECONOMICS_CHANGED");
  need(state.authorization.validAfter === "0", "ORIGINAL_AUTHORIZATION_INVALID");
  if (action === "archive-aborted") {
    need(BigInt(state.authorization.validBefore) <= BigInt(Math.floor(now / 1000))
      && BigInt(state.authorization.validBefore) <= BigInt(proof.chain.blockTimestamp), "ORIGINAL_AUTHORIZATION_NOT_EXPIRED_CANONICALLY");
  } else {
    need(Date.parse(state.session.expiresAt) > now && Date.parse(state.walletAuth.expiresAt) > now
      && BigInt(state.authorization.validBefore) > BigInt(Math.floor(now / 1000))
      && BigInt(state.authorization.validBefore) <= BigInt(Math.floor(Date.parse(state.session.expiresAt) / 1000)), "ORIGINAL_AUTHORIZATION_OR_SESSION_EXPIRED");
  }
  need(state.request.sessionId === state.session.sessionId && Buffer.from(state.session.wrapKey, "base64").length === 32
    && decryptAesGcm(Buffer.from(state.session.wrapKey, "base64"), state.request).equals(Buffer.from(ACCEPTANCE_PROMPT)), "RECOVERY_REQUEST_MISMATCH");
  const signer = await recoverTypedDataAddress({ domain: { ...plan.usdcDomain, chainId: 5042, verifyingContract: plan.release.contracts.USDC },
    types: receiveTypes, primaryType: "ReceiveWithAuthorization", message: { from: proof.payer as Hex, to: plan.release.contracts.UsageMeter, value: BigInt(plan.expectedPriceUnits),
      validAfter: 0n, validBefore: BigInt(state.authorization.validBefore), nonce: proof.paymentNonce as Hex }, signature: state.authorization.signature }).catch(() => undefined);
  need(signer && same(signer, proof.payer), "ORIGINAL_AUTHORIZATION_INVALID");
  return { ...state, phase: action === "archive-aborted" ? "aborted-unspent" as const : "challenge" as const };
}
export function recoveryOptions(args: string[]) {
  const fields: Record<string, string> = {}; let execute = false, archiveAborted = false;
  if (args.length === 1 && args[0] === "--help") return { help: true as const };
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--execute" && !execute) execute = true;
    else if (key === "--archive-aborted" && !archiveAborted) archiveAborted = true;
    else if (["--plan", "--state", "--proof"].includes(key) && !fields[key] && args[i + 1] && !args[i + 1]!.startsWith("--")) fields[key] = args[++i]!;
    else throw new AcceptanceError("ARGUMENTS_INVALID");
  }
  need(fields["--plan"] && fields["--state"] && fields["--proof"], "ARGUMENTS_INVALID");
  return { help: false as const, execute, archiveAborted, plan: resolve(fields["--plan"]!), state: resolve(fields["--state"]!), proof: resolve(fields["--proof"]!) };
}
async function main() {
  const opts = recoveryOptions(process.argv.slice(2));
  if (opts.help) { process.stdout.write("tsx scripts/rearm-near-arc-settlement.ts --plan PATH --state PATH --proof PATH [--archive-aborted] [--execute]. Default dry-run. Local operator-reviewed no-spend proof required; no API/RPC/signing. Archive requires original authorization expired at the proven canonical block. Preserves original authorization and private journal backup.\n"); return; }
  const planBytes = await readFile(opts.plan), plan = acceptancePlanSchema.parse(JSON.parse(planBytes.toString("utf8")));
  if (opts.execute) await preparePrivateAcceptanceDirectory(opts.state);
  const lockPath = `${opts.state}.lock`, lock = opts.execute ? await open(lockPath, "wx", 0o600).catch(() => { throw new AcceptanceError("JOURNAL_LOCKED"); }) : undefined;
  try {
    if (lock) { await lock.writeFile(String(process.pid)); await lock.sync(); }
    const bytes = await readFile(opts.state), state = acceptanceStateSchema.parse(JSON.parse(bytes.toString("utf8")));
    need(state.planHash === sha256Hex(planBytes), "RECOVERY_PLAN_MISMATCH");
    const proof = settlementRecoveryProofSchema.parse(JSON.parse((await readFile(opts.proof)).toString("utf8")));
    const action = opts.archiveAborted ? "archive-aborted" : "rearm";
    const rearmed = await rearmOriginalSettlement(plan, state, proof, sha256Hex(bytes), Date.now(), action);
    if (opts.execute) {
      const store = createAcceptanceStore(opts.state);
      const existing = await readFile(resolve(dirname(opts.state), "settlement-recovery.json")).then(() => true).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; });
      need(!existing, "RECOVERY_RECORD_ALREADY_EXISTS");
      await store.write("settlement-recovery.json", Buffer.from(JSON.stringify({ schemaVersion: 1, action, recordedAt: new Date().toISOString(), originalJournalBase64: bytes.toString("base64"), originalJournalSha256: sha256Hex(bytes), proof })));
      need(sha256Hex(await readFile(opts.state)) === sha256Hex(bytes), "JOURNAL_CHANGED");
      await store.save(rearmed);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, status: opts.execute ? (opts.archiveAborted ? "original-settlement-aborted-unspent" : "original-settlement-rearmed") : "recovery-dry-run", action, paymentId: state.paymentId, originalAuthorizationRetained: true, automaticRetry: false })}\n`);
  } finally { if (lock) { await lock.close(); await unlink(lockPath); } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${JSON.stringify({ ok: false, code: error instanceof AcceptanceError ? error.code : "RECOVERY_INPUT_INVALID", automaticRetry: false })}\n`); process.exitCode = 1; });
}
