import { measurementOf, type TcbPolicy } from "./attestation.js";
import { sha256Hex } from "./hash.js";

/** Commits the complete development software policy, not a remote hardware allowlist. */
export function canonicalTcbPolicy(policy: TcbPolicy): string {
  if (!policy || !Number.isSafeInteger(policy.version) || policy.version < 1
    || typeof policy.servingImageId !== "string" || !policy.servingImageId.trim() || policy.servingImageId.length > 80
    || /[\u0000-\u001f\u007f]/.test(policy.servingImageId) || policy.requireCpuTee !== true || policy.requireGpuCc !== true) {
    throw new Error("Invalid development TCB policy");
  }
  return JSON.stringify({ version: policy.version, servingImageId: policy.servingImageId, requireCpuTee: true, requireGpuCc: true });
}

export function parseTcbPolicy(json: string): TcbPolicy {
  const candidate = JSON.parse(json) as TcbPolicy;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
    || Object.keys(candidate).some((key) => !["version", "servingImageId", "requireCpuTee", "requireGpuCc"].includes(key))) {
    throw new Error("Invalid development TCB policy");
  }
  return JSON.parse(canonicalTcbPolicy(candidate)) as TcbPolicy;
}

export function tcbPolicyHash(policy: TcbPolicy): `0x${string}` {
  return sha256Hex(canonicalTcbPolicy(policy));
}

export function nextTcbVersion(current: number): number {
  if (!Number.isSafeInteger(current) || current < 1 || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error("current version");
  }
  return current + 1;
}

export function tcbPolicyRecord(policy: TcbPolicy): {
  version: number;
  servingImageId: string;
  measurement: `0x${string}`;
  policyHash: `0x${string}`;
} {
  return {
    version: policy.version,
    servingImageId: policy.servingImageId,
    measurement: measurementOf(policy),
    policyHash: tcbPolicyHash(policy),
  };
}
