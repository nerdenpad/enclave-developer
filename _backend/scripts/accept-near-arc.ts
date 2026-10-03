/** One explicitly executed synthetic request. No automatic POST retries or wallet transactions. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseEnv } from "dotenv";
import { createPublicClient, hashDomain, http, keccak256, parseAbi, parseEventLogs, recoverTypedDataAddress, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { z } from "zod";
import { decryptAesGcm, encryptAesGcm, receiptTypedHash, sha256Hex, tcbPolicyRecord, verifyNearTranscript, verifyProviderProof, verifyReceiptSignature } from "@enclave/core";
import { productionInferenceArchiveSchema, productionReleaseManifestSchema, ProductionReleaseError, validateProductionProviderPolicy, validateProductionRelease,
  type ProductionReleaseManifest } from "../packages/core/src/release-manifest.js";
import { runNearVerifier, nvidiaVerifierOptions } from "../apps/api/src/near-provider.js";

export const acceptanceUsage = "Usage: tsx scripts/accept-near-arc.ts --plan PATH --state <dedicated-private-directory>/state.json [--env PATH] [--execute | --recover | --prepare-manifest | --execute --recover-completed | --unlock-stale]. Default: read-only preflight. Paid execution is capped at one USDC and one completion POST; ambiguous completion is never retried automatically. --unlock-stale only removes a lock whose recorded process no longer exists; run it without another acceptance process.";
export const ACCEPTANCE_PROMPT = "Reply with the single word READY.";
export const ACCEPTANCE_CLOCK_SKEW_MS = 30_000;
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value as Hex);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value as Hex);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(value => value as Hex);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const base64 = z.string().max(12_582_912).refine(value => Buffer.from(value, "base64").toString("base64") === value);
const blob = z.object({ iv: base64, tag: base64, ciphertext: base64 }).strict();
const publicInputs = productionReleaseManifestSchema.omit({ acceptance: true, acceptedInference: true, acceptedPayment: true });
export const acceptancePlanSchema = z.object({
  schemaVersion: z.literal(1), release: publicInputs,
  providerOrigin: z.string().url(), walletAuthOrigin: productionReleaseManifestSchema.shape.origin,
  expectedPriceUnits: z.string().regex(/^[1-9][0-9]{0,6}$/).refine(value => /^[1-9][0-9]{0,6}$/.test(value) && BigInt(value) <= 1_000_000n),
  maxOutputTokens: z.number().int().min(1).max(512), confirmations: z.number().int().min(1).max(1000),
  usdcDomain: z.object({ name: z.string().min(1).max(128), version: z.string().min(1).max(16) }).strict(),
  acceptanceValidUntil: z.string().datetime(),
}).strict();
export type AcceptancePlan = z.infer<typeof acceptancePlanSchema>;
const authorization = z.object({ from: address, validAfter: uint, validBefore: uint, signature }).strict();
const resultSchema = z.object({ receipt: productionInferenceArchiveSchema.shape.receipt.omit({ chainId: true, verifierAddress: true, typedHash: true }),
  typedHash: hash, outputHash: hash, output: blob, providerEvidence: z.object({ proof: productionInferenceArchiveSchema.shape.providerProof, transcript: blob }).strict() });
const stateSchema = z.object({ schemaVersion: z.literal(1), planHash: hash, apiBase: z.string(), ownerHash: hash,
  idempotencyKey: z.string().uuid(), phase: z.enum(["new", "session-starting", "session", "challenge-starting", "challenge", "settlement-starting", "settled", "completion-starting", "response-received", "completed", "aborted-unspent"]),
  walletAuth: z.object({ token: z.string().regex(/^enws_[a-f0-9]{64}$/), address, expiresAt: z.string().datetime() }).optional(),
  session: z.object({ sessionId: z.string().uuid(), expiresAt: z.string().datetime(), wrapKey: base64, attRef: hash }).optional(),
  request: z.object({ sessionId: z.string().uuid(), iv: base64, tag: base64, ciphertext: base64 }).optional(),
  paymentId: z.string().uuid().optional(), authorization: authorization.optional(), settleTx: hash.optional(), result: resultSchema.optional(),
  expectedReceiptHash: hash.optional(), checkedAt: z.string().datetime().optional(), replayVerified: z.boolean().optional(),
  completionPosts: z.number().int().min(0).max(100).default(0),
}).strict();
export type AcceptanceState = z.infer<typeof stateSchema>;
export const acceptanceStateSchema = stateSchema;
export type AcceptanceMode = "preflight" | "execute" | "recover" | "recover-completed" | "prepare-manifest" | "unlock-stale";
export class AcceptanceError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number, readonly apiTitle?: string, readonly failureFields?: readonly string[]) { super(`Acceptance failed: ${code}`); }
}
function requireAcceptance(condition: unknown, code: string): asserts condition { if (!condition) throw new AcceptanceError(code); }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const receiveTypes = { ReceiveWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] } as const;
const tokenDomainTypes = { EIP712Domain: [
  { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
] } as const;

export function acceptanceOptions(args: string[]) {
  if (args.length === 1 && args[0] === "--help") return { help: true as const };
  const values: Record<string, string> = {}, flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (["--execute", "--recover", "--recover-completed", "--prepare-manifest", "--unlock-stale"].includes(key)) {
      if (flags.has(key)) throw new AcceptanceError("ARGUMENTS_INVALID"); flags.add(key);
    } else if (["--plan", "--state", "--env"].includes(key) && !values[key] && args[i + 1]?.trim() && !args[i + 1]!.startsWith("--")) values[key] = args[++i]!;
    else throw new AcceptanceError("ARGUMENTS_INVALID");
  }
  requireAcceptance(values["--plan"] && values["--state"], "ARGUMENTS_INVALID");
  requireAcceptance(!flags.has("--recover-completed") || flags.has("--execute"), "EXECUTE_REQUIRED");
  requireAcceptance(!((flags.has("--recover") || flags.has("--prepare-manifest")) && flags.has("--execute")), "ARGUMENTS_INVALID");
  requireAcceptance(!(flags.has("--recover") && flags.has("--prepare-manifest")), "ARGUMENTS_INVALID");
  requireAcceptance(!flags.has("--unlock-stale") || flags.size === 1, "ARGUMENTS_INVALID");
  const mode: AcceptanceMode = flags.has("--unlock-stale") ? "unlock-stale" : flags.has("--recover-completed") ? "recover-completed" : flags.has("--execute") ? "execute"
    : flags.has("--recover") ? "recover" : flags.has("--prepare-manifest") ? "prepare-manifest" : "preflight";
  return { help: false as const, mode, planPath: resolve(values["--plan"]!), statePath: resolve(values["--state"]!), envPath: values["--env"] ? resolve(values["--env"]!) : undefined };
}

export function acceptanceApiBase(value: string): string {
  const url = new URL(value);
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  requireAcceptance((local || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash
    && ["/", "/api", "/api/"].includes(url.pathname), "API_ORIGIN_INVALID");
  return `${url.origin}${url.pathname.startsWith("/api") ? "/api" : ""}`;
}
export type AcceptanceApi = (path: string, method?: "GET" | "POST", body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; data: unknown }>;
export function createAcceptanceApi(apiBase: string, apiKey: string, fetcher: typeof fetch = fetch): AcceptanceApi {
  const base = acceptanceApiBase(apiBase);
  return async (path, method = "GET", body, extra = {}) => {
    try {
      const response = await fetcher(`${base}${path}`, { method, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(330_000), headers: { accept: "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      requireAcceptance(!response.redirected && response.body, "HTTP_INVALID");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; requireAcceptance(size <= 12_582_912, "HTTP_TOO_LARGE"); chunks.push(next.value); } }
      finally { reader.releaseLock(); }
      return { status: response.status, data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown };
    } catch { throw new AcceptanceError("HTTP_UNCERTAIN"); }
  };
}
function parsed<T extends z.ZodTypeAny>(schema: T, value: unknown, code: string): z.infer<T> {
  const result = schema.safeParse(value); requireAcceptance(result.success, code); return result.data;
}
const safeApiTitles = new Set(["UNAUTHORIZED", "VALIDATION_ERROR", "NOT_FOUND", "PAYMENT_REQUIRED", "PAYMENT_NOT_SETTLED", "PAYMENT_NOT_CONFIRMED",
  "PAYMENT_CONSUMED", "SESSION_EXPIRED", "SESSION_NOT_FOUND", "NEAR_UNAVAILABLE", "TEE_UNAVAILABLE", "INTERNAL", "INTERNAL_ERROR", "SERVICE_UNAVAILABLE",
  "LOGIN_RATE_LIMIT", "LOGIN_SESSION_LIMIT", "WALLET_ACTION_UNAVAILABLE", "INSUFFICIENT_BALANCE", "TCB_NOT_ACTIVE", "TCB_CHANGED", "IDEMPOTENCY_CONFLICT",
  "VALIDATION_FAILED", "CONFLICT", "FORBIDDEN", "MODEL_NOT_APPROVED", "ATTESTATION_FAILED", "KEY_NOT_RELEASED", "TAMPERED_IMAGE", "SESSION_FAILED",
  "INFERENCE_ATTESTATION_FAILED", "NEAR_INFERENCE_FAILED", "NEAR_VERIFICATION_FAILED", "NEAR_INFERENCE_TIMEOUT", "X402_UNAVAILABLE", "SETTLEMENT_PENDING",
  "TCB_BINDING_UNAVAILABLE", "TCB_POLICY_NOT_APPROVED", "CHAIN_NOT_CONFIGURED", "PAYMENT_INTENT_FAILED"]);
function requireHttp(result: { status: number; data: unknown }, expected: number, code: string) {
  if (result.status === expected) return;
  const title = z.object({ title: z.string() }).safeParse(result.data);
  throw new AcceptanceError(code, result.status, title.success && safeApiTitles.has(title.data.title) ? title.data.title : undefined);
}
async function get(api: AcceptanceApi, path: string): Promise<unknown> { const result = await api(path); requireHttp(result, 200, "HTTP_READ_FAILED"); return result.data; }
export interface AcceptanceStore { load(): Promise<AcceptanceState | undefined>; save(state: AcceptanceState): Promise<void>; write(name: string, bytes: Buffer): Promise<void>;
  validate(manifest: ProductionReleaseManifest, now: number): Promise<void> }
export interface AcceptanceChain {
  preflight(plan: AcceptancePlan, payer?: Hex): Promise<{ payerBalanceUnits: string | null }>;
  verify(plan: AcceptancePlan, input: { paymentId: string; payer: Hex; settleTx: Hex; anchorTx: Hex; receipt: z.infer<typeof productionInferenceArchiveSchema.shape.receipt> }): Promise<void>;
}
export type AcceptanceDependencies = { api: AcceptanceApi; chain: AcceptanceChain; store: AcceptanceStore; now: () => number;
  verifyHardware: (archive: z.infer<typeof productionInferenceArchiveSchema>, plan: AcceptancePlan) => Promise<void> };
export type AcceptanceContext = { plan: AcceptancePlan; planHash: Hex; policyBytes: Buffer; apiBase: string; payerKey?: Hex };

const healthSchema = z.object({ chainId: z.literal(5042), teeMode: z.literal("managed-near"), inferenceBackend: z.literal("near-verified"), paymentMode: z.literal("authorized"),
  servingModel: z.object({ id: z.string(), modelHash: hash, codeHash: hash }), receiptSigner: address, verifierAddress: address,
  settlementToken: address, inferencePriceUsdc: z.number().finite().positive(), limits: z.object({ maxOutputTokens: z.number().int().min(1).max(512) }) });
async function preflight(context: AcceptanceContext, deps: AcceptanceDependencies, checkBalance = true) {
  const { plan } = context, release = plan.release;
  requireAcceptance(plan.walletAuthOrigin === release.origin, "WALLET_ORIGIN_MISMATCH");
  const wallet = parsed(z.object({ enabled: z.literal(true), origin: z.string(), chainId: z.literal(5042), accountType: z.literal("EOA") }),
    await get(deps.api, "/v1/auth/wallet/config"), "WALLET_AUTH_REQUIRED");
  requireAcceptance(wallet.origin === plan.walletAuthOrigin, "WALLET_ORIGIN_MISMATCH");
  const software = tcbPolicyRecord({ version: release.tcbVersion, servingImageId: release.servingImageId, requireCpuTee: true, requireGpuCc: true });
  requireAcceptance(same(release.modelHash, sha256Hex(`model:${release.modelId}`)) && same(release.codeHash, software.measurement) && same(release.policyHash, software.policyHash), "RELEASE_HASH_MISMATCH");
  const format = plan.providerOrigin === "https://cloud-api.near.ai" ? "cloud" : "direct";
  requireAcceptance(format === "cloud" || /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.completions\.near\.ai$/.test(plan.providerOrigin), "PROVIDER_ORIGIN_INVALID");
  const policy = validateProductionProviderPolicy(context.policyBytes, release as ProductionReleaseManifest, deps.now(), format);
  requireAcceptance(Date.parse(plan.acceptanceValidUntil) > deps.now() && Date.parse(plan.acceptanceValidUntil) <= Date.parse(policy.validUntil)
    && Date.parse(plan.acceptanceValidUntil) - deps.now() <= 30 * 86_400_000, "ACCEPTANCE_EXPIRY_INVALID");
  const health = parsed(healthSchema, await get(deps.api, "/health"), "MANAGED_PROFILE_REQUIRED");
  requireAcceptance(health.servingModel.id === release.modelId && same(health.servingModel.modelHash, release.modelHash)
    && same(health.servingModel.codeHash, release.codeHash) && same(health.receiptSigner, release.signer)
    && same(health.verifierAddress, release.contracts.AttestationVerifier) && same(health.settlementToken, release.contracts.USDC)
    && Math.round(health.inferencePriceUsdc * 1_000_000).toString() === plan.expectedPriceUnits && health.limits.maxOutputTokens <= plan.maxOutputTokens, "RUNTIME_MISMATCH");
  const tcb = parsed(z.object({ active: z.object({ binding: z.literal("onchain"), version: z.number(), servingImageId: z.string(),
    measurement: hash, policyHash: hash, status: z.literal("active") }) }), await get(deps.api, "/v1/tcb/policies"), "TCB_NOT_ACTIVE_ONCHAIN");
  requireAcceptance(tcb.active.version === release.tcbVersion && tcb.active.servingImageId === release.servingImageId
    && same(tcb.active.measurement, release.codeHash) && same(tcb.active.policyHash, release.policyHash), "TCB_MISMATCH");
  const payer = context.payerKey ? privateKeyToAccount(context.payerKey).address : undefined;
  const chain = await deps.chain.preflight(plan, checkBalance ? payer : undefined);
  if (checkBalance && payer) requireAcceptance(chain.payerBalanceUnits !== null && BigInt(chain.payerBalanceUnits) >= BigInt(plan.expectedPriceUnits), "PAYER_BALANCE_INSUFFICIENT");
  return { health, payer, providerPolicy: policy };
}

const targetReceiptSchema = productionInferenceArchiveSchema.shape.receipt.extend({ status: z.string(), anchoredTx: hash.nullable() }).strip();
const workspaceSchema = z.object({ payments: z.array(z.object({ id: z.string().uuid(), amountUnits: uint, status: z.string(), settleTx: hash.nullable(), receiptHash: hash.nullable(), confidential: z.boolean() })),
  receipts: z.array(z.object({ typedHash: hash, status: z.string(), anchoredTx: hash.nullable() }).passthrough()),
  page: z.object({ receiptsNext: z.string().uuid().nullable(), paymentsNext: z.string().uuid().nullable() }) });
async function ownedEvidence(api: AcceptanceApi, paymentId: string, knownHash?: Hex) {
  let payment: z.infer<typeof workspaceSchema>["payments"][number] | undefined, receipt: z.infer<typeof targetReceiptSchema> | undefined;
  const receipts = new Map<string, z.infer<typeof workspaceSchema>["receipts"][number]>();
  let receiptCursor: string | null = null, paymentCursor: string | null = null;
  for (let count = 0; count < 50; count++) {
    const query: URLSearchParams = new URLSearchParams({ limit: "100", ...(receiptCursor ? { receiptsBefore: receiptCursor } : {}), ...(paymentCursor ? { paymentsBefore: paymentCursor } : {}) });
    const page: z.infer<typeof workspaceSchema> = parsed(workspaceSchema, await get(api, `/v1/workspace?${query}`), "WORKSPACE_INVALID");
    payment ??= page.payments.find(row => row.id === paymentId);
    for (const row of page.receipts) receipts.set(row.typedHash.toLowerCase(), row);
    const digest = knownHash ?? payment?.receiptHash ?? undefined;
    const target = digest ? receipts.get(digest.toLowerCase()) : undefined;
    if (target) receipt ??= parsed(targetReceiptSchema, target, "PERSISTED_RECEIPT_INVALID");
    if (payment && (!digest || receipt)) break;
    const nextReceipt: string | null = page.page.receiptsNext, nextPayment: string | null = page.page.paymentsNext;
    if ((!nextReceipt || nextReceipt === receiptCursor) && (!nextPayment || nextPayment === paymentCursor)) break;
    receiptCursor = nextReceipt; paymentCursor = nextPayment;
  }
  return { payment, receipt };
}

export async function verifyAcceptanceResult(context: AcceptanceContext, deps: AcceptanceDependencies, state: AcceptanceState) {
  requireAcceptance(state.result && state.session, "PRIVATE_RESULT_MISSING");
  const raw = state.result, key = Buffer.from(state.session.wrapKey, "base64"), input = Buffer.from(ACCEPTANCE_PROMPT);
  const output = decryptAesGcm(key, raw.output);
  const transcript = parsed(z.object({ requestBody: base64, responseBody: base64, attestationProof: z.string().min(1).max(4_194_304) }).strict(),
    JSON.parse(decryptAesGcm(key, raw.providerEvidence.transcript).toString("utf8")), "PRIVATE_TRANSCRIPT_INVALID");
  const archive = parsed(productionInferenceArchiveSchema, { receipt: { ...raw.receipt, chainId: 5042,
    verifierAddress: context.plan.release.contracts.AttestationVerifier, typedHash: raw.typedHash }, providerProof: raw.providerEvidence.proof,
    providerTranscript: { requestBodyBase64: transcript.requestBody, responseBodyBase64: transcript.responseBody, attestationProof: transcript.attestationProof },
    inputBase64: input.toString("base64"), outputBase64: output.toString("base64") }, "PRIVATE_ARCHIVE_INVALID");
  const receipt = { ...raw.receipt, ts: BigInt(raw.receipt.ts) }, trusted = context.plan.release;
  requireAcceptance(same(receipt.modelHash, trusted.modelHash) && same(receipt.codeHash, trusted.codeHash) && same(receipt.inHash, sha256Hex(input))
    && same(receipt.outHash, sha256Hex(output)) && same(raw.outputHash, receipt.outHash) && same(receipt.attRef, state.session.attRef)
    && same(receiptTypedHash(receipt, 5042, trusted.contracts.AttestationVerifier), raw.typedHash)
    && raw.providerEvidence.proof.evidence.endpoint === context.plan.providerOrigin, "RECEIPT_BINDING_INVALID");
  requireAcceptance(await verifyProviderProof(raw.providerEvidence.proof, receipt, trusted.signer, 5042, trusted.contracts.AttestationVerifier)
    && await verifyReceiptSignature(receipt, trusted.signer, 5042, trusted.contracts.AttestationVerifier).catch(() => false)
    && await verifyNearTranscript(raw.providerEvidence.proof.evidence, { requestBody: Buffer.from(transcript.requestBody, "base64"), responseBody: Buffer.from(transcript.responseBody, "base64") }), "PROVIDER_SIGNATURE_INVALID");
  const providerRequest = parsed(z.object({ messages: z.array(z.object({ role: z.literal("user"), content: z.literal(ACCEPTANCE_PROMPT) })).length(1),
    model: z.literal(trusted.modelId), stream: z.literal(false), max_tokens: z.number().int().min(1).max(context.plan.maxOutputTokens) }),
    JSON.parse(Buffer.from(transcript.requestBody, "base64").toString("utf8")), "TRANSCRIPT_INPUT_OR_CAP_MISMATCH");
  requireAcceptance(providerRequest.messages[0]?.content === ACCEPTANCE_PROMPT, "TRANSCRIPT_INPUT_OR_CAP_MISMATCH");
  await deps.verifyHardware(archive, context.plan);
  return archive;
}

export function walletChallengeChecks(challenge: { id: string; message: string; expiresAt: string }, payer: Hex, origin: string, now: number) {
  let siwe: ReturnType<typeof parseSiweMessage>;
  try { siwe = parseSiweMessage(challenge.message); } catch { return { messageFormat: false }; }
  const issuedAt = siwe.issuedAt?.getTime(), expiresAt = Date.parse(challenge.expiresAt);
  return {
    messageFormat: true, address: Boolean(siwe.address && same(siwe.address, payer)), domain: siwe.domain === new URL(origin).host,
    uri: siwe.uri === `${origin}/dashboard`, chainId: siwe.chainId === 5042, version: siwe.version === "1", nonce: siwe.nonce === challenge.id,
    statement: siwe.statement === "Sign in to Enclave. This does not authorize a payment.",
    issuedAtPresent: issuedAt !== undefined && Number.isFinite(issuedAt),
    issuedAtNotFuture: issuedAt !== undefined && issuedAt <= now + ACCEPTANCE_CLOCK_SKEW_MS,
    issuedAtFresh: issuedAt !== undefined && now - issuedAt <= 300_000,
    expiryBinding: siwe.expirationTime?.getTime() === expiresAt,
    challengeLifetime: issuedAt !== undefined && expiresAt - issuedAt === 300_000,
    expiryFuture: expiresAt > now, expiryMaximum: expiresAt - now <= 300_000 + ACCEPTANCE_CLOCK_SKEW_MS,
  };
}
export function walletSessionChecks(session: { address: Hex; expiresAt: string }, payer: Hex, now: number) {
  const expiresAt = Date.parse(session.expiresAt);
  return { address: same(session.address, payer), expiryFuture: expiresAt > now, expiryMaximum: expiresAt - now <= 30 * 60_000 + ACCEPTANCE_CLOCK_SKEW_MS };
}
function assertWalletChecks(checks: Record<string, boolean | undefined>, code: string) {
  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
  if (failed.length) throw new AcceptanceError(code, undefined, undefined, failed);
}

async function authenticateWallet(context: AcceptanceContext, deps: AcceptanceDependencies, state: AcceptanceState, payer: Hex, mode: AcceptanceMode) {
  if (state.walletAuth) requireAcceptance(same(state.walletAuth.address, payer), "WALLET_OWNER_MISMATCH");
  if (!state.walletAuth || Date.parse(state.walletAuth.expiresAt) <= deps.now()) {
    requireAcceptance(mode === "execute" || mode === "recover-completed", "WALLET_LOGIN_REQUIRED_EXECUTE");
    requireAcceptance(context.payerKey, "PAYER_KEY_REQUIRED");
    const origin = context.plan.walletAuthOrigin;
    const response = await deps.api("/v1/auth/wallet/challenge", "POST", { address: payer }, { origin });
    requireHttp(response, 200, "WALLET_CHALLENGE_FAILED");
    const challenge = parsed(z.object({ id: z.string().regex(/^[a-f0-9]{48}$/), message: z.string().min(1).max(4096), expiresAt: z.string().datetime() }).strict(), response.data, "WALLET_CHALLENGE_INVALID");
    assertWalletChecks(walletChallengeChecks(challenge, payer, origin, deps.now()), "WALLET_CHALLENGE_SCOPE_MISMATCH");
    const signed = await privateKeyToAccount(context.payerKey).signMessage({ message: challenge.message });
    const verified = await deps.api("/v1/auth/wallet/verify", "POST", { id: challenge.id, signature: signed }, { origin });
    requireHttp(verified, 200, "WALLET_LOGIN_UNCERTAIN");
    const walletAuth = parsed(stateSchema.shape.walletAuth.unwrap(), verified.data, "WALLET_SESSION_INVALID");
    assertWalletChecks(walletSessionChecks(walletAuth, payer, deps.now()), "WALLET_SESSION_INVALID");
    state.walletAuth = walletAuth; await deps.store.save(state);
  }
  const token = state.walletAuth.token;
  const api: AcceptanceApi = (path, method, body, headers) => deps.api(path, method, body,
    { ...headers, "x-api-key": token, ...(method === "POST" ? { origin: context.plan.walletAuthOrigin } : {}) });
  return { ...deps, api };
}

function assertSavedRequest(state: AcceptanceState) {
  requireAcceptance(state.session && state.request && state.request.sessionId === state.session.sessionId
    && Buffer.from(state.session.wrapKey, "base64").length === 32, "JOURNAL_REQUEST_INVALID");
  requireAcceptance(decryptAesGcm(Buffer.from(state.session.wrapKey, "base64"), state.request).equals(Buffer.from(ACCEPTANCE_PROMPT)), "JOURNAL_REQUEST_INVALID");
}

async function assertSavedAuthorization(context: AcceptanceContext, state: AcceptanceState, payer: Hex) {
  requireAcceptance(state.authorization && state.paymentId && same(state.authorization.from, payer) && state.authorization.validAfter === "0", "JOURNAL_AUTHORIZATION_INVALID");
  const recovered = await recoverTypedDataAddress({ domain: { ...context.plan.usdcDomain, chainId: 5042, verifyingContract: context.plan.release.contracts.USDC },
    types: receiveTypes, primaryType: "ReceiveWithAuthorization", message: { from: payer, to: context.plan.release.contracts.UsageMeter,
      value: BigInt(context.plan.expectedPriceUnits), validAfter: 0n, validBefore: BigInt(state.authorization.validBefore), nonce: keccak256(stringToHex(state.paymentId)) },
    signature: state.authorization.signature }).catch(() => undefined);
  requireAcceptance(recovered && same(recovered, payer), "JOURNAL_AUTHORIZATION_INVALID");
}

export async function runNearArcAcceptance(context: AcceptanceContext, mode: AcceptanceMode, deps: AcceptanceDependencies) {
  requireAcceptance(mode !== "unlock-stale", "ARGUMENTS_INVALID");
  let state = await deps.store.load();
  requireAcceptance(state?.phase !== "aborted-unspent" || mode === "preflight", "ACCEPTANCE_ABORTED_NO_EXECUTION");
  const payer = context.payerKey ? privateKeyToAccount(context.payerKey).address : undefined;
  const ownerHash = payer ? sha256Hex(`wallet:${context.plan.walletAuthOrigin}:${payer.toLowerCase()}`) : undefined;
  if (state) requireAcceptance(state.planHash === context.planHash && state.apiBase === context.apiBase && state.ownerHash === ownerHash, "JOURNAL_SCOPE_MISMATCH");
  const checked = await preflight(context, deps, !state || ["new", "session", "challenge"].includes(state.phase));
  if (mode === "preflight") return { ok: true, status: "preflight-only", expectedPriceUnits: context.plan.expectedPriceUnits, capUnits: "1000000", maxOutputTokens: context.plan.maxOutputTokens,
    payerConfigured: !!checked.payer, walletAuthEnabled: true, mutations: 0, completionPosts: 0, priorPhase: state?.phase ?? null };
  requireAcceptance(payer && ownerHash, "PAYER_KEY_REQUIRED");
  if (mode === "recover" && !state) return { ok: true, status: "read-only-recovery", phase: "not-started", completionRetryAllowed: false };
  if (!state && mode === "execute") { state = { schemaVersion: 1, planHash: context.planHash, apiBase: context.apiBase, ownerHash, idempotencyKey: randomUUID(), phase: "new", completionPosts: 0 }; await deps.store.save(state); }
  requireAcceptance(state, "JOURNAL_INCOMPLETE");
  deps = await authenticateWallet(context, deps, state, payer, mode);
  if (mode === "recover") {
    if (!state?.paymentId) return { ok: true, status: "read-only-recovery", phase: state?.phase ?? "not-started", paymentStatus: null, completionRetryAllowed: false };
    const owner = await ownedEvidence(deps.api, state.paymentId, state.result?.typedHash);
    if (state.phase === "settlement-starting" && owner.payment?.status === "settled" && owner.payment.settleTx) {
      requireAcceptance(owner.payment.amountUnits === context.plan.expectedPriceUnits && !owner.payment.confidential, "PAYMENT_HISTORY_MISMATCH");
      state.settleTx = owner.payment.settleTx; state.phase = "settled"; await deps.store.save(state);
    }
    return { ok: true, status: "read-only-recovery", phase: state.phase, paymentStatus: owner.payment?.status ?? null,
      receiptPresent: !!owner.receipt, completionRetryAllowed: false };
  }
  if (mode === "execute") {
    requireAcceptance(context.payerKey && checked.payer, "PAYER_KEY_REQUIRED");
    requireAcceptance(!["session-starting", "challenge-starting", "settlement-starting", "completion-starting"].includes(state.phase), "AMBIGUOUS_REQUEST_RECOVERY_REQUIRED");
    if (state.phase === "new") {
      const quote = parsed(z.object({ cpuQuote: z.string(), gpuQuote: z.string(), measurement: hash, tcbVersion: z.number(), timestamp: z.number(), signature }), await get(deps.api, "/v1/attestation/quote"), "QUOTE_INVALID");
      requireAcceptance(quote.measurement === context.plan.release.codeHash && quote.tcbVersion === context.plan.release.tcbVersion && Math.abs(deps.now() - quote.timestamp) <= 300_000, "QUOTE_MISMATCH");
      state.phase = "session-starting"; await deps.store.save(state);
      const opened = await deps.api("/v1/session", "POST", quote); requireHttp(opened, 201, "SESSION_FAILED");
      const session = parsed(z.object({ sessionId: z.string().uuid(), expiresAt: z.string().datetime(), wrapKey: base64 }), opened.data, "SESSION_INVALID");
      requireAcceptance(Buffer.from(session.wrapKey, "base64").length === 32 && Date.parse(session.expiresAt) > deps.now(), "SESSION_INVALID");
      state.session = { ...session, attRef: sha256Hex(quote.signature) };
      state.request = { sessionId: session.sessionId, ...encryptAesGcm(Buffer.from(session.wrapKey, "base64"), Buffer.from(ACCEPTANCE_PROMPT)) };
      state.phase = "session"; await deps.store.save(state);
    }
    requireAcceptance(state.session && state.request, "JOURNAL_INCOMPLETE");
    assertSavedRequest(state);
    if (state.authorization) await assertSavedAuthorization(context, state, payer);
    if (["session", "challenge", "settled"].includes(state.phase)) requireAcceptance(Date.parse(state.session.expiresAt) > deps.now(), "SESSION_EXPIRED_NO_NEW_PAYMENT");
    if (state.phase === "session") {
      state.phase = "challenge-starting"; await deps.store.save(state);
      const challenge = await deps.api("/v1/inference", "POST", state.request, { "idempotency-key": state.idempotencyKey });
      requireHttp(challenge, 402, "UNPAID_COMPLETION_UNEXPECTED");
      const required = parsed(z.object({ title: z.literal("PAYMENT_REQUIRED"), details: z.object({ x402Version: z.literal(1), accepts: z.array(z.object({ scheme: z.literal("exact"), network: z.literal("arc-5042"),
        maxAmountRequired: uint, payTo: address, asset: address, extra: z.object({ paymentId: z.string().uuid(), receiptPending: z.literal(true) }) })).length(1) }) }), challenge.data, "CHALLENGE_INVALID").details.accepts[0]!;
      requireAcceptance(required.maxAmountRequired === context.plan.expectedPriceUnits && same(required.asset, context.plan.release.contracts.USDC)
        && same(required.payTo, context.plan.release.contracts.UsageMeter), "CHALLENGE_MISMATCH");
      state.paymentId = required.extra.paymentId; state.phase = "challenge"; await deps.store.save(state);
    }
    if (state.phase === "challenge") {
      requireAcceptance(state.paymentId, "JOURNAL_INCOMPLETE");
      await preflight(context, deps);
      if (!state.authorization) {
        const validBefore = String(Math.min(Math.floor(deps.now() / 1000) + 600, Math.floor(Date.parse(state.session.expiresAt) / 1000)));
        const signed = await privateKeyToAccount(context.payerKey).signTypedData({ domain: { ...context.plan.usdcDomain, chainId: 5042, verifyingContract: context.plan.release.contracts.USDC },
          types: receiveTypes, primaryType: "ReceiveWithAuthorization", message: { from: checked.payer, to: context.plan.release.contracts.UsageMeter,
            value: BigInt(context.plan.expectedPriceUnits), validAfter: 0n, validBefore: BigInt(validBefore), nonce: keccak256(stringToHex(state.paymentId)) } });
        state.authorization = { from: checked.payer, validAfter: "0", validBefore, signature: signed };
      } else {
        await assertSavedAuthorization(context, state, payer);
        requireAcceptance(BigInt(state.authorization.validBefore) > BigInt(Math.floor(deps.now() / 1000))
          && BigInt(state.authorization.validBefore) <= BigInt(Math.floor(Date.parse(state.session.expiresAt) / 1000)), "ORIGINAL_AUTHORIZATION_EXPIRED_NO_REPLACEMENT");
      }
      state.phase = "settlement-starting"; await deps.store.save(state);
      const settled = await deps.api("/v1/x402/settle", "POST", { paymentId: state.paymentId, confidential: false, authorization: state.authorization });
      requireHttp(settled, 200, "SETTLEMENT_UNCERTAIN");
      const payment = parsed(z.object({ paymentId: z.string().uuid(), tx: hash, confidential: z.literal(false) }), settled.data, "SETTLEMENT_INVALID");
      requireAcceptance(payment.paymentId === state.paymentId, "SETTLEMENT_MISMATCH");
      state.settleTx = payment.tx; state.phase = "settled"; await deps.store.save(state);
    }
    if (state.phase === "settled") {
      await preflight(context, deps, false);
      await assertSavedAuthorization(context, state, payer);
      state.phase = "completion-starting"; state.completionPosts++; await deps.store.save(state);
      const result = await deps.api("/v1/inference", "POST", state.request, { "idempotency-key": state.idempotencyKey, "x-payment": state.paymentId! });
      requireHttp(result, 200, "COMPLETION_UNCERTAIN_NO_RETRY");
      state.result = parsed(resultSchema, result.data, "RESULT_INVALID_NO_RETRY"); state.phase = "response-received"; await deps.store.save(state);
    }
  }
  requireAcceptance(state?.paymentId && state.session && state.request, "JOURNAL_INCOMPLETE");
  assertSavedRequest(state);
  await assertSavedAuthorization(context, state, payer);
  if (mode === "recover-completed") {
    const owner = await ownedEvidence(deps.api, state.paymentId, state.result?.typedHash);
    requireAcceptance(owner.payment?.status === "consumed" && owner.payment.receiptHash && owner.receipt
      && owner.payment.amountUnits === context.plan.expectedPriceUnits && !owner.payment.confidential && owner.payment.settleTx, "COMPLETION_NOT_PROVEN_PERSISTED");
    const persisted = { ...owner.receipt, ts: BigInt(owner.receipt.ts) }, release = context.plan.release;
    requireAcceptance(owner.receipt.chainId === 5042 && same(owner.receipt.verifierAddress, release.contracts.AttestationVerifier)
      && same(persisted.modelHash, release.modelHash) && same(persisted.codeHash, release.codeHash)
      && same(persisted.inHash, sha256Hex(ACCEPTANCE_PROMPT)) && same(persisted.attRef, state.session.attRef)
      && same(receiptTypedHash(persisted, 5042, release.contracts.AttestationVerifier), owner.payment.receiptHash)
      && await verifyReceiptSignature(persisted, release.signer, 5042, release.contracts.AttestationVerifier).catch(() => false), "PERSISTED_RECEIPT_INVALID");
    if (state.settleTx) requireAcceptance(same(state.settleTx, owner.payment.settleTx), "PAYMENT_HISTORY_MISMATCH");
    state.expectedReceiptHash = owner.payment.receiptHash; state.settleTx = owner.payment.settleTx;
    if (state.result) requireAcceptance(state.result.typedHash === state.expectedReceiptHash, "REPLAY_RECEIPT_MISMATCH");
    requireAcceptance(Date.parse(state.session.expiresAt) > deps.now(), "SESSION_EXPIRED_NO_COMPLETION_REPLAY");
    state.phase = "completion-starting"; state.completionPosts++; await deps.store.save(state);
    const replay = await deps.api("/v1/inference", "POST", state.request, { "idempotency-key": state.idempotencyKey, "x-payment": state.paymentId });
    requireHttp(replay, 200, "COMPLETION_REPLAY_UNCERTAIN");
    const result = parsed(resultSchema, replay.data, "RESULT_INVALID_NO_RETRY");
    requireAcceptance(result.typedHash === state.expectedReceiptHash, "REPLAY_RECEIPT_MISMATCH");
    state.result = result; state.replayVerified = true; state.phase = "response-received"; await deps.store.save(state);
  }
  requireAcceptance(state.result && state.settleTx, "PRIVATE_RESULT_MISSING_NO_AUTOMATIC_RETRY");
  const archive = await verifyAcceptanceResult(context, deps, state);
  state.phase = "completed"; state.checkedAt ??= new Date(deps.now()).toISOString(); await deps.store.save(state);
  await deps.store.write("inference.json", Buffer.from(JSON.stringify(archive, null, 2)));
  await deps.store.write("provider-policy.json", context.policyBytes);
  const owner = await ownedEvidence(deps.api, state.paymentId, state.result.typedHash);
  requireAcceptance(owner.payment?.status === "consumed" && owner.payment.receiptHash === state.result.typedHash && owner.payment.settleTx === state.settleTx
    && owner.payment.amountUnits === context.plan.expectedPriceUnits && !owner.payment.confidential, "PAYMENT_HISTORY_MISMATCH");
  if (!owner.receipt?.anchoredTx || owner.receipt.status !== "anchored") return { ok: true, status: "awaiting-anchor", paymentId: state.paymentId, receiptHash: state.result.typedHash,
    privateArchiveSaved: true, paidCompletionPosts: state.completionPosts, automaticRetry: false, replayVerified: state.replayVerified ?? false };
  await deps.chain.verify(context.plan, { paymentId: state.paymentId, payer, settleTx: state.settleTx,
    anchorTx: owner.receipt.anchoredTx, receipt: archive.receipt });
  const acceptedAt = new Date(deps.now()).toISOString();
  const manifest: ProductionReleaseManifest = productionReleaseManifestSchema.parse({ ...context.plan.release,
    providerPolicy: { ...context.plan.release.providerPolicy, path: "provider-policy.json" },
    acceptance: { acceptedAt, validUntil: context.plan.acceptanceValidUntil },
    acceptedInference: { path: "inference.json", sha256: sha256Hex(Buffer.from(JSON.stringify(archive, null, 2))), checkedAt: state.checkedAt, anchorTx: owner.receipt.anchoredTx },
    acceptedPayment: { settleTx: state.settleTx, checkedAt: acceptedAt, amountUnits: context.plan.expectedPriceUnits, payer } });
  await deps.store.validate(manifest, deps.now());
  await deps.store.write("release-manifest.candidate.json", Buffer.from(JSON.stringify({ status: "REVIEW_REQUIRED", preparedAt: acceptedAt,
    checks: { receiptSignature: true, providerSignature: true, hardwareReplay: true, canonicalSettlement: true, canonicalAnchor: true, persistedPaymentConsumed: true,
      restartReplayVerified: state.replayVerified ?? false }, manifest }, null, 2)));
  return { ok: true, status: "acceptance-evidence-prepared", paymentId: state.paymentId, receiptHash: state.result.typedHash,
    settleTx: state.settleTx, anchorTx: owner.receipt.anchoredTx, paidAmountUnits: context.plan.expectedPriceUnits,
    candidateReviewRequired: true, paidCompletionPosts: state.completionPosts, automaticRetry: false, replayVerified: state.replayVerified ?? false };
}

const registryAbi = parseAbi(["function TCB_BINDING_VERSION() view returns(uint256)", "function isApprovedWithPolicy(bytes32,bytes32,bytes32,uint64) view returns(bool)"]);
const verifierAbi = parseAbi(["function registry() view returns(address)", "function enclaveSigner() view returns(address)",
  "event Verified(bytes32 indexed receiptHash,bytes32 modelHash,bytes32 codeHash,bytes32 inHash,bytes32 outHash,bytes32 attRef,address signer)"]);
const meterAbi = parseAbi(["function usdc() view returns(address)", "function feeVault() view returns(address)", "function modelRegistry() view returns(address)", "function relay() view returns(address)",
  "event Settled(address indexed payer,uint256 amount,bytes32 indexed receiptHash,bool confidentialPath)"]);
const tokenAbi = parseAbi(["function decimals() view returns(uint8)", "function DOMAIN_SEPARATOR() view returns(bytes32)", "function balanceOf(address) view returns(uint256)"]);
export function createAcceptanceChain(rpcUrl: string): AcceptanceChain {
  const rpc = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 15_000 }), cacheTime: 0 });
  return {
    async preflight(plan, payer) {
      requireAcceptance(await rpc.getChainId() === 5042, "RPC_CHAIN_MISMATCH");
      const latest = await rpc.getBlock(), depth = BigInt(plan.confirmations), contracts = plan.release.contracts;
      requireAcceptance(latest.hash && latest.number !== null && latest.number >= depth, "CHAIN_BLOCK_UNAVAILABLE");
      const block = await rpc.getBlock({ blockNumber: latest.number - depth });
      requireAcceptance(block.hash && block.number === latest.number - depth, "CHAIN_BLOCK_UNAVAILABLE");
      const read = (contract: Hex, abi: typeof registryAbi | typeof verifierAbi | typeof meterAbi | typeof tokenAbi, name: string, args: unknown[] = []) => rpc.readContract({ address: contract, abi, functionName: name, args, blockNumber: block.number } as never);
      const [binding, approved, registry, signer, token, vault, meterRegistry, decimals, domain, balance] = await Promise.all([
        read(contracts.ModelRegistry, registryAbi, "TCB_BINDING_VERSION"), read(contracts.ModelRegistry, registryAbi, "isApprovedWithPolicy", [plan.release.modelHash, plan.release.codeHash, plan.release.policyHash, BigInt(plan.release.tcbVersion)]),
        read(contracts.AttestationVerifier, verifierAbi, "registry"), read(contracts.AttestationVerifier, verifierAbi, "enclaveSigner"), read(contracts.UsageMeter, meterAbi, "usdc"),
        read(contracts.UsageMeter, meterAbi, "feeVault"), read(contracts.UsageMeter, meterAbi, "modelRegistry"), read(contracts.USDC, tokenAbi, "decimals"),
        read(contracts.USDC, tokenAbi, "DOMAIN_SEPARATOR"), payer ? read(contracts.USDC, tokenAbi, "balanceOf", [payer]) : null,
      ]);
      const expectedDomain = hashDomain({ types: tokenDomainTypes, domain: { ...plan.usdcDomain, chainId: 5042n, verifyingContract: contracts.USDC } });
      requireAcceptance(binding === 1n && approved === true && same(String(registry), contracts.ModelRegistry) && same(String(signer), plan.release.signer)
        && same(String(token), contracts.USDC) && same(String(vault), contracts.FeeVault) && same(String(meterRegistry), contracts.ModelRegistry)
        && decimals === 6 && same(String(domain), expectedDomain), "CHAIN_POLICY_OR_DOMAIN_MISMATCH");
      requireAcceptance((await rpc.getBlock({ blockNumber: block.number })).hash === block.hash, "CHAIN_REORGANIZED");
      return { payerBalanceUnits: balance === null ? null : String(balance) };
    },
    async verify(plan, input) {
      requireAcceptance(await rpc.getChainId() === 5042, "RPC_CHAIN_MISMATCH");
      const [settlement, anchor, head] = await Promise.all([rpc.getTransactionReceipt({ hash: input.settleTx }), rpc.getTransactionReceipt({ hash: input.anchorTx }), rpc.getBlockNumber()]);
      for (const [receipt, contract, txHash] of [[settlement, plan.release.contracts.UsageMeter, input.settleTx], [anchor, plan.release.contracts.AttestationVerifier, input.anchorTx]] as const) {
        requireAcceptance(same(receipt.transactionHash, txHash) && receipt.status === "success" && receipt.to && same(receipt.to, contract) && head >= receipt.blockNumber + BigInt(plan.confirmations)
          && (await rpc.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash, "TRANSACTION_NOT_CONFIRMED_CANONICAL");
      }
      const settled = parseEventLogs({ abi: meterAbi, eventName: "Settled", logs: settlement.logs.filter(log => same(log.address, plan.release.contracts.UsageMeter)), strict: true })
        .filter(({ args }) => same(args.payer, input.payer) && args.amount === BigInt(plan.expectedPriceUnits) && !args.confidentialPath && same(args.receiptHash, keccak256(stringToHex(input.paymentId))));
      const verified = parseEventLogs({ abi: verifierAbi, eventName: "Verified", logs: anchor.logs.filter(log => same(log.address, plan.release.contracts.AttestationVerifier)), strict: true })
        .filter(({ args }) => same(args.receiptHash, input.receipt.typedHash) && same(args.signer, plan.release.signer)
          && (["modelHash", "codeHash", "inHash", "outHash", "attRef"] as const).every(key => same(args[key], input.receipt[key])));
      requireAcceptance(settled.length === 1 && verified.length === 1, "TRANSACTION_EVENT_MISMATCH");
      for (const receipt of [settlement, anchor]) requireAcceptance((await rpc.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash, "CHAIN_REORGANIZED");
    },
  };
}

async function atomicPrivateFile(path: string, bytes: Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  if (process.platform !== "win32") {
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
const artifactNames = ["inference.json", "provider-policy.json", "release-manifest.candidate.json", "settlement-recovery.json"];
/** Protect only an acceptance-owned directory; never change ACLs on a shared workspace. */
export async function preparePrivateAcceptanceDirectory(statePath: string) {
  const directory = dirname(resolve(statePath)), journal = basename(statePath);
  requireAcceptance(!artifactNames.includes(journal) && !journal.endsWith(".lock") && !/[\u0000-\u001f]/.test(journal), "JOURNAL_PATH_INVALID");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await readdir(directory, { withFileTypes: true });
  requireAcceptance(entries.every(entry => entry.isFile() && ([journal, `${journal}.lock`, ...artifactNames].includes(entry.name)
    || entry.name.startsWith(`${journal}.`) && entry.name.endsWith(".tmp")
    || /^\.validation-[a-f0-9-]+\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(entry.name)
    || artifactNames.some(name => entry.name.startsWith(`${name}.`) && entry.name.endsWith(".tmp")))), "JOURNAL_DIRECTORY_NOT_DEDICATED");
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
    for (const entry of entries) await chmod(resolve(directory, entry.name), 0o600);
    return;
  }
  // Fixed script and stdin JSON avoid shell interpolation of an operator-supplied path.
  const script = `$ErrorActionPreference='Stop'; $doc=[Console]::In.ReadToEnd() | ConvertFrom-Json; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $principals=@($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));
    $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false);
    foreach($p in $principals){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($p,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};
    [IO.Directory]::SetAccessControl($doc.directory,$acl);
    foreach($path in [IO.Directory]::EnumerateFiles($doc.directory)){ $f=[Security.AccessControl.FileSecurity]::new();$f.SetOwner($sid);$f.SetAccessRuleProtection($true,$false);
      foreach($p in $principals){$f.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($p,'FullControl','Allow'))};[IO.File]::SetAccessControl($path,$f) };`;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    const timeout = setTimeout(() => { child.kill(); reject(new AcceptanceError("PRIVATE_DIRECTORY_PROTECTION_FAILED")); }, 15_000);
    child.once("error", () => { clearTimeout(timeout); reject(new AcceptanceError("PRIVATE_DIRECTORY_PROTECTION_FAILED")); });
    child.once("exit", code => { clearTimeout(timeout); if (code === 0) resolvePromise(); else reject(new AcceptanceError("PRIVATE_DIRECTORY_PROTECTION_FAILED")); });
    child.stdin.on("error", () => undefined); child.stdin.end(JSON.stringify({ directory }));
  });
}

/** Explicit operator recovery only. It never sends a request or resumes a paid operation. */
export async function unlockStaleAcceptanceLock(statePath: string) {
  const lockPath = `${resolve(statePath)}.lock`, bytes = await readFile(lockPath);
  requireAcceptance(bytes.length <= 64 && /^[1-9][0-9]{0,9}$/.test(bytes.toString()), "LOCK_INVALID");
  const pid = Number(bytes.toString()); requireAcceptance(Number.isSafeInteger(pid) && pid <= 2_147_483_647, "LOCK_INVALID");
  try { process.kill(pid, 0); throw new AcceptanceError("LOCK_OWNER_ACTIVE"); }
  catch (error) { requireAcceptance((error as NodeJS.ErrnoException).code === "ESRCH", error instanceof AcceptanceError ? error.code : "LOCK_OWNER_UNCERTAIN"); }
  requireAcceptance((await readFile(lockPath)).equals(bytes), "LOCK_CHANGED");
  await unlink(lockPath);
}
export function createAcceptanceStore(statePath: string): AcceptanceStore {
  const path = resolve(statePath), directory = dirname(path);
  requireAcceptance(!artifactNames.includes(basename(path)), "JOURNAL_PATH_INVALID");
  return { async load() { try { const bytes = await readFile(path); requireAcceptance(bytes.length <= 16_777_216, "JOURNAL_INVALID"); return parsed(stateSchema, JSON.parse(bytes.toString("utf8")), "JOURNAL_INVALID"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new AcceptanceError("JOURNAL_INVALID"); } },
  async save(state) { await atomicPrivateFile(path, Buffer.from(JSON.stringify(stateSchema.parse(state)))); },
  async write(name, bytes) { requireAcceptance(artifactNames.includes(name), "ARTIFACT_PATH_INVALID"); await atomicPrivateFile(resolve(directory, name), bytes); },
  async validate(manifest, now) {
    const temporary = resolve(directory, `.validation-${randomUUID()}.json`);
    try { await atomicPrivateFile(temporary, Buffer.from(JSON.stringify(manifest))); await validateProductionRelease(temporary, { now }); }
    finally { await unlink(temporary).catch(() => undefined); }
  } };
}

async function main() {
  const options = acceptanceOptions(process.argv.slice(2)); if (options.help) { process.stdout.write(`${acceptanceUsage}\n`); return; }
  if (options.mode === "unlock-stale") { await unlockStaleAcceptanceLock(options.statePath); process.stdout.write(`${JSON.stringify({ ok: true, status: "stale-lock-removed", automaticRetry: false })}\n`); return; }
  const env = { ...process.env, ...(options.envPath ? parseEnv(await readFile(options.envPath)) : {}) };
  const planBytes = await readFile(options.planPath), plan = parsed(acceptancePlanSchema, JSON.parse(planBytes.toString("utf8")), "PLAN_INVALID");
  const policyPath = resolve(dirname(options.planPath), plan.release.providerPolicy.path), policyBytes = await readFile(policyPath);
  const apiBase = acceptanceApiBase(env.ACCEPTANCE_API_BASE ?? "");
  const payerKey = env.ACCEPTANCE_PAYER_PRIVATE_KEY ? parsed(z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value as Hex), env.ACCEPTANCE_PAYER_PRIVATE_KEY, "PAYER_KEY_INVALID") : undefined;
  requireAcceptance(env.ARC_RPC_URL, "RPC_REQUIRED");
  if (options.mode !== "preflight" && options.mode !== "recover") requireAcceptance(env.NEAR_VERIFIER_PYTHON, "HARDWARE_VERIFIER_REQUIRED");
  if (env.NEAR_VERIFIER_SCRIPT) requireAcceptance(isAbsolute(env.NEAR_VERIFIER_SCRIPT)
    && !/[\0\r\n]/.test(env.NEAR_VERIFIER_SCRIPT), "HARDWARE_VERIFIER_SCRIPT_INVALID");
  const store = createAcceptanceStore(options.statePath), lockPath = `${options.statePath}.lock`;
  if (options.mode !== "preflight") await preparePrivateAcceptanceDirectory(options.statePath);
  const lock = options.mode === "preflight" ? undefined : await open(lockPath, "wx", 0o600).catch(() => { throw new AcceptanceError("JOURNAL_LOCKED"); });
  try {
    if (lock) { await lock.writeFile(String(process.pid)); await lock.sync(); }
    const result = await runNearArcAcceptance({ plan, planHash: sha256Hex(planBytes), policyBytes, apiBase, ...(payerKey ? { payerKey } : {}) }, options.mode, {
      api: createAcceptanceApi(apiBase, ""), chain: createAcceptanceChain(env.ARC_RPC_URL), store, now: Date.now,
      async verifyHardware(archive) {
        const proof = parsed(z.object({ report: z.record(z.unknown()), verdict: z.object({ tlsSpkiSha256: z.string() }).passthrough(), policyHash: hash }), JSON.parse(archive.providerTranscript.attestationProof), "HARDWARE_ARCHIVE_INVALID");
        requireAcceptance(same(proof.policyHash, plan.release.providerPolicy.sha256), "HARDWARE_POLICY_MISMATCH");
        const cloud = plan.providerOrigin === "https://cloud-api.near.ai", evidence = archive.providerProof.evidence;
        const report = cloud ? proof.report.gateway_attestation : proof.report;
        const nonce = parsed(z.object({ request_nonce: z.string().regex(/^[0-9a-fA-F]{64}$/) }), report, "HARDWARE_NONCE_MISSING").request_nonce;
        const verdict = await runNearVerifier({ pythonPath: env.NEAR_VERIFIER_PYTHON!, policyPath, policySha256: plan.release.providerPolicy.sha256,
          ...nvidiaVerifierOptions(env), ...(env.NEAR_VERIFIER_SCRIPT ? { verifierPath: env.NEAR_VERIFIER_SCRIPT } : {}) },
          { nonce, tlsSpkiSha256: proof.verdict.tlsSpkiSha256, ...(cloud ? { model: plan.release.modelId } : {}), attestation: proof.report, archivedVerdict: proof.verdict }, AbortSignal.timeout(300_000), cloud, true);
        requireAcceptance(verdict.archivedHardwareVerified === true && same(verdict.attestationRef, evidence.attestationRef)
          && verdict.verifiedAt === evidence.verifiedAt && verdict.expiresAt === evidence.expiresAt
          && (verdict.allowedSigners ?? [verdict.signingAddress]).some(signer => same(signer, evidence.signingAddress)), "HARDWARE_REPLAY_MISMATCH");
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { if (lock) { await lock.close(); await unlink(lockPath); } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${JSON.stringify({ ok: false, code: error instanceof AcceptanceError || error instanceof ProductionReleaseError ? error.code : "ACCEPTANCE_FAILED",
    ...(error instanceof AcceptanceError && error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
    ...(error instanceof AcceptanceError && error.apiTitle !== undefined ? { apiTitle: error.apiTitle } : {}),
    ...(error instanceof AcceptanceError && error.failureFields !== undefined ? { failureFields: error.failureFields } : {}), automaticRetry: false })}\n`); process.exitCode = 1; });
}
