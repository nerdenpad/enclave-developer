import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AttestationFailedError, KeyNotReleasedError } from "./errors.js";
import {
  type AttestationQuote,
  type TcbPolicy,
  type VendorRoots,
  issueQuote,
  verifyQuote,
  measurementOf,
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
  /** Activated software policies bind new session keys to their measurement. Legacy bootstrap retains old keys. */
  sessionKeyBinding?: "policy";
};

/** Passed only by the trusted gateway after loading the caller's attested session. */
export type InferenceContext = {
  attRef: `0x${string}`;
  nonce?: `0x${string}`;
  receiptTimestamp?: bigint;
};

export class DevCvm {
  readonly enclaveAddress: `0x${string}`;
  readonly modelHash: `0x${string}`;
  readonly codeHash: `0x${string}`;

  #vendor: VendorRoots;
  #wrappingKey: Buffer;
  #encryptedWeights: AesGcmBlob;
  #enclavePrivateKey: `0x${string}`;
  #modelKey: Buffer | null = null;
  #verifiedAttRefs = new Set<string>();

  private constructor(
    vendor: VendorRoots,
    wrappingKey: Buffer,
    encryptedWeights: AesGcmBlob,
    enclavePrivateKey: `0x${string}`,
    public readonly config: CvmConfig,
  ) {
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
    await verifyQuote(quote, this.config.policy, this.#vendor.address, now);
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
    let verified: NearInferenceResult | undefined;
    if (this.config.verifiedInference) {
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
      const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(verified.transcript.requestBody)) as { messages: [{ content: string }] };
      if (request.messages[0].content !== prompt) throw new Error("Verified inference evidence does not match the input");
    }
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
