import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sha256Hex } from "./hash.js";
import { receiptTypedHash, verifyReceiptSignature, type SignedReceipt } from "./receipt.js";
import type { NearInferenceEvidence } from "./near-inference.js";

/** This binding is signed by the Enclave receipt signer, whose trust mode is unchanged. */
export type ProviderProof = {
  version: 1;
  receiptHash: `0x${string}`;
  evidenceHash: `0x${string}`;
  evidence: NearInferenceEvidence;
  sig: `0x${string}`;
};
export type ProviderTranscript = { requestBody: Buffer; responseBody: Buffer; attestationProof?: string };

export function canonicalEvidenceJson(value: unknown): string {
  const ancestors = new WeakSet<object>();
  const invalid = () => new Error("Evidence must contain finite, acyclic JSON values only");
  const ownValue = (item: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(item, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    return descriptor.value as unknown;
  };
  const visit = (item: unknown, depth: number): string => {
    if (depth > 128) throw invalid();
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || ancestors.has(item) || Object.getOwnPropertySymbols(item).length) throw invalid();
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length) throw invalid();
        const children: string[] = [];
        for (let index = 0; index < item.length; index++) {
          if (!Object.hasOwn(item, index)) throw invalid();
          children.push(visit(ownValue(item, String(index)), depth + 1));
        }
        return `[${children.join(",")}]`;
      }
      if (Object.getPrototypeOf(item) !== Object.prototype) throw invalid();
      if (Object.getOwnPropertyNames(item).length !== Object.keys(item).length) throw invalid();
      return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${visit(ownValue(item, key), depth + 1)}`).join(",")}}`;
    } finally { ancestors.delete(item); }
  };
  return visit(value, 0);
}

const proofTypes = { InferenceEvidence: [
  { name: "receiptHash", type: "bytes32" }, { name: "evidenceHash", type: "bytes32" },
] } as const;
const proofDomain = (chainId: number, verifyingContract: `0x${string}`) => ({
  name: "ENCLAVE_PROVIDER_EVIDENCE", version: "1", chainId, verifyingContract,
});

export function providerEvidenceHash(evidence: NearInferenceEvidence): `0x${string}` {
  return sha256Hex(canonicalEvidenceJson(evidence));
}

export async function signProviderProof(receipt: SignedReceipt, evidence: NearInferenceEvidence,
  privateKey: `0x${string}`, chainId: number, verifyingContract: `0x${string}`): Promise<ProviderProof> {
  const receiptHash = receiptTypedHash(receipt, chainId, verifyingContract);
  // Snapshot the evidence so later adapter mutations cannot change the returned signed proof.
  const evidenceJson = canonicalEvidenceJson(evidence);
  const evidenceHash = sha256Hex(evidenceJson);
  const signedEvidence = JSON.parse(evidenceJson) as NearInferenceEvidence;
  if (signedEvidence.outputHash !== receipt.outHash) throw new Error("Provider evidence output does not match receipt");
  const sig = await privateKeyToAccount(privateKey).signTypedData({
    domain: proofDomain(chainId, verifyingContract), types: proofTypes, primaryType: "InferenceEvidence",
    message: { receiptHash, evidenceHash },
  });
  return { version: 1, receiptHash, evidenceHash, evidence: signedEvidence, sig };
}

/** Verifies the receipt/evidence association. Hardware evidence must also be independently verified. */
export async function verifyProviderProof(proof: ProviderProof, receipt: SignedReceipt, expectedSigner: `0x${string}`,
  chainId: number, verifyingContract: `0x${string}`): Promise<boolean> {
  try {
    if (proof.version !== 1 || proof.receiptHash !== receiptTypedHash(receipt, chainId, verifyingContract)
      || proof.evidenceHash !== providerEvidenceHash(proof.evidence) || proof.evidence.outputHash !== receipt.outHash
      || !await verifyReceiptSignature(receipt, expectedSigner, chainId, verifyingContract)) return false;
    const signer = await recoverTypedDataAddress({ domain: proofDomain(chainId, verifyingContract),
      types: proofTypes, primaryType: "InferenceEvidence", message: proof, signature: proof.sig });
    return signer.toLowerCase() === expectedSigner.toLowerCase();
  } catch { return false; }
}
