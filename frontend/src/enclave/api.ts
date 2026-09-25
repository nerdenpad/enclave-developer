import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { z } from "zod";
import arc from "./arc-mainnet.json" with { type: "json" };
import { ArcPaymentPolicySchema, receiveData, type ArcPaymentPolicy, type ArcAuthorization, type ArcPaymentIntent } from "./arc-payment";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v as Hex);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => v as Hex);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((v) => v as Hex);
const uuid = z.string().uuid();
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/).max(78);
const date = z.string().datetime({ offset: true });
const MAX_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 8 * MAX_BYTES;

export const HealthSchema = z.object({
  ok: z.literal(true), service: z.string(), teeMode: z.string(), inferenceBackend: z.string(),
  chainId: z.number().int().positive().safe(), paymentMode: z.enum(["mock", "authorized"]),
  servingModel: z.object({ id: z.string(), name: z.string(), modelHash: hex32, codeHash: hex32 }),
  receiptSigner: address, verifierAddress: address, agentRuntimeEnabled: z.boolean(),
  inferencePriceUsdc: z.number().finite().nonnegative(),
  deployment: z.object({ stage: z.literal("development"), productionReady: z.literal(false), gatewayKeyCustody: z.literal("software") }).optional(),
  limits: z.object({ inferenceTimeoutMs: z.number().int().positive().safe(), maxOutputTokens: z.number().int().positive().nullable() }).optional(),
  settlementToken: address.optional(),
});
export type Health = z.infer<typeof HealthSchema>;
const QuoteSchema = z.object({
  cpuQuote: z.string(), gpuQuote: z.string(), measurement: hex32,
  tcbVersion: z.number().int().positive(), timestamp: z.number().int().nonnegative().safe(), signature,
});
export type Quote = z.infer<typeof QuoteSchema>;
const BlobSchema = z.object({ iv: z.string(), tag: z.string(), ciphertext: z.string() });
export type EncryptedBlob = z.infer<typeof BlobSchema>;
const ReceiptSchema = z.object({
  receiptVersion: z.literal(2), nonce: hex32, modelHash: hex32, codeHash: hex32,
  inHash: hex32, outHash: hex32, attRef: hex32, ts: uint, sig: signature,
});
export type Receipt = z.infer<typeof ReceiptSchema>;
export const RECEIPT_TYPES = { InferenceReceipt: [
  { name: "modelHash", type: "bytes32" }, { name: "codeHash", type: "bytes32" },
  { name: "inHash", type: "bytes32" }, { name: "outHash", type: "bytes32" },
  { name: "attRef", type: "bytes32" }, { name: "nonce", type: "bytes32" }, { name: "ts", type: "uint64" },
] } as const;
const InferenceSchema = z.object({ receipt: ReceiptSchema, typedHash: hex32, outputHash: hex32, output: BlobSchema, providerEvidence: z.unknown().optional() });
const ChallengeSchema = z.object({
  x402Version: z.literal(1), accepts: z.array(z.object({
    scheme: z.literal("exact"), network: z.string(), maxAmountRequired: uint,
    payTo: address, asset: address, extra: z.object({ receiptPending: z.literal(true), paymentId: uuid }),
  })).length(1),
});
export type PaymentChallenge = z.infer<typeof ChallengeSchema>;
const AgentSchema = z.object({ id: uuid, name: z.string(), policyHash: hex32, memoryHash: hex32, createdAt: date,
  dailyLimitUnits: uint.nullable().optional(), spentTodayUnits: uint.nullable().optional(),
  lane: z.string().nullable().optional(), allowedModels: z.array(z.string()).nullable().optional(),
});
export type Agent = z.infer<typeof AgentSchema>;
const ModelSchema = z.object({
  id: uuid, modelHash: hex32, codeHash: hex32, version: z.string(), provider: z.string(),
  approved: z.boolean(), revoked: z.boolean(), listingBps: z.number(), listingId: z.number().nullable(),
  createdAt: date,
});
export type Model = z.infer<typeof ModelSchema>;
const PolicySchema = z.object({
  version: z.number(), servingImageId: z.string(), measurement: hex32, policyHash: hex32,
  status: z.string(), binding: z.string().nullable(), scope: z.string().nullable(),
  trustMode: z.literal("development-software"), activatedAt: date.nullable(), createdAt: date,
});
export type Policy = z.infer<typeof PolicySchema>;
const PoliciesSchema = z.object({ active: PolicySchema, history: z.array(PolicySchema) });
export type Policies = z.infer<typeof PoliciesSchema>;
const WorkspaceReceiptSchema = z.object({
  id: uuid, receiptVersion: z.number(), nonce: hex32.nullable(), chainId: z.number().nullable(),
  verifierAddress: address.nullable(), modelHash: hex32, codeHash: hex32, inHash: hex32, outHash: hex32,
  attRef: hex32, ts: uint, sig: signature, typedHash: hex32, status: z.string(),
  anchoredTx: z.string().nullable(), agentId: uuid.nullable(), createdAt: date,
});
const WorkspacePaymentSchema = z.object({
  id: uuid, amountUnits: uint, status: z.string(), settleTx: z.string().nullable(),
  receiptHash: hex32.nullable(), agentId: uuid.nullable(), listingId: z.number().nullable(),
  confidential: z.boolean(), createdAt: date,
});
const UsageSchema = z.object({ calls: z.number().int().nonnegative(), usdcUnits: uint });
const WorkspaceSchema = z.object({
  usage: UsageSchema, receipts: z.array(WorkspaceReceiptSchema), payments: z.array(WorkspacePaymentSchema),
  agents: z.array(AgentSchema), page: z.object({ limit: z.number(), receiptsNext: z.string().nullable(), paymentsNext: z.string().nullable(), agentsNext: z.string().nullable() }),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type WorkspaceReceipt = Workspace["receipts"][number];
export type WorkspacePayment = Workspace["payments"][number];
export interface StoredReceiptVerification { signature: true; typedHash: true; ioHashesVerified: false; hardwareAttestationVerified: false }
export interface WorkspaceQuery { limit?: number; receiptsBefore?: string; paymentsBefore?: string; agentsBefore?: string }
export interface RequestOptions { signal?: AbortSignal }
export type InferenceStep = "connecting" | "attesting" | "encrypting" | "payment-required" | "settling" | "inferencing" | "verifying" | "complete";
export interface InferenceOptions extends RequestOptions { onStep?: (step: InferenceStep) => void }
export interface Session { readonly sessionId: string; readonly expiresAt: string; readonly attRef: Hex }
export interface PreparedInference {
  readonly idempotencyKey: string; readonly sessionId: string; readonly inputHash: Hex;
  readonly health: Health; readonly challenge: PaymentChallenge | null; readonly result: VerifiedInference | null;
}
export interface VerifiedInference {
  receipt: Receipt; typedHash: Hex; outputBytes: Uint8Array; outputText: string | null;
  paymentId: string | null; providerEvidence?: unknown;
  verification: { signature: true; inputHash: true; outputHash: true; attestationRef: true; hardwareAttestationVerified: false };
}
export interface ViewKey { id: string; label: string; secret: string }
export interface AuditExport { auditor: { id: string; label: string }; receipts: Array<Record<string, unknown>>; payments: Array<Record<string, unknown>>; usage: { calls: number; usdcUnits: string } }

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message); this.name = "ApiError";
  }
}
function invalid(message = "The gateway returned an invalid response"): never { throw new ApiError(0, "INVALID_RESPONSE", message); }
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) return invalid();
  return result.data;
}
function bytesBuffer(bytes: Uint8Array): ArrayBuffer { return new Uint8Array(bytes).buffer; }
function toBase64(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
function fromBase64(value: string, maxBytes = MAX_BYTES): Uint8Array {
  if (value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return invalid("Invalid encrypted payload");
  const decoded = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (decoded.length > maxBytes || toBase64(decoded) !== value) return invalid("Invalid encrypted payload");
  return decoded;
}
export async function sha256Hex(input: Uint8Array | string): Promise<Hex> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytesBuffer(bytes)));
  return `0x${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function importSessionKey(base64: string): Promise<CryptoKey> {
  const bytes = fromBase64(base64, 32);
  if (bytes.length !== 32) return invalid("Invalid session key");
  try { return await crypto.subtle.importKey("raw", bytesBuffer(bytes), "AES-GCM", false, ["encrypt", "decrypt"]); }
  finally { bytes.fill(0); }
}
export async function encryptAesGcm(key: CryptoKey, plaintext: Uint8Array): Promise<EncryptedBlob> {
  if (plaintext.length > MAX_BYTES) throw new ApiError(0, "INPUT_TOO_LARGE", "Input exceeds 1 MiB");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, bytesBuffer(plaintext)));
  return { iv: toBase64(iv), tag: toBase64(encrypted.slice(-16)), ciphertext: toBase64(encrypted.slice(0, -16)) };
}
export async function decryptAesGcm(key: CryptoKey, blob: EncryptedBlob): Promise<Uint8Array> {
  const iv = fromBase64(blob.iv, 12); const tag = fromBase64(blob.tag, 16); const ciphertext = fromBase64(blob.ciphertext);
  if (iv.length !== 12 || tag.length !== 16) return invalid("Invalid encrypted payload");
  const combined = new Uint8Array(ciphertext.length + tag.length); combined.set(ciphertext); combined.set(tag, ciphertext.length);
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytesBuffer(iv), tagLength: 128 }, key, combined)); }
  catch { throw new ApiError(0, "OUTPUT_AUTHENTICATION_FAILED", "Encrypted output authentication failed"); }
}

export function canSettleLocally(health: Health): boolean {
  return health.paymentMode === "mock" && health.chainId === 31337 && health.teeMode === "dev";
}
function baseUrl(value: string): string {
  if (/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(value)) return value.replace(/\/$/, "");
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(0, "INVALID_URL", "Invalid gateway URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) throw new ApiError(0, "INVALID_URL", "Gateway requires HTTPS or loopback HTTP, without credentials or query parameters");
  return url.href.replace(/\/$/, "");
}
function redact(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 12) return "[redacted]";
  if (typeof value === "string") return secrets.filter(Boolean).reduce((s, secret) => s.split(secret).join("[redacted]"), value);
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /secret|password|token|api.?key|authorization|wrap.?key/i.test(k) ? "[redacted]" : redact(v, secrets, depth + 1)]));
  return value;
}
interface PendingState {
  body: string; session: Session; health: Health; inputHash: Hex; challenge: PaymentChallenge | null;
  idempotencyKey: string; settled: boolean; busy: boolean; result: VerifiedInference | null;
  authorization?: ArcAuthorization;
}

/** Browser-only credentials remain in memory. This client does not establish hardware trust in the gateway. */
export class EnclaveClient {
  readonly baseUrl: string;
  #apiKey: string;
  #fetch: typeof fetch;
  #timeout: number;
  #sessions = new WeakMap<Session, CryptoKey>();
  #pending = new WeakMap<PreparedInference, PendingState>();
  #active = new Set<AbortController>();

  constructor(options: { apiKey?: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.baseUrl = baseUrl(options.baseUrl ?? "/api");
    this.#apiKey = options.apiKey ?? "";
    if (/[\r\n]/.test(this.#apiKey) || this.#apiKey.length > 4096) throw new ApiError(0, "INVALID_KEY", "Invalid API key");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeout = options.timeoutMs ?? 360_000;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 360_000) throw new ApiError(0, "INVALID_TIMEOUT", "Request timeout must be between 1 and 360000 ms");
  }
  disconnect(): void {
    this.#apiKey = ""; for (const controller of this.#active) controller.abort();
    this.#sessions = new WeakMap(); this.#pending = new WeakMap();
  }
  async #request(path: string, options: RequestOptions & { method?: "GET" | "POST"; body?: string; auth?: boolean; headers?: Record<string, string> } = {}): Promise<unknown> {
    if (options.auth !== false && !this.#apiKey) throw new ApiError(401, "API_KEY_REQUIRED", "Connect an API key first");
    if (options.signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    const controller = new AbortController(); const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true }); this.#active.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeout);
    try {
      const headers = new Headers({ accept: "application/json", ...options.headers });
      if (options.auth !== false) headers.set("x-api-key", this.#apiKey);
      if (options.body !== undefined) headers.set("content-type", "application/json");
      const response = await this.#fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET", headers, ...(options.body !== undefined ? { body: options.body } : {}),
        signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new ApiError(0, "REDIRECT_REJECTED", "Gateway redirects are not permitted");
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_RESPONSE_BYTES) return invalid("Gateway response exceeds size limit");
      const reader = response.body?.getReader(); if (!reader) return invalid();
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.length;
          if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); return invalid("Gateway response exceeds size limit"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let data: unknown;
      try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return invalid(); }
      if (!response.ok) {
        const problem = z.object({ title: z.string().optional(), details: z.unknown().optional() }).safeParse(data);
        const code = problem.success && /^[A-Z_]{1,64}$/.test(problem.data.title ?? "") ? problem.data.title! : "HTTP_ERROR";
        throw new ApiError(response.status, code, response.status === 402 ? "Payment required" : `Gateway request failed (${response.status})`, redact(problem.success ? problem.data.details : undefined, [this.#apiKey, options.headers?.["x-view-key"] ?? ""]));
      }
      return data;
    } catch (error) {
      if (timedOut) throw new ApiError(0, "TIMEOUT", "Request timed out; check payment status before retrying");
      if (controller.signal.aborted) throw new DOMException("Request cancelled", "AbortError");
      if (error instanceof ApiError) throw error;
      throw new ApiError(0, "NETWORK_ERROR", "Cannot reach the gateway; no automatic retry was made");
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); this.#active.delete(controller); }
  }
  async health(options: RequestOptions = {}): Promise<Health> { return parse(HealthSchema, await this.#request("/health", { ...options, auth: false })); }
  async models(options: RequestOptions = {}): Promise<Model[]> { return parse(z.array(ModelSchema), await this.#request("/v1/models", { ...options, auth: false })); }
  async policies(options: RequestOptions = {}): Promise<Policies> { return parse(PoliciesSchema, await this.#request("/v1/tcb/policies", { ...options, auth: false })); }
  async verifyReceipt(record: WorkspaceReceipt, options: RequestOptions = {}): Promise<StoredReceiptVerification> {
    const receipt = parse(WorkspaceReceiptSchema, record); const health = await this.health(options);
    try {
      if ((receipt.receiptVersion !== 1 && receipt.receiptVersion !== 2) || receipt.chainId !== health.chainId || receipt.verifierAddress?.toLowerCase() !== health.verifierAddress.toLowerCase() || BigInt(receipt.ts) > (1n << 64n) - 1n || (receipt.receiptVersion === 2 && !receipt.nonce)) throw new Error();
      const fields = receipt.receiptVersion === 2 ? RECEIPT_TYPES.InferenceReceipt : RECEIPT_TYPES.InferenceReceipt.filter((field) => field.name !== "nonce");
      const typed = { domain: { name: "ENCLAVE", version: String(receipt.receiptVersion), chainId: health.chainId, verifyingContract: health.verifierAddress }, types: { InferenceReceipt: fields }, primaryType: "InferenceReceipt" as const, message: { ...receipt, nonce: receipt.nonce ?? `0x${"00".repeat(32)}` as Hex, ts: BigInt(receipt.ts) } };
      if (hashTypedData(typed).toLowerCase() !== receipt.typedHash.toLowerCase() || (await recoverTypedDataAddress({ ...typed, signature: receipt.sig })).toLowerCase() !== health.receiptSigner.toLowerCase()) throw new Error();
      return { signature: true, typedHash: true, ioHashesVerified: false, hardwareAttestationVerified: false };
    } catch { throw new ApiError(0, "RECEIPT_VERIFICATION_FAILED", "Stored receipt signature or domain is invalid"); }
  }
  async workspace(query: WorkspaceQuery = {}, options: RequestOptions = {}): Promise<Workspace> {
    const parsed = parse(z.object({ limit: z.number().int().min(1).max(100).optional(), receiptsBefore: z.string().max(2048).optional(), paymentsBefore: z.string().max(2048).optional(), agentsBefore: z.string().max(2048).optional() }).strict(), query);
    const params = new URLSearchParams(); for (const [key, value] of Object.entries(parsed)) if (value !== undefined) params.set(key, String(value));
    return parse(WorkspaceSchema, await this.#request(`/v1/workspace${params.size ? `?${params}` : ""}`, options));
  }
  async listAgents(options: RequestOptions = {}): Promise<Agent[]> { return parse(z.array(AgentSchema), await this.#request("/v1/agents", options)); }
  async getAgent(agentId: string, options: RequestOptions = {}): Promise<Agent> {
    return parse(AgentSchema, await this.#request(`/v1/agents/${parse(uuid, agentId)}`, options));
  }
  async createAgent(input: { name: string; dailyLimitUsdc: number; allowedModels?: string[] }, options: RequestOptions = {}): Promise<Agent> {
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), dailyLimitUsdc: z.number().finite().positive(), allowedModels: z.array(hex32).optional() }).strict(), input);
    return parse(AgentSchema, await this.#request("/v1/agents", { ...options, method: "POST", body: JSON.stringify(body) }));
  }
  async quote(options: RequestOptions = {}): Promise<Quote> { return parse(QuoteSchema, await this.#request("/v1/attestation/quote", { ...options, auth: false })); }
  async openSession(quote: Quote, options: RequestOptions = {}): Promise<Session> {
    const admitted = parse(QuoteSchema, quote);
    const result = parse(z.object({ sessionId: uuid, expiresAt: date, wrapKey: z.string() }), await this.#request("/v1/session", { ...options, method: "POST", body: JSON.stringify(admitted) }));
    if (Date.parse(result.expiresAt) <= Date.now()) return invalid("Gateway session has already expired");
    const key = await importSessionKey(result.wrapKey);
    const session = Object.freeze({ sessionId: result.sessionId, expiresAt: result.expiresAt, attRef: await sha256Hex(admitted.signature) });
    this.#sessions.set(session, key); return session;
  }
  async prepareInference(prompt: string, options: InferenceOptions & { agentId?: string } = {}): Promise<PreparedInference> {
    if (typeof prompt !== "string" || !prompt.trim()) throw new ApiError(0, "INVALID_INPUT", "Enter a prompt");
    if (options.agentId !== undefined) parse(uuid, options.agentId);
    const plaintext = new TextEncoder().encode(prompt);
    if (plaintext.length > MAX_BYTES) throw new ApiError(0, "INPUT_TOO_LARGE", "Input exceeds 1 MiB");
    options.onStep?.("connecting"); const health = await this.health(options);
    if (options.agentId) {
      const agent = await this.getAgent(options.agentId, options);
      if (agent.memoryHash.toLowerCase() !== await sha256Hex(new Uint8Array())) throw new ApiError(0, "AGENT_MEMORY_UNAVAILABLE", "This agent has sealed memory whose plaintext is unavailable for browser input verification; use a new agent");
    }
    options.onStep?.("attesting"); const quote = await this.quote(options);
    if (quote.measurement.toLowerCase() !== health.servingModel.codeHash.toLowerCase() || Math.abs(Date.now() - quote.timestamp) > 300_000) return invalid("Serving policy changed or quote expired; prepare a new request");
    const session = await this.openSession(quote, options); const key = this.#sessions.get(session)!;
    options.onStep?.("encrypting");
    const blob = await encryptAesGcm(key, plaintext);
    // The gateway prefixes the agent's (verified empty) memory and a newline before inference.
    const composed = options.agentId ? new Uint8Array(plaintext.length + 1) : plaintext;
    if (options.agentId) { composed[0] = 10; composed.set(plaintext, 1); }
    const inputHash = await sha256Hex(composed); composed.fill(0); plaintext.fill(0);
    const idempotencyKey = crypto.randomUUID();
    const body = JSON.stringify({ sessionId: session.sessionId, ...blob, ...(options.agentId ? { agentId: options.agentId } : {}) });
    const state: PendingState = { body, session, health, inputHash, idempotencyKey, challenge: null, settled: false, busy: false, result: null };
    try {
      const response = await this.#request("/v1/inference", { ...options, method: "POST", body, headers: { "idempotency-key": idempotencyKey } });
      state.result = await this.#verify(response, state, options);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 402) throw error;
      state.challenge = parse(ChallengeSchema, error.details);
      const requirement = state.challenge.accepts[0]!;
      const price = Math.round(health.inferencePriceUsdc * 1_000_000);
      if (!Number.isSafeInteger(price) || requirement.network !== `arc-${health.chainId}` || BigInt(requirement.maxAmountRequired) !== BigInt(price)) return invalid("Payment challenge differs from the configured network or price");
      options.onStep?.("payment-required");
    }
    const prepared = Object.freeze({ idempotencyKey, sessionId: session.sessionId, inputHash, health: structuredClone(health), challenge: structuredClone(state.challenge), result: state.result });
    this.#pending.set(prepared, state); return prepared;
  }
  /** Explicit user action only. This never signs or submits a real-network wallet authorization. */
  async settleLocalAndRun(prepared: PreparedInference, options: InferenceOptions = {}): Promise<VerifiedInference> {
    const state = this.#pending.get(prepared);
    if (!state) throw new ApiError(0, "UNKNOWN_REQUEST", "Prepare a request with this connected client first");
    if (state.result) return state.result;
    if (state.busy) throw new ApiError(409, "REQUEST_BUSY", "This request is already running");
    if (!state.challenge) return invalid("No payment challenge is available");
    state.busy = true;
    try {
      if (Date.parse(state.session.expiresAt) <= Date.now()) throw new ApiError(401, "SESSION_EXPIRED", "Session expired; prepare a new request before payment");
      const current = await this.health(options);
      if (!canSettleLocally(state.health) || !canSettleLocally(current)) throw new ApiError(403, "LOCAL_SETTLEMENT_ONLY", "Automatic settlement is available only for local mock payments on development chain 31337");
      if (current.receiptSigner.toLowerCase() !== state.health.receiptSigner.toLowerCase() || current.verifierAddress.toLowerCase() !== state.health.verifierAddress.toLowerCase() || current.servingModel.modelHash !== state.health.servingModel.modelHash || current.servingModel.codeHash !== state.health.servingModel.codeHash || current.inferencePriceUsdc !== state.health.inferencePriceUsdc) throw new ApiError(409, "GATEWAY_CHANGED", "Gateway configuration changed; prepare a new request");
      const paymentId = state.challenge.accepts[0]!.extra.paymentId;
      if (!state.settled) {
        options.onStep?.("settling");
        const settlement = parse(z.object({ paymentId: uuid, tx: z.string().min(1), confidential: z.boolean() }), await this.#request("/v1/x402/settle", { ...options, method: "POST", body: JSON.stringify({ paymentId, confidential: false }) }));
        if (settlement.paymentId !== paymentId || settlement.confidential) return invalid("Settlement response does not match this payment");
        state.settled = true;
      }
      options.onStep?.("inferencing");
      const response = await this.#request("/v1/inference", { ...options, method: "POST", body: state.body, headers: { "idempotency-key": state.idempotencyKey, "x-payment": paymentId } });
      state.result = await this.#verify(response, state, options); return state.result;
    } finally { state.busy = false; }
  }
  /** Explicit confirmation only; retries reuse the exact signed authorization and request body. */
  async settleArcAndRun(prepared: PreparedInference, wallet: { account: { address: string; chainId: number }; authorizeArc: (intent: ArcPaymentIntent) => Promise<ArcAuthorization> },
    policyInput: ArcPaymentPolicy, options: InferenceOptions = {}): Promise<VerifiedInference> {
    const policy = ArcPaymentPolicySchema.parse(policyInput);
    const state = this.#pending.get(prepared);
    if (!state) throw new ApiError(0, "UNKNOWN_REQUEST", "Prepare a request with this connected client first");
    if (state.result) return state.result;
    if (state.busy) throw new ApiError(409, "REQUEST_BUSY", "This request is already running");
    if (!state.challenge) return invalid("No payment challenge is available");
    const requirement = state.challenge.accepts[0]!;
    const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
    const checkHealth = (h: Health) => {
      if (h.chainId !== arc.chainId || h.paymentMode !== "authorized" || !same(h.settlementToken, arc.usdc.address)
        || !same(h.verifierAddress, policy.verifier) || !same(h.receiptSigner, policy.receiptSigner)
        || requirement.network !== `arc-${arc.chainId}` || !same(requirement.asset, arc.usdc.address) || !same(requirement.payTo, policy.meter)
        || BigInt(requirement.maxAmountRequired) <= 0n || BigInt(requirement.maxAmountRequired) > BigInt(policy.maxAmountUnits)
        || Math.round(h.inferencePriceUsdc * 1_000_000).toString() !== requirement.maxAmountRequired
        || h.servingModel.modelHash !== state.health.servingModel.modelHash || h.servingModel.codeHash !== state.health.servingModel.codeHash) {
        throw new ApiError(403, "ARC_PAYMENT_POLICY", "Payment does not match the reviewed Arc deployment and spending limit");
      }
    };
    const checkActive = () => {
      if (options.signal?.aborted || this.#pending.get(prepared) !== state) throw new DOMException("Request cancelled", "AbortError");
      if (Date.parse(state.session.expiresAt) <= Date.now()) throw new ApiError(401, "SESSION_EXPIRED", "Session expired; check payment history before creating another request");
    };
    state.busy = true;
    try {
      checkActive(); checkHealth(state.health); checkHealth(await this.health(options)); checkActive();
      const paymentId = requirement.extra.paymentId;
      if (!state.settled) {
        if (!state.authorization) {
          const payer = wallet.account.address;
          if (wallet.account.chainId !== arc.chainId) throw new ApiError(403, "WRONG_WALLET_NETWORK", "Switch your wallet to Arc Mainnet");
          const intent = { payer, meter: policy.meter, amountUnits: requirement.maxAmountRequired, paymentId,
            validBefore: String(Math.min(Math.floor(Date.now() / 1000) + 600, Math.floor(Date.parse(state.session.expiresAt) / 1000))) };
          const typed = receiveData(intent);
          const auth = await wallet.authorizeArc(intent);
          checkActive();
          if (!same(auth.from, payer) || auth.validAfter !== "0" || auth.validBefore !== intent.validBefore
            || !same(await recoverTypedDataAddress({ ...typed, signature: auth.signature }), payer)
            || !same(wallet.account.address, payer) || wallet.account.chainId !== arc.chainId) return invalid("Payment approval does not match the selected wallet");
          // Persist in memory before the first HTTP submission, including ambiguous network failures.
          state.authorization = Object.freeze({ ...auth });
          checkHealth(await this.health(options)); checkActive();
        }
        checkActive();
        options.onStep?.("settling");
        const settlement = parse(z.object({ paymentId: uuid, tx: hex32, confidential: z.literal(false) }), await this.#request("/v1/x402/settle",
          { ...options, method: "POST", body: JSON.stringify({ paymentId, confidential: false, authorization: state.authorization }) }));
        if (settlement.paymentId !== paymentId) return invalid("Settlement response does not match this payment");
        state.settled = true;
      }
      options.onStep?.("inferencing");
      const response = await this.#request("/v1/inference", { ...options, method: "POST", body: state.body,
        headers: { "idempotency-key": state.idempotencyKey, "x-payment": paymentId } });
      state.result = await this.#verify(response, state, options); return state.result;
    } finally { state.busy = false; }
  }
  async #verify(raw: unknown, state: PendingState, options: InferenceOptions): Promise<VerifiedInference> {
    if (options.signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    options.onStep?.("verifying"); const response = parse(InferenceSchema, raw); const receipt = response.receipt;
    const key = this.#sessions.get(state.session); if (!key) throw new ApiError(401, "SESSION_CLOSED", "Session is no longer available");
    const outputBytes = await decryptAesGcm(key, response.output); const outHash = await sha256Hex(outputBytes);
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const domain = { name: "ENCLAVE", version: "2", chainId: state.health.chainId, verifyingContract: state.health.verifierAddress } as const;
    try {
      if (BigInt(receipt.ts) > (1n << 64n) - 1n || !same(receipt.modelHash, state.health.servingModel.modelHash) || !same(receipt.codeHash, state.health.servingModel.codeHash) || !same(receipt.inHash, state.inputHash) || !same(receipt.outHash, outHash) || !same(response.outputHash, outHash) || !same(receipt.attRef, state.session.attRef)) throw new Error();
      const typed = { domain, types: RECEIPT_TYPES, primaryType: "InferenceReceipt" as const, message: { ...receipt, ts: BigInt(receipt.ts) } };
      if (!same(hashTypedData(typed), response.typedHash)) throw new Error();
      const signer = await recoverTypedDataAddress({ ...typed, signature: receipt.sig });
      if (!same(signer, state.health.receiptSigner)) throw new Error();
    } catch { outputBytes.fill(0); throw new ApiError(0, "RECEIPT_VERIFICATION_FAILED", "Receipt signature, domain or request/output binding is invalid"); }
    let outputText: string | null;
    try { outputText = new TextDecoder("utf-8", { fatal: true }).decode(outputBytes); } catch { outputText = null; }
    if (options.signal?.aborted) { outputBytes.fill(0); throw new DOMException("Request cancelled", "AbortError"); }
    options.onStep?.("complete");
    return { receipt, typedHash: response.typedHash, outputBytes, outputText, paymentId: state.challenge?.accepts[0]?.extra.paymentId ?? null,
      ...(response.providerEvidence !== undefined ? { providerEvidence: response.providerEvidence } : {}),
      verification: { signature: true, inputHash: true, outputHash: true, attestationRef: true, hardwareAttestationVerified: false } };
  }
  async issueViewKey(label: string, options: RequestOptions = {}): Promise<ViewKey> {
    const body = parse(z.object({ label: z.string().trim().min(1).max(80) }), { label });
    return parse(z.object({ id: uuid, label: z.string(), secret: z.string().min(1) }), await this.#request("/v1/compliance/view-keys", { ...options, method: "POST", body: JSON.stringify(body) }));
  }
  async exportWithViewKey(secret: string, options: RequestOptions = {}): Promise<AuditExport> {
    if (!/^enclave_vk_[0-9a-f]{32}$/.test(secret)) throw new ApiError(0, "INVALID_VIEW_KEY", "Invalid auditor view key");
    return parse(z.object({ auditor: z.object({ id: uuid, label: z.string() }), receipts: z.array(z.record(z.unknown())), payments: z.array(z.record(z.unknown())), usage: UsageSchema }), await this.#request("/v1/compliance/export", { ...options, auth: false, headers: { "x-view-key": secret } }));
  }
}
