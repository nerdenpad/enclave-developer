import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { AttestationFailedError, KeyNotReleasedError } from "./errors.js";
import {
  type AttestationQuote,
  type TcbPolicy,
  type VendorRoots,
  issueQuote,
  verifyQuote,
  measurementOf,
  quotePayload,
} from "./attestation.js";
import { decryptAesGcm, encryptAesGcm, type AesGcmBlob } from "./crypto.js";
import { isHex32, randomBytes32, sha256, sha256Hex, toHex } from "./hash.js";
import { signReceipt, type InferenceReceiptV2 } from "./receipt.js";
import type { InferenceAdapter } from "./inference.js";
import { verifyNearTranscript, type NearInferenceAdapter, type NearInferenceResult } from "./near-inference.js";
import { canonicalEvidenceJson, signProviderProof, type ProviderProof, type ProviderTranscript } from "./provider-proof.js";
import { canonicalTcbPolicy, parseTcbPolicy } from "./tcb.js";

export type CvmConfig = {
  policy: TcbPolicy;
  modelId: string;
  chainId: number;
  verifyingContract: `0x${string}`;
  inference?: InferenceAdapter;
  verifiedInference?: NearInferenceAdapter;
  /** Managed NEAR uses software gateway admission and independently verified remote execution. */
  gatewayMode?: "development" | "managed-near";
  /** Activated software policies bind new session keys to their measurement. Legacy bootstrap retains old keys. */
  sessionKeyBinding?: "policy";
};

const gatewayProviderMarker = "near-provider:verify-before-inference";
const halfCurveOrder = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** Reuses the protocol envelope; these fields describe software admission, never local hardware. */
function gatewaySessionDescriptor(policy: TcbPolicy, now: number): Omit<AttestationQuote, "signature"> {
  return {
    cpuQuote: `gateway-session:${policy.servingImageId}`,
    gpuQuote: gatewayProviderMarker,
    measurement: measurementOf(policy),
    tcbVersion: policy.version,
    timestamp: now,
  };
}

async function verifyGatewaySession(
  quote: AttestationQuote,
  policy: TcbPolicy,
  issuer: `0x${string}`,
  now: number,
): Promise<void> {
  const expected = gatewaySessionDescriptor(policy, now);
  if (!quote || quote.cpuQuote !== expected.cpuQuote || quote.gpuQuote !== expected.gpuQuote
    || !isHex32(quote.measurement) || quote.measurement !== expected.measurement || quote.tcbVersion !== expected.tcbVersion) {
    throw new AttestationFailedError("Gateway session descriptor does not match the software admission policy");
  }
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(quote.timestamp) || quote.timestamp < 0) {
    throw new AttestationFailedError("Invalid gateway session timestamp or verifier clock");
  }
  if (Math.abs(now - quote.timestamp) > 5 * 60_000) throw new AttestationFailedError("Gateway session descriptor expired");
  let recovered: `0x${string}`;
  try {
    if (!/^0x[0-9a-fA-F]{130}$/.test(quote.signature)) throw new Error("Invalid signature encoding");
    const s = BigInt(`0x${quote.signature.slice(66, 130)}`);
    const v = Number.parseInt(quote.signature.slice(130), 16);
    if (s === 0n || s > halfCurveOrder || ![27, 28].includes(v)) throw new Error("Noncanonical signature");
    recovered = await recoverMessageAddress({ message: quotePayload({
      cpuQuote: quote.cpuQuote, gpuQuote: quote.gpuQuote, measurement: quote.measurement,
      tcbVersion: quote.tcbVersion, timestamp: quote.timestamp,
    }), signature: quote.signature });
  } catch {
    throw new AttestationFailedError("Invalid gateway session signature");
  }
  if (recovered.toLowerCase() !== issuer.toLowerCase()) throw new AttestationFailedError("Gateway session signature does not match its issuer");
}

/** Passed only by the trusted gateway after loading the caller's attested session. */
export type InferenceContext = {
  attRef: `0x${string}`;
  nonce?: `0x${string}`;
  receiptTimestamp?: bigint;
};

export class DevCvm {
  readonly enclaveAddress: `0x${string}`;
  /** A model identifier commitment, not a hash of remotely hosted model weights. */
  readonly modelHash: `0x${string}`;
  /** A software policy identifier commitment, not a measured physical image hash. */
  readonly codeHash: `0x${string}`;
  readonly config: CvmConfig;

  #vendor: VendorRoots;
  #wrappingKey: Buffer;
  #encryptedWeights: AesGcmBlob;
  #enclavePrivateKey: `0x${string}`;
  #modelKey: Buffer | null = null;
  #verifiedAttRefs = new Set<string>();
  readonly #gatewayMode: "development" | "managed-near";

  private constructor(
    vendor: VendorRoots,
    wrappingKey: Buffer,
    encryptedWeights: AesGcmBlob,
    enclavePrivateKey: `0x${string}`,
    config: CvmConfig,
  ) {
    this.#gatewayMode = config.gatewayMode ?? "development";
    this.config = this.#gatewayMode === "managed-near"
      ? Object.freeze({ ...config, policy: Object.freeze(parseTcbPolicy(canonicalTcbPolicy(config.policy))) })
      : config;
    this.#vendor = vendor;
    this.#wrappingKey = wrappingKey;
    this.#encryptedWeights = encryptedWeights;
    this.#enclavePrivateKey = enclavePrivateKey;
    this.enclaveAddress = privateKeyToAccount(enclavePrivateKey).address;
    this.modelHash = sha256Hex(`model:${config.modelId}`);
    this.codeHash = measurementOf(config.policy);
  }

  static async create(
    config: CvmConfig,
    vendor: VendorRoots,
    persisted?: { enclavePrivateKey: `0x${string}`; wrappingKey: Buffer; modelKey: Buffer },
  ): Promise<DevCvm> {
    if (config.inference && config.verifiedInference) throw new Error("Only one inference adapter may be configured");
    if (config.gatewayMode !== undefined && !["development", "managed-near"].includes(config.gatewayMode)) throw new Error("Invalid gateway mode");
    if (config.gatewayMode === "managed-near" && (typeof config.verifiedInference !== "function" || config.inference !== undefined)) {
      throw new Error("Managed NEAR requires a verified inference adapter and forbids ordinary inference");
    }
    const wrappingKey = persisted?.wrappingKey ?? randomBytes32();
    const modelKey = persisted?.modelKey ?? randomBytes32();
    const encryptedWeights = encryptAesGcm(wrappingKey, modelKey);
    const enclavePrivateKey = persisted?.enclavePrivateKey ?? generatePrivateKey();
    return new DevCvm(vendor, wrappingKey, encryptedWeights, enclavePrivateKey, config);
  }

  get vendorAddress(): `0x${string}` {
    return this.#vendor.address;
  }

  async quote(now = Date.now()): Promise<AttestationQuote> {
    if (this.#gatewayMode === "managed-near") {
      if (!this.#vendor.privateKey) throw new AttestationFailedError("Gateway session issuer requires a private key");
      if (!Number.isSafeInteger(now) || now < 0) throw new AttestationFailedError("Invalid gateway session timestamp");
      const descriptor = gatewaySessionDescriptor(this.config.policy, now);
      const signature = await privateKeyToAccount(this.#vendor.privateKey).signMessage({ message: quotePayload(descriptor) });
      return { ...descriptor, signature };
    }
    return issueQuote(this.#vendor, this.config.policy, now);
  }

  keysReleased(): boolean {
    return this.#modelKey !== null;
  }

  async releaseKeys(quote: AttestationQuote, vendorAddress: `0x${string}`, now = Date.now()): Promise<void> {
    if (!this.#vendor.address) {
      throw new AttestationFailedError("Missing vendor root");
    }
    if (vendorAddress.toLowerCase() !== this.#vendor.address.toLowerCase()) {
      throw new AttestationFailedError("Vendor root does not match CVM configuration");
    }
    if (this.#gatewayMode === "managed-near") {
      await verifyGatewaySession(quote, this.config.policy, this.#vendor.address, now);
    } else {
      await verifyQuote(quote, this.config.policy, this.#vendor.address, now);
    }
    this.#modelKey = decryptAesGcm(this.#wrappingKey, this.#encryptedWeights);
    this.#verifiedAttRefs.add(sha256Hex(quote.signature));
  }

  /** New software admission boundary; remote inference/verifier configuration is retained unchanged. */
  withPolicy(policy: TcbPolicy): DevCvm {
    const next = parseTcbPolicy(canonicalTcbPolicy(policy));
    return new DevCvm(this.#vendor, Buffer.from(this.#wrappingKey), { ...this.#encryptedWeights },
      this.#enclavePrivateKey, { ...this.config, policy: next, sessionKeyBinding: "policy" });
  }

  async infer(
    plaintext: Buffer,
    context: InferenceContext,
    now = Date.now(),
  ): Promise<{ output: Buffer; receipt: InferenceReceiptV2 & { sig: `0x${string}` }; providerProof?: ProviderProof; providerTranscript?: ProviderTranscript }> {
    if (!this.#modelKey) {
      throw new KeyNotReleasedError();
    }
    const { attRef } = context;
    if (!isHex32(attRef) || !this.#verifiedAttRefs.has(attRef.toLowerCase())) {
      throw new AttestationFailedError("Session attestation was not verified by this CVM");
    }
    const nonce = context.nonce ?? toHex(randomBytes32());
    if (!isHex32(nonce)) throw new Error("Receipt nonce must be bytes32");
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid receipt timestamp");
    const ts = context.receiptTimestamp ?? BigInt(Math.floor(now / 1000));
    if (typeof ts !== "bigint" || ts < 0n || ts > (1n << 64n) - 1n) throw new Error("Invalid receipt timestamp");
    const input = Buffer.from(plaintext);
    const inHash = sha256Hex(input);
    const inferenceStarted = performance.now();
    let verified: NearInferenceResult | undefined;
    if (this.#gatewayMode === "managed-near" && (typeof this.config.verifiedInference !== "function" || this.config.inference !== undefined)) {
      throw new Error("Managed NEAR requires a verified inference adapter and forbids ordinary inference");
    }
    if (this.config.verifiedInference) {
      // The trusted adapter verifies provider CPU/GPU attestation and pins its transport.
      // Transcript verification below checks the signed I/O binding; it is not hardware verification.
      const prompt = new TextDecoder("utf-8", { fatal: true }).decode(input);
      const candidate = await this.config.verifiedInference(input);
      if (!candidate || !Buffer.isBuffer(candidate.output) || !Buffer.isBuffer(candidate.transcript?.requestBody)
        || !Buffer.isBuffer(candidate.transcript?.responseBody) || !candidate.evidence
        || (candidate.transcript.attestationProof !== undefined && (typeof candidate.transcript.attestationProof !== "string"
          || Buffer.byteLength(candidate.transcript.attestationProof) > 4_194_304))) {
        throw new Error("Verified inference adapter returned an invalid result");
      }
      verified = {
        output: Buffer.from(candidate.output),
        evidence: JSON.parse(canonicalEvidenceJson(candidate.evidence)) as NearInferenceResult["evidence"],
        transcript: { requestBody: Buffer.from(candidate.transcript.requestBody), responseBody: Buffer.from(candidate.transcript.responseBody),
          ...(candidate.transcript.attestationProof === undefined ? {} : { attestationProof: candidate.transcript.attestationProof }) },
      };
      if (verified.evidence.model !== this.config.modelId || verified.evidence.outputHash !== sha256Hex(verified.output)
        || !await verifyNearTranscript(verified.evidence, verified.transcript)) throw new Error("Verified inference evidence does not match the result");
      if (this.#gatewayMode === "managed-near") {
        const issued = Date.parse(verified.evidence.verifiedAt);
        const expires = Date.parse(verified.evidence.expiresAt);
        // Check freshness on completion, including time spent obtaining provider attestation.
        const completed = now + Math.max(0, Math.floor(performance.now() - inferenceStarted));
        if (!Number.isSafeInteger(completed) || issued > completed + 30_000 || expires <= completed || expires <= issued) {
          throw new Error("Verified inference evidence is not fresh");
        }
      }
      const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(verified.transcript.requestBody)) as { messages: [{ content: string }] };
      if (request.messages[0].content !== prompt) throw new Error("Verified inference evidence does not match the input");
    }
    if (this.#gatewayMode === "managed-near" && !verified) throw new Error("Managed NEAR requires verified provider evidence");
    const backendOutput = verified ? verified.output : this.config.inference
      ? await this.config.inference(input)
      : sha256(Buffer.concat([this.#modelKey, input]));
    if (!Buffer.isBuffer(backendOutput)) throw new Error("Inference adapter must return bytes");
    const output = Buffer.from(backendOutput);
    const outHash = sha256Hex(output);
    const receipt = await signReceipt(
      {
        receiptVersion: 2,
        modelHash: this.modelHash,
        codeHash: this.codeHash,
        inHash,
        outHash,
        attRef,
        nonce,
        ts,
      },
      this.#enclavePrivateKey,
      this.config.chainId,
      this.config.verifyingContract,
    );
    if (verified) {
      const providerProof = await signProviderProof(receipt, verified.evidence, this.#enclavePrivateKey,
        this.config.chainId, this.config.verifyingContract);
      return { output, receipt, providerProof, providerTranscript: verified.transcript };
    }
    return { output, receipt };
  }

  sessionSecret(sessionId: string): Buffer {
    if (!this.#modelKey) {
      throw new KeyNotReleasedError();
    }
    return sha256(Buffer.concat([this.#modelKey, Buffer.from(sessionId, "utf8"),
      ...(this.config.sessionKeyBinding === "policy" ? [Buffer.from(this.codeHash, "utf8")] : [])]));
  }

  sealMemory(plain: Buffer): AesGcmBlob {
    return encryptAesGcm(this.memorySealKey(), plain);
  }

  openMemory(blob: AesGcmBlob): Buffer {
    if (!this.#modelKey) {
      throw new KeyNotReleasedError();
    }
    return decryptAesGcm(this.memorySealKey(), blob);
  }

  private memorySealKey(): Buffer {
    return sha256(Buffer.concat([this.#wrappingKey, Buffer.from("enclave-agent-memory-v1")]));
  }

  debugFingerprint(): { wrappingKeyFp: `0x${string}`; signer: `0x${string}` } {
    return { wrappingKeyFp: toHex(sha256(this.#wrappingKey)), signer: this.enclaveAddress };
  }

  toJSON(): {
    enclaveAddress: `0x${string}`;
    modelHash: `0x${string}`;
    codeHash: `0x${string}`;
    keysReleased: boolean;
  } {
    return {
      enclaveAddress: this.enclaveAddress,
      modelHash: this.modelHash,
      codeHash: this.codeHash,
      keysReleased: this.keysReleased(),
    };
  }
}
