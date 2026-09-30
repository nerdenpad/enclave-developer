/** Offline release preparation. Never loads .env, calls a provider/RPC, signs, or sends. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProductionReleaseError, validateProductionRelease } from "../packages/core/src/release-manifest.js";

export const productionReleaseUsage = "Usage: tsx scripts/check-production-release.ts --manifest PATH. Offline only; does not establish hardware, Arc or payment acceptance.";
export function productionReleaseOptions(args: string[]): { help: true } | { manifestPath: string } {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  if (args.length !== 2 || args[0] !== "--manifest" || !args[1]?.trim() || args[1].startsWith("--")) throw new Error(productionReleaseUsage);
  return { manifestPath: args[1] };
}
export async function checkProductionRelease(manifestPath: string) {
  const validated = await validateProductionRelease(manifestPath);
  const { manifest } = validated;
  return { ok: true, status: "offline-preflight-valid", chainId: manifest.chainId, origin: manifest.origin,
    modelId: manifest.modelId, servingImageId: manifest.servingImageId, tcbVersion: manifest.tcbVersion,
    modelHash: manifest.modelHash, codeHash: manifest.codeHash, policyHash: manifest.policyHash,
    providerPolicyHash: validated.providerPolicyHash, providerPolicyVersion: validated.providerPolicy.version,
    providerAttestationFormat: validated.providerAttestationFormat, providerOrigin: validated.providerProof.evidence.endpoint,
    signer: manifest.signer, contracts: manifest.contracts, receiptTypedHash: validated.typedHash,
    acceptedAt: manifest.acceptance.acceptedAt, validUntil: manifest.acceptance.validUntil,
    localReceiptSignatureVerified: true, providerProofBindingVerified: true, providerTranscriptSignatureVerified: true,
    ioHashesVerified: true, hardwareAttestationVerified: false, registryApprovalVerified: false,
    anchorVerified: false, paymentVerified: false, requestsSent: 0, transactionsSent: 0 };
}
async function main() {
  const options = productionReleaseOptions(process.argv.slice(2));
  if ("help" in options) { console.log(productionReleaseUsage); return; }
  console.log(JSON.stringify(await checkProductionRelease(options.manifestPath), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false, code: error instanceof ProductionReleaseError ? error.code : "PRODUCTION_PREFLIGHT_FAILED", requestsSent: 0, transactionsSent: 0 }));
    process.exitCode = 1;
  });
}
