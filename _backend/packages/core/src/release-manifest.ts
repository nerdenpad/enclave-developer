import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { isConfiguredAddress } from "./addresses.js";
import { sha256Hex } from "./hash.js";
import { verifyNearTranscript } from "./near-inference.js";
import { canonicalEvidenceJson, verifyProviderProof } from "./provider-proof.js";
import { receiptTypedHash, verifyReceiptSignature, type SignedReceipt } from "./receipt.js";
import { tcbPolicyRecord } from "./tcb.js";

const DAY_MS = 86_400_000;
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).refine(value => !/^0x0{64}$/i.test(value)).transform(value => value as `0x${string}`);
const address = z.string().refine(isConfiguredAddress).transform(value => value as `0x${string}`);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(value => value as `0x${string}`);
const utc = z.string().datetime();
const modelId = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f:]/.test(value));
const filePath = z.string().min(1).max(4096).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) && !/^[a-z]+:\/\//i.test(value));
const positiveUnits = z.string().regex(/^[1-9][0-9]{0,77}$/).refine(value => /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) <= (1n << 256n) - 1n);
const uint64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value => /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= (1n << 64n) - 1n);
const exactHttpsOrigin = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && value === url.origin && !url.username && !url.password;
});

/** An operator-supplied acceptance record. Parsing it does not establish hardware or chain acceptance. */
export const productionReleaseManifestSchema = z.object({
  schemaVersion: z.literal(1), origin: exactHttpsOrigin, chainId: z.literal(5042), modelId,
  servingImageId: z.string().min(1).max(80).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)),
  tcbVersion: z.number().int().positive().safe(), modelHash: hex32, codeHash: hex32, policyHash: hex32, signer: address,
  contracts: z.object({ ModelRegistry: address, AttestationVerifier: address, USDC: address, UsageMeter: address, FeeVault: address }).strict()
    .refine(value => new Set(Object.values(value).map(item => item.toLowerCase())).size === 5),
  acceptance: z.object({ acceptedAt: utc, validUntil: utc }).strict(),
  providerPolicy: z.object({ path: filePath, sha256: hex32, version: z.string().min(1).max(128),
    reviewedAt: utc, reviewedBy: z.string().trim().min(1).max(256), scope: z.literal("production") }).strict(),
  acceptedInference: z.object({ path: filePath, sha256: hex32, checkedAt: utc, anchorTx: hex32 }).strict(),
  acceptedPayment: z.object({ settleTx: hex32, checkedAt: utc, amountUnits: positiveUnits, payer: address }).strict(),
}).strict();
export type ProductionReleaseManifest = z.infer<typeof productionReleaseManifestSchema>;
export type ProviderAttestationFormat = "cloud" | "direct";

const measurementSizes = { tee_tcb_svn: 16, mr_seam: 48, mr_signer_seam: 48, seam_attributes: 8,
  td_attributes: 8, xfam: 8, mr_td: 48, mr_config_id: 48, mr_owner: 48, mr_owner_config: 48,
  rt_mr0: 48, rt_mr1: 48, rt_mr2: 48, rt_mr3: 48 } as const;
const measurementsSchema = z.object(Object.fromEntries(Object.entries(measurementSizes)
  .map(([key, size]) => [key, z.string().regex(new RegExp(`^[0-9a-fA-F]{${size * 2}}$`))]))).strict();
const digest = z.string().regex(/^[0-9a-fA-F]{64}$/);
const gatewayProfileSchema = z.object({ appComposeSha256: digest, measurements: measurementsSchema }).strict();
const modelProfileSchema = z.object({ model: modelId, appComposeSha256: digest, measurements: measurementsSchema,
  composeManagerActionsSha256: digest, composeManagerImage: z.string().regex(/^nearaidev\/compose-manager@sha256:[0-9a-f]{64}$/),
  gpuCount: z.number().int().min(1).max(32), gpuModels: z.array(z.string().min(1)).min(1).max(32) }).strict();
export const productionProviderPolicySchema = z.object({
  schemaVersion: z.literal(1), version: z.string().min(1).max(128), validFrom: utc, validUntil: utc,
  maxSessionSeconds: z.number().int().min(1).max(300), profiles: z.array(modelProfileSchema).min(1).max(32),
  gatewayProfiles: z.array(gatewayProfileSchema).min(1).max(32).optional(),
  nvidiaVerifier: z.object({ mode: z.literal("local"), sdkVersion: z.literal("1.2.2"),
    binarySha256: z.literal("ef4d6b63fc898081d45f39d836848b32e9579202c7b64664aa38350649c09ff6"),
    librarySha256: z.literal("088b827f0ce9f356afd4afcb27c22bfd71409268e7fc6d987b3331ca8d2a5c24") }).strict().optional(),
  provenance: z.object({ status: z.literal("APPROVED"), scope: z.literal("production"), reviewedAt: utc,
    reviewedBy: z.string().trim().min(1).max(256) }).passthrough(),
}).strict();
export type ProductionProviderPolicy = z.infer<typeof productionProviderPolicySchema>;

const nearProviderOrigin = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && value === url.origin && !url.port && !url.username && !url.password
    && (url.hostname === "cloud-api.near.ai" || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.completions\.near\.ai$/.test(url.hostname));
});
const evidenceSchema = z.object({ schemaVersion: z.literal(1), provider: z.literal("near"), signatureKind: z.literal("provider_tee"),
  endpoint: nearProviderOrigin, model: modelId, completionId: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/),
  requestHash: hex32, responseHash: hex32, outputHash: hex32, signatureText: z.string().max(1024), signature,
  signingAddress: address, attestationRef: hex32, verifiedAt: utc, expiresAt: utc, tlsBound: z.literal(true) }).strict();
const base64 = z.string().max(44_739_244).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const productionInferenceArchiveSchema = z.object({
  receipt: z.object({ receiptVersion: z.literal(2), chainId: z.literal(5042), verifierAddress: address, typedHash: hex32,
    modelHash: hex32, codeHash: hex32, inHash: hex32, outHash: hex32, attRef: hex32, nonce: hex32, ts: uint64, sig: signature }).strict(),
  providerProof: z.object({ version: z.literal(1), receiptHash: hex32, evidenceHash: hex32, evidence: evidenceSchema, sig: signature }).strict(),
  providerTranscript: z.object({ requestBodyBase64: base64, responseBodyBase64: base64,
    attestationProof: z.string().min(1).max(4_194_304) }).strict(),
  inputBase64: base64, outputBase64: base64,
}).strict();

/** Fixed errors never include policy contents, prompts, responses, credentials or untrusted diagnostics. */
export class ProductionReleaseError extends Error {
  constructor(readonly code: string) { super(`Production release preflight failed: ${code}`); this.name = "ProductionReleaseError"; }
}
function requireRelease(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ProductionReleaseError(code);
}
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

// Python's policy reader rejects duplicate keys. Preserve that boundary before schema validation.
function uniqueJson(bytes: Buffer, code: string): unknown {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(source);
    const frames: Array<{ object: boolean; key: boolean; keys: Set<string> }> = [];
    const tokens = source.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
    for (const token of tokens) {
      if (token === "{" || token === "[") {
        requireRelease(frames.length < 128, code);
        frames.push({ object: token === "{", key: token === "{", keys: new Set() });
      } else if (token === "}" || token === "]") frames.pop();
      else if (token === ",") { const frame = frames.at(-1); if (frame?.object) frame.key = true; }
      else if (token.startsWith('"')) {
        const frame = frames.at(-1);
        if (frame?.object && frame.key) {
          const key = JSON.parse(token) as string;
          requireRelease(!frame.keys.has(key), code);
          frame.keys.add(key); frame.key = false;
        }
      }
    }
    return parsed;
  } catch { throw new ProductionReleaseError(code); }
}
function parseSchema<T extends z.ZodTypeAny>(schema: T, input: unknown, code: string): z.infer<T> {
  const parsed = schema.safeParse(input);
  requireRelease(parsed.success, code);
  return parsed.data;
}
async function readBounded(path: string, maximum: number, code: string): Promise<Buffer> {
  try {
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      requireRelease(stat.isFile() && Number.isSafeInteger(stat.size) && stat.size <= maximum, code);
      const bytes = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const chunk = await file.read(bytes, size, bytes.length - size, null);
        if (chunk.bytesRead === 0) break;
        size += chunk.bytesRead;
      }
      requireRelease(size === stat.size, code);
      return bytes.subarray(0, size);
    } finally { await file.close(); }
  } catch { throw new ProductionReleaseError(code); }
}
function canonicalSignature(value: string): boolean {
  const s = BigInt(`0x${value.slice(66, 130)}`), v = Number.parseInt(value.slice(130), 16);
  return s > 0n && s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n && [0, 1, 27, 28].includes(v);
}

/** Checks the existing Python verifier's policy schema and the operator's explicit review declaration. */
export function validateProductionProviderPolicy(bytes: Buffer, manifest: ProductionReleaseManifest, now = Date.now(), format: ProviderAttestationFormat = "cloud"): ProductionProviderPolicy {
  requireRelease(same(sha256Hex(bytes), manifest.providerPolicy.sha256), "PROVIDER_POLICY_HASH_MISMATCH");
  const policy = parseSchema(productionProviderPolicySchema, uniqueJson(bytes, "PROVIDER_POLICY_INVALID"), "PROVIDER_POLICY_INVALID");
  requireRelease(format === "direct" || (Array.isArray(policy.gatewayProfiles) && policy.gatewayProfiles.length > 0), "PROVIDER_POLICY_INVALID");
  const from = Date.parse(policy.validFrom), until = Date.parse(policy.validUntil), reviewed = Date.parse(policy.provenance.reviewedAt);
  requireRelease(from <= now && now < until && from <= reviewed && reviewed < until && reviewed <= now, "PROVIDER_POLICY_EXPIRED");
  requireRelease(policy.version === manifest.providerPolicy.version && policy.provenance.reviewedAt === manifest.providerPolicy.reviewedAt
    && policy.provenance.reviewedBy === manifest.providerPolicy.reviewedBy, "PROVIDER_POLICY_REVIEW_MISMATCH");
  requireRelease(policy.profiles.some(profile => profile.model === manifest.modelId), "PROVIDER_POLICY_MODEL_MISMATCH");
  return policy;
}

/** Offline only: no provider requests, RPC queries, subprocesses, signing or transactions. */
export async function validateProductionRelease(manifestPath: string, options: { now?: number } = {}) {
  const now = options.now ?? Date.now();
  requireRelease(Number.isFinite(now), "CLOCK_INVALID");
  const absolutePath = resolve(manifestPath), base = dirname(absolutePath);
  const manifest = parseSchema(productionReleaseManifestSchema,
    uniqueJson(await readBounded(absolutePath, 65_536, "MANIFEST_UNREADABLE"), "MANIFEST_INVALID"), "MANIFEST_INVALID");
  const accepted = Date.parse(manifest.acceptance.acceptedAt), until = Date.parse(manifest.acceptance.validUntil);
  requireRelease(accepted <= now && now < until && until > accepted && until - accepted <= 30 * DAY_MS, "ACCEPTANCE_EXPIRED");
  requireRelease([manifest.acceptedInference.checkedAt, manifest.acceptedPayment.checkedAt, manifest.providerPolicy.reviewedAt]
    .every(value => Date.parse(value) <= accepted), "ACCEPTANCE_TIME_MISMATCH");
  const software = tcbPolicyRecord({ version: manifest.tcbVersion, servingImageId: manifest.servingImageId, requireCpuTee: true, requireGpuCc: true });
  requireRelease(same(manifest.modelHash, sha256Hex(`model:${manifest.modelId}`)) && same(manifest.codeHash, software.measurement)
    && same(manifest.policyHash, software.policyHash), "RELEASE_HASH_MISMATCH");
  const policyBytes = await readBounded(resolve(base, manifest.providerPolicy.path), 1_048_576, "PROVIDER_POLICY_UNREADABLE");
  const archiveBytes = await readBounded(resolve(base, manifest.acceptedInference.path), 67_108_864, "INFERENCE_ARCHIVE_UNREADABLE");
  requireRelease(same(sha256Hex(archiveBytes), manifest.acceptedInference.sha256), "INFERENCE_ARCHIVE_HASH_MISMATCH");
  const archive = parseSchema(productionInferenceArchiveSchema, uniqueJson(archiveBytes, "INFERENCE_ARCHIVE_INVALID"), "INFERENCE_ARCHIVE_INVALID");
  const providerAttestationFormat: ProviderAttestationFormat = archive.providerProof.evidence.endpoint === "https://cloud-api.near.ai" ? "cloud" : "direct";
  const providerPolicy = validateProductionProviderPolicy(policyBytes, manifest, now, providerAttestationFormat);
  requireRelease(until <= Date.parse(providerPolicy.validUntil), "ACCEPTANCE_EXCEEDS_POLICY");
  const receipt: SignedReceipt = { ...archive.receipt, ts: BigInt(archive.receipt.ts) };
  const typedHash = receiptTypedHash(receipt, manifest.chainId, manifest.contracts.AttestationVerifier);
  requireRelease(same(archive.receipt.verifierAddress, manifest.contracts.AttestationVerifier)
    && same(archive.receipt.typedHash, typedHash) && same(receipt.modelHash, manifest.modelHash) && same(receipt.codeHash, manifest.codeHash), "RECEIPT_RELEASE_MISMATCH");
  requireRelease(canonicalSignature(receipt.sig) && canonicalSignature(archive.providerProof.sig)
    && await verifyReceiptSignature(receipt, manifest.signer, manifest.chainId, manifest.contracts.AttestationVerifier).catch(() => false), "RECEIPT_SIGNATURE_INVALID");
  requireRelease(await verifyProviderProof(archive.providerProof, receipt, manifest.signer, manifest.chainId, manifest.contracts.AttestationVerifier), "PROVIDER_PROOF_INVALID");
  const evidence = archive.providerProof.evidence;
  const issued = Date.parse(evidence.verifiedAt), expiry = Date.parse(evidence.expiresAt), checked = Date.parse(manifest.acceptedInference.checkedAt);
  requireRelease(evidence.model === manifest.modelId && issued >= Date.parse(providerPolicy.validFrom) && expiry <= Date.parse(providerPolicy.validUntil)
    && expiry > issued && expiry - issued <= providerPolicy.maxSessionSeconds * 1000 && receipt.ts * 1000n >= BigInt(issued - 300_999)
    && receipt.ts * 1000n < BigInt(expiry) && checked >= Number(receipt.ts) * 1000 && checked >= issued && checked <= accepted, "INFERENCE_TIME_MISMATCH");
  const transcript = { requestBody: Buffer.from(archive.providerTranscript.requestBodyBase64, "base64"), responseBody: Buffer.from(archive.providerTranscript.responseBodyBase64, "base64"), attestationProof: archive.providerTranscript.attestationProof };
  requireRelease(await verifyNearTranscript(evidence, transcript), "PROVIDER_TRANSCRIPT_INVALID");
  const input = Buffer.from(archive.inputBase64, "base64"), output = Buffer.from(archive.outputBase64, "base64");
  requireRelease(same(sha256Hex(input), receipt.inHash) && same(sha256Hex(output), receipt.outHash), "RECEIPT_IO_MISMATCH");
  const request = JSON.parse(transcript.requestBody.toString("utf8")) as { messages: Array<{ content: string }> };
  requireRelease(Buffer.from(request.messages[0]!.content, "utf8").equals(input), "TRANSCRIPT_INPUT_MISMATCH");
  const attestation = parseSchema(z.object({ report: z.record(z.unknown()), verdict: z.object({ ok: z.literal(true), model: modelId.optional(),
    attestationRef: hex32, policyVersion: z.string(), verifiedAt: utc, expiresAt: utc,
    signingAddress: address.optional(), allowedSigners: z.array(address).min(1).max(32).optional() }).passthrough(), policy: productionProviderPolicySchema, policyHash: hex32 }).strict(),
  uniqueJson(Buffer.from(archive.providerTranscript.attestationProof), "ATTESTATION_ARCHIVE_INVALID"), "ATTESTATION_ARCHIVE_INVALID");
  requireRelease(same(attestation.policyHash, manifest.providerPolicy.sha256) && canonicalEvidenceJson(attestation.policy) === canonicalEvidenceJson(providerPolicy)
    && attestation.verdict.policyVersion === providerPolicy.version
    && same(attestation.verdict.attestationRef, evidence.attestationRef) && attestation.verdict.verifiedAt === evidence.verifiedAt
    && attestation.verdict.expiresAt === evidence.expiresAt, "ATTESTATION_ARCHIVE_MISMATCH");
  if (providerAttestationFormat === "cloud") {
    requireRelease(attestation.verdict.model === manifest.modelId
      && attestation.verdict.allowedSigners?.some(signer => same(signer, evidence.signingAddress))
      && attestation.report.gateway_attestation != null && Array.isArray(attestation.report.model_attestations)
      && attestation.report.model_attestations.length > 0
      && attestation.report.signing_address === undefined && attestation.report.intel_quote === undefined, "ATTESTATION_ARCHIVE_MISMATCH");
  } else {
    requireRelease(attestation.report.gateway_attestation === undefined && attestation.report.model_attestations === undefined
      && attestation.report.model_name === manifest.modelId && typeof attestation.report.signing_address === "string"
      && typeof attestation.report.intel_quote === "string" && attestation.report.intel_quote.length > 0
      && typeof attestation.verdict.signingAddress === "string" && same(attestation.verdict.signingAddress, evidence.signingAddress)
      && same(attestation.report.signing_address, evidence.signingAddress)
      && (attestation.verdict.model === undefined || attestation.verdict.model === manifest.modelId)
      && (attestation.verdict.allowedSigners === undefined || (attestation.verdict.allowedSigners.length === 1
        && same(attestation.verdict.allowedSigners[0]!, evidence.signingAddress))), "ATTESTATION_ARCHIVE_MISMATCH");
  }
  return { manifest, receipt, providerProof: archive.providerProof, providerTranscript: transcript, providerPolicy, providerPolicyHash: sha256Hex(policyBytes), typedHash,
    manifestPath: absolutePath, providerAttestationFormat, hardwareAttestationVerified: false as const };
}
