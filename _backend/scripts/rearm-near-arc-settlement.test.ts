import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToHex, type Hex } from "viem";
import { encryptAesGcm, sha256Hex, tcbPolicyRecord } from "@enclave/core";
import { ACCEPTANCE_PROMPT, acceptancePlanSchema, type AcceptancePlan, type AcceptanceState } from "./accept-near-arc.js";
import { rearmOriginalSettlement, recoveryOptions, settlementRecoveryProofSchema, type SettlementRecoveryProof } from "./rearm-near-arc-settlement.js";
const now = Date.parse("2026-10-01T16:00:00Z"), id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", sessionId = "11111111-2222-4333-8444-555555555555";
const a = (value: number): Hex => `0x${(value + 256).toString(16).padStart(40, "0")}`, journalHash = sha256Hex("private synthetic journal");
let plan: AcceptancePlan, state: AcceptanceState, proof: SettlementRecoveryProof;
beforeEach(async () => {
  const payer = privateKeyToAccount(generatePrivateKey()), origin = "https://acceptance.example.test", key = Buffer.alloc(32, 11);
  const policy = tcbPolicyRecord({ version: 2, servingImageId: "synthetic-recovery", requireCpuTee: true, requireGpuCc: true });
  plan = acceptancePlanSchema.parse({ schemaVersion: 1, providerOrigin: "https://cloud-api.near.ai", walletAuthOrigin: origin, expectedPriceUnits: "100000", maxOutputTokens: 32,
    confirmations: 12, usdcDomain: { name: "SYNTHETIC USDC", version: "2" }, acceptanceValidUntil: "2026-10-02T16:00:00Z", release: { schemaVersion: 1, origin, chainId: 5042,
      modelId: "Synthetic/Recovery", servingImageId: "synthetic-recovery", tcbVersion: 2, modelHash: sha256Hex("model:Synthetic/Recovery"), codeHash: policy.measurement,
      policyHash: policy.policyHash, signer: a(10), contracts: { ModelRegistry: a(1), AttestationVerifier: a(2), UsageMeter: a(3), FeeVault: a(4), USDC: a(5) },
      providerPolicy: { path: "unused-synthetic-policy.json", sha256: journalHash, version: "synthetic", reviewedAt: "2026-10-01T15:00:00Z", reviewedBy: "Synthetic unit", scope: "production" } } });
  const nonce = keccak256(stringToHex(id)), validBefore = String(now / 1000 + 600);
  const signature = await payer.signTypedData({ domain: { ...plan.usdcDomain, chainId: 5042, verifyingContract: plan.release.contracts.USDC },
    types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "ReceiveWithAuthorization", message: { from: payer.address, to: plan.release.contracts.UsageMeter, value: 100000n, validAfter: 0n, validBefore: BigInt(validBefore), nonce } });
  state = { schemaVersion: 1, planHash: journalHash, apiBase: `${origin}/api`, ownerHash: sha256Hex(`wallet:${origin}:${payer.address.toLowerCase()}`), idempotencyKey: id,
    phase: "settlement-starting", completionPosts: 0, paymentId: id, authorization: { from: payer.address, validAfter: "0", validBefore, signature },
    walletAuth: { token: `enws_${"12".repeat(32)}`, address: payer.address, expiresAt: new Date(now + 1800000).toISOString() },
    session: { sessionId, wrapKey: key.toString("base64"), attRef: journalHash, expiresAt: new Date(now + 1200000).toISOString() },
    request: { sessionId, ...encryptAesGcm(key, Buffer.from(ACCEPTANCE_PROMPT)) } };
  proof = settlementRecoveryProofSchema.parse({ schemaVersion: 1, status: "operator-reviewed-no-spend", checkedAt: new Date(now).toISOString(), reviewedBy: "Synthetic operator",
    planHash: journalHash, journalSha256: journalHash, payer: payer.address, paymentId: id, paymentNonce: nonce, admissionFailure: { httpStatus: 503, title: "INFERENCE_ATTESTATION_FAILED" },
    database: { paymentStatus: "open", paymentSettleTx: null, paymentReceiptHash: null, paymentAuthorizationStored: false, paymentSignedTransactionCount: 0,
      ownerReceiptCountBefore: 0, ownerReceiptCountCurrent: 0, ownerIdempotencyCountBefore: 0, ownerIdempotencyCountCurrent: 0, ownerUsageBefore: { calls: 0, usdcUnits: "0" }, ownerUsageCurrent: { calls: 0, usdcUnits: "0" } },
    chain: { chainId: 5042, fromBlock: "100", blockNumber: "200", blockTimestamp: String(now / 1000), blockHash: journalHash, canonical: true, eventWindowCoversOriginalAttempt: true, paymentSettled: false,
      authorizationUsed: false, settledEventCount: 0, authorizationUsedEventCount: 0 } });
});
describe("explicit operator recovery of an unsubmitted original settlement", () => {
  it("changes only phase while preserving payment/session/request/idempotency/authorization", async () => {
    const next = await rearmOriginalSettlement(plan, state, proof, journalHash, now);
    expect(next).toEqual({ ...state, phase: "challenge" }); expect(state.phase).toBe("settlement-starting");
  });
  it.each(["completion-starting", "settled", "completed"] as const)("refuses phase %s", async phase => {
    state.phase = phase; await expect(rearmOriginalSettlement(plan, state, proof, journalHash, now)).rejects.toThrow("RECOVERY_STATE_NOT_ELIGIBLE");
  });
  it("refuses already attempted completion and any settlement transaction", async () => {
    state.completionPosts = 1; await expect(rearmOriginalSettlement(plan, state, proof, journalHash, now)).rejects.toThrow("RECOVERY_STATE_NOT_ELIGIBLE");
    state.completionPosts = 0; state.settleTx = journalHash; await expect(rearmOriginalSettlement(plan, state, proof, journalHash, now)).rejects.toThrow("RECOVERY_STATE_NOT_ELIGIBLE");
  });
  it.each(["paymentSettled", "authorizationUsed", "settledEventCount", "authorizationUsedEventCount"] as const)("refuses economic activity in %s", async field => {
    const unsafe = { ...proof, chain: { ...proof.chain, [field]: field.endsWith("Count") ? 1 : true } };
    await expect(rearmOriginalSettlement(plan, state, unsafe as SettlementRecoveryProof, journalHash, now)).rejects.toThrow("RECOVERY_PROOF_INVALID");
  });
  it.each(["paymentSignedTransactionCount", "paymentAuthorizationStored"] as const)("refuses durable server intent in %s", async field => {
    const unsafe = { ...proof, database: { ...proof.database, [field]: field.endsWith("Count") ? 1 : true } };
    await expect(rearmOriginalSettlement(plan, state, unsafe as SettlementRecoveryProof, journalHash, now)).rejects.toThrow("RECOVERY_PROOF_INVALID");
  });
  it("refuses changed usage, receipts or idempotency counts", async () => {
    for (const database of [{ ...proof.database, ownerUsageCurrent: { calls: 1, usdcUnits: "100000" } }, { ...proof.database, ownerReceiptCountCurrent: 1 }, { ...proof.database, ownerIdempotencyCountCurrent: 1 }]) {
      await expect(rearmOriginalSettlement(plan, state, { ...proof, database }, journalHash, now)).rejects.toThrow("RECOVERY_ECONOMICS_CHANGED");
    }
  });
  it("refuses stale or mismatched proof and journal hash", async () => {
    await expect(rearmOriginalSettlement(plan, state, proof, sha256Hex("different"), now)).rejects.toThrow("RECOVERY_PROOF_SCOPE_MISMATCH");
    await expect(rearmOriginalSettlement(plan, state, { ...proof, checkedAt: new Date(now - 60001).toISOString() }, journalHash, now)).rejects.toThrow("RECOVERY_PROOF_STALE_OR_INVALID");
  });
  it("refuses expired original authorization/session and never extends them", async () => {
    state.authorization!.validBefore = String(now / 1000); await expect(rearmOriginalSettlement(plan, state, proof, journalHash, now)).rejects.toThrow("ORIGINAL_AUTHORIZATION_OR_SESSION_EXPIRED");
    state.authorization!.validBefore = String(now / 1000 + 600); state.session!.expiresAt = new Date(now).toISOString();
    await expect(rearmOriginalSettlement(plan, state, proof, journalHash, now)).rejects.toThrow("ORIGINAL_AUTHORIZATION_OR_SESSION_EXPIRED");
  });
  it("rejects tampered signed terms", async () => {
    plan.expectedPriceUnits = "100001"; await expect(rearmOriginalSettlement(plan, state, proof, journalHash, now)).rejects.toThrow("ORIGINAL_AUTHORIZATION_INVALID");
  });
  it("requires explicit execute for a local journal mutation", () => {
    expect(recoveryOptions(["--plan", "plan.json", "--state", "state.json", "--proof", "proof.json"])).toMatchObject({ execute: false });
    expect(recoveryOptions(["--plan", "plan.json", "--state", "state.json", "--proof", "proof.json", "--execute"])).toMatchObject({ execute: true });
  });
  it("archives an expired, canonically unspent original without creating any authorization or changing IDs", async () => {
    const afterExpiry = now + 601_000;
    const expiredProof = { ...proof, checkedAt: new Date(afterExpiry).toISOString(), chain: { ...proof.chain, blockTimestamp: String(afterExpiry / 1000) } };
    expect(await rearmOriginalSettlement(plan, state, expiredProof, journalHash, afterExpiry, "archive-aborted")).toEqual({ ...state, phase: "aborted-unspent" });
    await expect(rearmOriginalSettlement(plan, state, proof, journalHash, now, "archive-aborted")).rejects.toThrow("ORIGINAL_AUTHORIZATION_NOT_EXPIRED_CANONICALLY");
    await expect(rearmOriginalSettlement(plan, state, { ...expiredProof, chain: { ...expiredProof.chain, blockTimestamp: String(now / 1000 + 599) } }, journalHash, afterExpiry, "archive-aborted")).rejects.toThrow("ORIGINAL_AUTHORIZATION_NOT_EXPIRED_CANONICALLY");
  });
});
