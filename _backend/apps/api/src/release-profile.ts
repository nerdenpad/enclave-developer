import { createPublicClient, http, keccak256, parseAbi, parseEventLogs, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ConflictError, usdcToUnits, validateProductionRelease } from "@enclave/core";
import { payments, receipts, type Database } from "@enclave/db";
import type { Config } from "./config.js";
import { runNearVerifier } from "./near-provider.js";

export type AcceptedRelease = Awaited<ReturnType<typeof validateProductionRelease>>;
const verifierAbi = parseAbi([
  "function registry() view returns (address)", "function enclaveSigner() view returns (address)",
  "event Verified(bytes32 indexed receiptHash,bytes32 modelHash,bytes32 codeHash,bytes32 inHash,bytes32 outHash,bytes32 attRef,address signer)",
]);
const meterAbi = parseAbi([
  "function usdc() view returns (address)", "function feeVault() view returns (address)",
  "function modelRegistry() view returns (address)", "function relay() view returns (address)",
  "event Settled(address indexed payer,uint256 amount,bytes32 indexed receiptHash,bool confidentialPath)",
]);
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function assertReleaseConfiguration(config: Config, release: AcceptedRelease, signer: Hex): void {
  const record = release.manifest;
  if (record.chainId !== config.ARC_CHAIN_ID || record.origin !== config.WALLET_AUTH_ORIGIN
    || record.modelId !== config.INFERENCE_MODEL || record.servingImageId !== config.SERVING_IMAGE_ID
    || record.tcbVersion !== config.TCB_POLICY_VERSION || !same(record.signer, signer)
    || release.providerProof.evidence.endpoint !== new URL(config.INFERENCE_BASE_URL).origin
    || release.providerAttestationFormat !== (config.NEAR_ENDPOINT_PROFILE === "direct-experimental" ? "direct" : "cloud")
    || !same(record.providerPolicy.sha256, config.NEAR_ATTESTATION_POLICY_SHA256 ?? "")
    || BigInt(record.acceptedPayment.amountUnits) !== usdcToUnits(config.INFERENCE_PRICE_USDC)) {
    throw new ConflictError("Runtime settings differ from the accepted production release");
  }
  const configured = { ModelRegistry: config.MODEL_REGISTRY_ADDRESS, AttestationVerifier: config.ATTESTATION_VERIFIER_ADDRESS,
    USDC: config.USDC_ADDRESS, UsageMeter: config.USAGE_METER_ADDRESS, FeeVault: config.FEE_VAULT_ADDRESS };
  for (const name of Object.keys(configured) as Array<keyof typeof configured>) {
    if (!same(record.contracts[name], configured[name])) throw new ConflictError("Contracts differ from the accepted production release");
  }
}

/** Read-only acceptance check. Never signs or submits a transaction. */
export async function verifyReleaseChain(config: Config, release: AcceptedRelease, paymentId: string): Promise<void> {
  const rpc = createPublicClient({ transport: http(config.ARC_RPC_URL, { timeout: 15_000, retryCount: 0 }), cacheTime: 0 });
  const verifier = config.ATTESTATION_VERIFIER_ADDRESS as Hex;
  const meter = config.USAGE_METER_ADDRESS as Hex;
  if (await rpc.getChainId() !== release.manifest.chainId) throw new ConflictError("Production RPC chain mismatch");
  const [anchor, payment, head, registry, signer, token, vault, meterRegistry, relay] = await Promise.all([
    rpc.getTransactionReceipt({ hash: release.manifest.acceptedInference.anchorTx as Hex }),
    rpc.getTransactionReceipt({ hash: release.manifest.acceptedPayment.settleTx as Hex }), rpc.getBlockNumber(),
    rpc.readContract({ address: verifier, abi: verifierAbi, functionName: "registry" }),
    rpc.readContract({ address: verifier, abi: verifierAbi, functionName: "enclaveSigner" }),
    rpc.readContract({ address: meter, abi: meterAbi, functionName: "usdc" }),
    rpc.readContract({ address: meter, abi: meterAbi, functionName: "feeVault" }),
    rpc.readContract({ address: meter, abi: meterAbi, functionName: "modelRegistry" }),
    rpc.readContract({ address: meter, abi: meterAbi, functionName: "relay" }),
  ]);
  if (!same(registry, config.MODEL_REGISTRY_ADDRESS) || !same(signer, release.manifest.signer)
    || !same(token, config.USDC_ADDRESS) || !same(vault, config.FEE_VAULT_ADDRESS) || !same(meterRegistry, config.MODEL_REGISTRY_ADDRESS)
    || !same(relay, privateKeyToAccount(config.DEPLOYER_PRIVATE_KEY).address)) {
    throw new ConflictError("Production contract wiring or receipt signer mismatch");
  }
  const depth = BigInt(config.CHAIN_CONFIRMATIONS ?? 12);
  for (const [transaction, expected, contract] of [[anchor, release.manifest.acceptedInference.anchorTx, verifier],
    [payment, release.manifest.acceptedPayment.settleTx, meter]] as const) {
    const block = await rpc.getBlock({ blockNumber: transaction.blockNumber });
    if (transaction.status !== "success" || !same(transaction.transactionHash, expected)
      || !transaction.to || !same(transaction.to, contract) || transaction.blockHash !== block.hash
      || head < transaction.blockNumber + depth) throw new ConflictError("Release transaction is unconfirmed or noncanonical");
  }
  const verified = parseEventLogs({ abi: verifierAbi, eventName: "Verified", strict: true,
    logs: anchor.logs.filter(log => same(log.address, verifier)) }).filter(({ args }) =>
    same(args.receiptHash, release.typedHash) && same(args.modelHash, release.receipt.modelHash)
    && same(args.codeHash, release.receipt.codeHash) && same(args.inHash, release.receipt.inHash)
    && same(args.outHash, release.receipt.outHash) && same(args.attRef, release.receipt.attRef)
    && same(args.signer, release.manifest.signer));
  const paymentHash = keccak256(stringToHex(paymentId));
  const settled = parseEventLogs({ abi: meterAbi, eventName: "Settled", strict: true,
    logs: payment.logs.filter(log => same(log.address, meter)) }).filter(({ args }) =>
    same(args.receiptHash, paymentHash) && same(args.payer, release.manifest.acceptedPayment.payer)
    && args.amount === BigInt(release.manifest.acceptedPayment.amountUnits) && !args.confidentialPath);
  if (verified.length !== 1 || settled.length !== 1) throw new ConflictError("Release lacks the exact accepted receipt or USDC settlement event");
  for (const transaction of [anchor, payment]) {
    if ((await rpc.getBlock({ blockNumber: transaction.blockNumber })).hash !== transaction.blockHash) throw new ConflictError("Release chain changed during validation");
  }
}

export async function assertAcceptedRelease(db: Database, config: Config, signer: Hex): Promise<AcceptedRelease | undefined> {
  if (config.NODE_ENV !== "production") return undefined;
  if (!config.PRODUCTION_RELEASE_MANIFEST) throw new ConflictError("Production acceptance manifest is required");
  const release = await validateProductionRelease(config.PRODUCTION_RELEASE_MANIFEST);
  assertReleaseConfiguration(config, release, signer);
  const [acceptedReceipt] = await db.select().from(receipts).where(and(eq(receipts.typedHash, release.typedHash),
    eq(receipts.anchoredTx, release.manifest.acceptedInference.anchorTx), eq(receipts.chainId, config.ARC_CHAIN_ID),
    eq(receipts.verifierAddress, config.ATTESTATION_VERIFIER_ADDRESS))).limit(1);
  const [acceptedPayment] = await db.select().from(payments).where(and(eq(payments.receiptHash, release.typedHash),
    eq(payments.settleTx, release.manifest.acceptedPayment.settleTx))).limit(1);
  if (!acceptedReceipt || acceptedReceipt.status !== "anchored" || !acceptedPayment || acceptedPayment.status !== "consumed"
    || acceptedPayment.amountUnits !== BigInt(release.manifest.acceptedPayment.amountUnits) || acceptedPayment.settlementMode !== "authorized") {
    throw new ConflictError("Production acceptance is not linked to a completed persisted paid request");
  }
  await verifyReleaseChain(config, release, acceptedPayment.id);
  return release;
}

/** Independently replay the archived CPU/GPU evidence; a saved verdict is never trusted. */
export async function verifyAcceptedProviderEvidence(config: Config, release: AcceptedRelease): Promise<void> {
  const proof = z.object({ report: z.record(z.unknown()),
    verdict: z.object({ tlsSpkiSha256: z.string().regex(/^(0x)?[0-9a-f]{64}$/i) }).passthrough() });
  let archive: z.infer<typeof proof>;
  let nonce: string;
  const cloud = new URL(config.INFERENCE_BASE_URL).hostname === "cloud-api.near.ai";
  try { archive = proof.parse(JSON.parse(release.providerTranscript.attestationProof!)); }
  catch { throw new ConflictError("Accepted inference lacks a replayable hardware evidence archive"); }
  try {
    if (release.providerProof.evidence.endpoint !== new URL(config.INFERENCE_BASE_URL).origin) throw new Error("Route mismatch");
    if (cloud) {
      if ("request_nonce" in archive.report || !Array.isArray(archive.report.model_attestations)
        || archive.report.model_attestations.length < 1) throw new Error("Archive route mismatch");
      nonce = z.object({ request_nonce: z.string().regex(/^[0-9a-f]{64}$/i) }).parse(archive.report.gateway_attestation).request_nonce;
    } else {
      if ("gateway_attestation" in archive.report || "model_attestations" in archive.report) throw new Error("Archive route mismatch");
      nonce = z.object({ request_nonce: z.string().regex(/^[0-9a-f]{64}$/i), model_name: z.literal(config.INFERENCE_MODEL) })
        .parse(archive.report).request_nonce;
    }
  } catch { throw new ConflictError("Accepted inference lacks a replayable hardware evidence archive"); }
  const verdict = await runNearVerifier({ pythonPath: config.NEAR_VERIFIER_PYTHON!, policyPath: config.NEAR_ATTESTATION_POLICY!,
    policySha256: config.NEAR_ATTESTATION_POLICY_SHA256! }, {
    nonce, tlsSpkiSha256: archive.verdict.tlsSpkiSha256,
    ...(cloud ? { model: config.INFERENCE_MODEL } : {}), attestation: archive.report, archivedVerdict: archive.verdict,
  }, AbortSignal.timeout(config.INFERENCE_TIMEOUT_MS), cloud, true);
  const evidence = release.providerProof.evidence;
  const signers = verdict.allowedSigners ?? [verdict.signingAddress];
  if (verdict.archivedHardwareVerified !== true || !same(verdict.attestationRef, evidence.attestationRef)
    || verdict.verifiedAt !== evidence.verifiedAt || verdict.expiresAt !== evidence.expiresAt
    || (!cloud && (signers.length !== 1 || !same(signers[0]!, verdict.signingAddress)))
    || !signers.some(signer => same(signer, evidence.signingAddress))) {
    throw new ConflictError("Accepted provider signature is not bound to replayed CPU/GPU evidence");
  }
}

export function releaseIsFresh(release: AcceptedRelease, now = Date.now()): boolean {
  return now >= Date.parse(release.manifest.acceptance.acceptedAt) && now < Date.parse(release.manifest.acceptance.validUntil)
    && now < Date.parse(release.providerPolicy.validUntil);
}
