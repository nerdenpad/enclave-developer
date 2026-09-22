import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { TamperedImageError, AttestationFailedError } from "./errors.js";
import { sha256Hex } from "./hash.js";

export const VENDOR_MESSAGE_PREFIX = "enclave-attestation-v1:";

export type TcbPolicy = {
  version: number;
  servingImageId: string;
  requireCpuTee: true;
  requireGpuCc: true;
};

export type AttestationQuote = {
  cpuQuote: string;
  gpuQuote: string;
  measurement: `0x${string}`;
  tcbVersion: number;
  timestamp: number;
  signature: `0x${string}`;
};

export type VendorRoots = {
  address: `0x${string}`;
  privateKey?: `0x${string}`;
};

export function measurementOf(policy: TcbPolicy): `0x${string}` {
  return sha256Hex(`${policy.servingImageId}|${policy.version}|cpu+gpu`);
}

export function quotePayload(q: Omit<AttestationQuote, "signature">): string {
  return [
    VENDOR_MESSAGE_PREFIX,
    q.cpuQuote,
    q.gpuQuote,
    q.measurement,
    String(q.tcbVersion),
    String(q.timestamp),
  ].join("|");
}

export async function createVendorRoots(): Promise<VendorRoots> {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { address: account.address, privateKey };
}

export async function issueQuote(
  roots: VendorRoots,
  policy: TcbPolicy,
  now = Date.now(),
): Promise<AttestationQuote> {
  if (!roots.privateKey) {
    throw new AttestationFailedError("Vendor root cannot issue quotes without a private key");
  }
  const unsigned: Omit<AttestationQuote, "signature"> = {
    cpuQuote: `tdx:${policy.servingImageId}`,
    gpuQuote: `nvidia-cc:${policy.servingImageId}`,
    measurement: measurementOf(policy),
    tcbVersion: policy.version,
    timestamp: now,
  };
  const account = privateKeyToAccount(roots.privateKey);
  const signature = await account.signMessage({ message: quotePayload(unsigned) });
  return { ...unsigned, signature };
}

export async function verifyQuote(
  quote: AttestationQuote,
  policy: TcbPolicy,
  vendorAddress: `0x${string}`,
  now = Date.now(),
): Promise<void> {
  if (!policy.requireCpuTee || !policy.requireGpuCc) {
    throw new AttestationFailedError("TEE without CPU+GPU composite is rejected");
  }
  if (!quote.cpuQuote || !quote.gpuQuote) {
    throw new AttestationFailedError("Composite CPU+GPU quote required");
  }
  const expected = measurementOf(policy);
  if (quote.measurement.toLowerCase() !== expected.toLowerCase()) {
    throw new TamperedImageError();
  }
  if (quote.tcbVersion !== policy.version) {
    throw new AttestationFailedError("TCB policy version mismatch");
  }
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(quote.timestamp) || quote.timestamp < 0) {
    throw new AttestationFailedError("Invalid quote timestamp or verifier clock");
  }
  if (Math.abs(now - quote.timestamp) > 5 * 60_000) {
    throw new AttestationFailedError("Quote expired");
  }
  let recovered: `0x${string}`;
  try {
    recovered = await recoverMessageAddress({
      message: quotePayload({
        cpuQuote: quote.cpuQuote,
        gpuQuote: quote.gpuQuote,
        measurement: quote.measurement,
        tcbVersion: quote.tcbVersion,
        timestamp: quote.timestamp,
      }),
      signature: quote.signature,
    });
  } catch {
    throw new AttestationFailedError("Invalid quote signature");
  }
  if (recovered.toLowerCase() !== vendorAddress.toLowerCase()) {
    throw new AttestationFailedError("Quote signature does not match vendor root");
  }
}

export function isGpuCcWithoutCpuTee(quote: Pick<AttestationQuote, "cpuQuote" | "gpuQuote">): boolean {
  return Boolean(quote.gpuQuote) && !quote.cpuQuote;
}
