import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { recoverMessageAddress } from "viem";
import { z } from "zod";
import { AppError, ValidationError } from "./errors.js";
import { sha256Hex } from "./hash.js";

type Hex = `0x${string}`;

/** Must enforce the attested TLS key on every connection, including reconnects. */
export type NearVerifiedFetch = (url: URL, init: RequestInit) => Promise<Response>;

export type NearVerifiedSession = {
  allowedSigners: readonly Hex[];
  attestationRef: Hex;
  verifiedAt: string;
  expiresAt: string;
  tlsBound: true;
  fetch: NearVerifiedFetch;
  /** Serialized hardware evidence, returned only in the private transcript. */
  attestationProof?: string;
  close?: () => void;
};

export type NearAttestationVerifier = (context: {
  baseUrl: string;
  model: string;
  signal: AbortSignal;
}) => Promise<NearVerifiedSession>;

export type NearInferenceEvidence = {
  schemaVersion: 1;
  provider: "near";
  signatureKind: "provider_tee";
  endpoint: string;
  model: string;
  completionId: string;
  requestHash: Hex;
  responseHash: Hex;
  outputHash: Hex;
  signatureText: string;
  signature: Hex;
  signingAddress: Hex;
  attestationRef: Hex;
  verifiedAt: string;
  expiresAt: string;
  tlsBound: true;
};

export type NearInferenceResult = {
  output: Buffer;
  evidence: NearInferenceEvidence;
  /** Sensitive bytes: callers must encrypt this transcript before persistence. */
  transcript: { requestBody: Buffer; responseBody: Buffer; attestationProof?: string };
};

export type NearInferenceAdapter = (plaintext: Buffer) => Promise<NearInferenceResult>;

export type NearInferenceOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  verifyAttestation: NearAttestationVerifier;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxOutputBytes?: number;
  maxTokens?: number;
  /** GLM/Qwen chat-template control. Defaults to false to reserve the token budget for an answer. */
  enableThinking?: boolean;
  maxSignatureAttempts?: number;
  signatureRetryDelayMs?: number;
};

const address = /^0x[0-9a-fA-F]{40}$/;
const hash = /^0x[0-9a-fA-F]{64}$/;
const halfCurveOrder = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const completionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/),
  model: z.string(),
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1),
});
const signatureSchema = z.object({
  text: z.string().max(1024),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  signing_address: z.string().regex(address),
  signing_algo: z.literal("ecdsa"),
  signature_kind: z.literal("provider_tee").optional(),
});

/** Only errors generated here are forwarded; hook/provider exceptions are redacted. */
class NearError extends AppError {
  constructor(message: string) { super("NEAR_VERIFICATION_FAILED", message, 502); }
}

function limit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid NEAR inference limit");
  return value;
}

function endpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid NEAR inference URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.port || !/^[a-z0-9-]+\.completions\.near\.ai$/.test(url.hostname)
    || !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new Error("NEAR inference requires a direct HTTPS completions endpoint");
  }
  url.pathname = "/v1/";
  return url;
}

function assertSession(session: NearVerifiedSession): void {
  const now = Date.now();
  const issued = Date.parse(session.verifiedAt);
  const expires = Date.parse(session.expiresAt);
  if (session.tlsBound !== true || typeof session.fetch !== "function" || !hash.test(session.attestationRef)
    || !Array.isArray(session.allowedSigners) || session.allowedSigners.length < 1 || session.allowedSigners.length > 64
    || session.allowedSigners.some((signer) => !address.test(signer) || /^0x0{40}$/i.test(signer))
    || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 30_000 || expires <= now || expires <= issued) {
    throw new NearError("NEAR attestation session is invalid or expired");
  }
  if (session.attestationProof !== undefined && (typeof session.attestationProof !== "string"
    || Buffer.byteLength(session.attestationProof) > 4_194_304)) throw new NearError("NEAR attestation proof is invalid");
}

async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readBody(response: Response, maximum: number, signal: AbortSignal): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await bounded(response.body?.cancel() ?? Promise.resolve(), signal);
    throw new NearError("NEAR response exceeds the byte limit");
  }
  if (!response.body) throw new NearError("NEAR response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await bounded(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) {
        await bounded(reader.cancel(), signal);
        throw new NearError("NEAR response exceeds the byte limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new NearError("NEAR returned invalid JSON"); }
}

function assertResponseOrigin(response: Response, origin: string): void {
  if (response.redirected || (response.url && new URL(response.url).origin !== origin)) {
    throw new NearError("NEAR response transport binding failed");
  }
}

async function recoverCanonicalSignature(text: string, sig: Hex): Promise<Hex> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new NearError("NEAR signature is not canonical");
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = Number.parseInt(sig.slice(130), 16);
  if (s === 0n || s > halfCurveOrder || ![0, 1, 27, 28].includes(v)) throw new NearError("NEAR signature is not canonical");
  return recoverMessageAddress({ message: text, signature: sig });
}

/**
 * Checks transcript hashes and the provider signature, not the hardware attestation.
 * The caller must independently verify attestationProof and bind its key/measurements
 * to evidence.signingAddress and attestationRef. Historical evidence may be expired.
 */
export async function verifyNearTranscript(
  evidence: NearInferenceEvidence,
  transcript: Pick<NearInferenceResult["transcript"], "requestBody" | "responseBody">,
): Promise<boolean> {
  try {
    if (evidence.schemaVersion !== 1 || evidence.provider !== "near" || evidence.signatureKind !== "provider_tee"
      || evidence.tlsBound !== true || !address.test(evidence.signingAddress) || !hash.test(evidence.attestationRef)
      || !Buffer.isBuffer(transcript.requestBody) || !Buffer.isBuffer(transcript.responseBody)
      || transcript.requestBody.length > 16_777_216 || transcript.responseBody.length > 33_554_432
      || !Number.isFinite(Date.parse(evidence.verifiedAt)) || !Number.isFinite(Date.parse(evidence.expiresAt))) return false;
    endpoint(evidence.endpoint);
    const requestHash = sha256Hex(transcript.requestBody);
    const responseHash = sha256Hex(transcript.responseBody);
    if (requestHash !== evidence.requestHash || responseHash !== evidence.responseHash) return false;
    const request = z.object({ model: z.string(), messages: z.array(z.object({ role: z.literal("user"), content: z.string() })).length(1), stream: z.literal(false) })
      .safeParse(parseJson(transcript.requestBody));
    const response = completionSchema.safeParse(parseJson(transcript.responseBody));
    if (!request.success || !response.success || request.data.model !== evidence.model || response.data.model !== evidence.model
      || response.data.id !== evidence.completionId || sha256Hex(Buffer.from(response.data.choices[0]!.message.content, "utf8")) !== evidence.outputHash) return false;
    const signatureText = `${evidence.model}:${requestHash.slice(2)}:${responseHash.slice(2)}`;
    if (evidence.signatureText !== signatureText) return false;
    return (await recoverCanonicalSignature(signatureText, evidence.signature)).toLowerCase() === evidence.signingAddress.toLowerCase();
  } catch { return false; }
}

/** Verifies NEAR provider execution; this does not turn the calling process into a hardware TEE. */
export function createNearInference(options: NearInferenceOptions): NearInferenceAdapter {
  const base = endpoint(options.baseUrl);
  const model = options.model.trim();
  const apiKey = options.apiKey.trim();
  if (!model || model.length > 512 || /[\r\n:]/.test(model)) throw new Error("Invalid NEAR inference model");
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error("Invalid NEAR inference API key");
  if (typeof options.verifyAttestation !== "function") throw new Error("NEAR attestation verifier is required");
  const timeoutMs = limit(options.timeoutMs ?? 30_000, 300_000);
  const maxRequestBytes = limit(options.maxRequestBytes ?? 1_048_576, 16_777_216);
  const maxResponseBytes = limit(options.maxResponseBytes ?? 8_388_608, 33_554_432);
  const maxOutputBytes = limit(options.maxOutputBytes ?? 1_048_576, 16_777_216);
  const maxTokens = limit(options.maxTokens ?? 1024, 131_072);
  const enableThinking = options.enableThinking ?? false;
  if (typeof enableThinking !== "boolean") throw new Error("Invalid NEAR inference thinking option");
  const attempts = limit(options.maxSignatureAttempts ?? 5, 10);
  const retryDelayMs = limit(options.signatureRetryDelayMs ?? 250, 5_000);
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json", "accept-encoding": "identity" };

  return async (plaintext) => {
    if (plaintext.length > maxRequestBytes) throw new ValidationError({ prompt: "NEAR request exceeds the byte limit" });
    let prompt: string;
    try { prompt = new TextDecoder("utf-8", { fatal: true }).decode(plaintext); }
    catch { throw new ValidationError({ prompt: "Expected UTF-8 text" }); }
    // SGLang accepts the standard user field. A random, non-identifying value
    // makes every signed request unique even when prompt/options are identical.
    const requestBody = Buffer.from(JSON.stringify({ model, user: `enclave-${randomUUID()}`, messages: [{ role: "user", content: prompt }], stream: false,
      temperature: 0, max_tokens: maxTokens, chat_template_kwargs: { enable_thinking: enableThinking } }), "utf8");
    if (requestBody.length > maxRequestBytes) throw new ValidationError({ prompt: "NEAR request exceeds the byte limit" });
    const requestHash = sha256Hex(requestBody);
    const signal = AbortSignal.timeout(timeoutMs);
    let session: NearVerifiedSession | undefined;
    try {
      session = await bounded(options.verifyAttestation({ baseUrl: base.href.replace(/\/$/, ""), model, signal }), signal);
      assertSession(session);
      signal.throwIfAborted();
      // No global fetch fallback: only the transport pinned by the verifier may see the prompt.
      const response = await bounded(session.fetch(new URL("chat/completions", base), {
        method: "POST", headers, body: requestBody.toString("utf8"), redirect: "error", signal,
      }), signal);
      assertResponseOrigin(response, base.origin);
      if (response.status !== 200) {
        await bounded(response.body?.cancel() ?? Promise.resolve(), signal);
        throw new NearError(`NEAR inference returned HTTP ${response.status}`);
      }
      const responseBody = await readBody(response, maxResponseBytes, signal);
      const parsed = completionSchema.safeParse(parseJson(responseBody));
      if (!parsed.success || parsed.data.model !== model) throw new NearError("NEAR returned an invalid completion or model");
      const output = Buffer.from(parsed.data.choices[0]!.message.content, "utf8");
      if (output.length > maxOutputBytes) throw new NearError("NEAR output exceeds the byte limit");
      const responseHash = sha256Hex(responseBody);
      const signatureText = `${model}:${requestHash.slice(2)}:${responseHash.slice(2)}`;
      const signatureUrl = new URL(`signature/${parsed.data.id}?signing_algo=ecdsa`, base);
      for (let attempt = 0; attempt < attempts; attempt++) {
        assertSession(session);
        const proofResponse = await bounded(session.fetch(signatureUrl, { method: "GET", headers, redirect: "error", signal }), signal);
        assertResponseOrigin(proofResponse, base.origin);
        if ([404, 503, 504].includes(proofResponse.status)) {
          await bounded(proofResponse.body?.cancel() ?? Promise.resolve(), signal);
          if (attempt + 1 < attempts) { await delay(retryDelayMs, undefined, { signal }); continue; }
          throw new NearError("NEAR signature was not available within the retry limit");
        }
        if (proofResponse.status !== 200) {
          await bounded(proofResponse.body?.cancel() ?? Promise.resolve(), signal);
          throw new NearError(`NEAR signature returned HTTP ${proofResponse.status}`);
        }
        const proof = signatureSchema.safeParse(parseJson(await readBody(proofResponse, 16_384, signal)));
        if (!proof.success || proof.data.text !== signatureText) throw new NearError("NEAR signature payload does not bind this inference");
        const sig = proof.data.signature as Hex;
        const recovered = await bounded(recoverCanonicalSignature(signatureText, sig), signal);
        if (recovered.toLowerCase() !== proof.data.signing_address.toLowerCase()
          || !session.allowedSigners.some((signer) => signer.toLowerCase() === recovered.toLowerCase())) {
          throw new NearError("NEAR signature signer is not attested");
        }
        assertSession(session);
        signal.throwIfAborted();
        return {
          output,
          evidence: { schemaVersion: 1, provider: "near", signatureKind: "provider_tee", endpoint: base.origin,
            model, completionId: parsed.data.id, requestHash, responseHash, outputHash: sha256Hex(output), signatureText,
            signature: sig, signingAddress: recovered, attestationRef: session.attestationRef,
            verifiedAt: session.verifiedAt, expiresAt: session.expiresAt, tlsBound: true },
          transcript: { requestBody, responseBody, ...(session.attestationProof === undefined ? {} : { attestationProof: session.attestationProof }) },
        };
      }
      throw new NearError("NEAR signature was not available within the retry limit");
    } catch (error) {
      if (signal.aborted) throw new AppError("NEAR_INFERENCE_TIMEOUT", "NEAR verified inference timed out", 504);
      if (error instanceof NearError) throw error;
      throw new NearError("NEAR attestation or verified inference failed");
    } finally {
      try { session?.close?.(); } catch { /* Cleanup must not expose transport internals. */ }
    }
  };
}
