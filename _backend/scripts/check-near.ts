/** Explicit, billable smoke test: one short synthetic prompt, no automatic POST retry. */
import { config as dotenv } from "dotenv";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createNearInference, createVendorRoots, DevCvm, encryptAesGcm, decryptAesGcm, sha256Hex, verifyProviderProof, verifyNearTranscript } from "@enclave/core";
import { createNearAttestationVerifier } from "../apps/api/src/near-provider.js";
import { loadConfig } from "../apps/api/src/config.js";

dotenv({ path: [".env.near", ".env"], quiet: true });
const start = Date.now();
try {
  const config = loadConfig();
  if (config.INFERENCE_BACKEND !== "near-verified" || config.TEE_MODE !== "dev") throw new Error("profile");
  await mkdir("work", { recursive: true });
  const inference = createNearInference({ baseUrl: config.INFERENCE_BASE_URL, model: config.INFERENCE_MODEL,
    apiKey: config.INFERENCE_API_KEY!, timeoutMs: config.INFERENCE_TIMEOUT_MS, maxTokens: 32,
    verifyAttestation: createNearAttestationVerifier({ pythonPath: config.NEAR_VERIFIER_PYTHON!, policyPath: config.NEAR_ATTESTATION_POLICY! }),
  });
  const vendor = await createVendorRoots();
  const policy = { version: config.TCB_POLICY_VERSION, servingImageId: config.SERVING_IMAGE_ID, requireCpuTee: true as const, requireGpuCc: true as const };
  const cvm = await DevCvm.create({ policy, modelId: config.INFERENCE_MODEL, chainId: config.ARC_CHAIN_ID,
    verifyingContract: config.ATTESTATION_VERIFIER_ADDRESS as `0x${string}`, verifiedInference: inference }, vendor);
  const quote = await cvm.quote();
  await cvm.releaseKeys(quote, vendor.address);
  const sessionKey = randomBytes(32);
  const encryptedPrompt = encryptAesGcm(sessionKey, Buffer.from("Reply with the single word READY."));
  const result = await cvm.infer(decryptAesGcm(sessionKey, encryptedPrompt), { attRef: sha256Hex(quote.signature) });
  if (!result.providerProof || !result.providerTranscript) throw new Error("missing provider proof");
  if (!await verifyProviderProof(result.providerProof, result.receipt, cvm.enclaveAddress, config.ARC_CHAIN_ID, config.ATTESTATION_VERIFIER_ADDRESS as `0x${string}`)
    || !await verifyNearTranscript(result.providerProof.evidence, result.providerTranscript)) throw new Error("proof");
  const encryptedOutput = encryptAesGcm(sessionKey, result.output);
  if (sha256Hex(decryptAesGcm(sessionKey, encryptedOutput)) !== result.receipt.outHash) throw new Error("ciphertext");
  const attestation = JSON.parse(result.providerTranscript.attestationProof!);
  const metadata = { ok: true, checkedAt: new Date().toISOString(), model: config.INFERENCE_MODEL,
    endpoint: config.INFERENCE_BASE_URL, requests: 1, maxTokens: 32, outputBytes: result.output.length,
    elapsedMs: Date.now() - start, cpuStatus: attestation.verdict.cpuStatus, gpuCount: attestation.verdict.gpuCount,
    policyVersion: attestation.verdict.policyVersion, tlsBound: true, providerSignatureVerified: true,
    receiptBindingVerified: true, encryptedRoundTripVerified: true, receiptVersion: result.receipt.receiptVersion,
    localGatewayTeeMode: "dev", attestationRef: result.providerProof.evidence.attestationRef };
  await writeFile("work/near-live-smoke.json", `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(JSON.stringify(metadata));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : "CHECK_FAILED";
  console.error(JSON.stringify({ ok: false, code, elapsedMs: Date.now() - start, automaticRetry: false }));
  process.exitCode = 1;
}
