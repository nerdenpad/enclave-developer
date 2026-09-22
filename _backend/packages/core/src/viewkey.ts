import { timingSafeEqual } from "node:crypto";
import { sha256, sha256Hex } from "./hash.js";

export function hashViewSecret(secret: string): `0x${string}` {
  return sha256Hex(`enclave-view-key:v1:${secret}`);
}

export function viewSecretMatches(secret: string, digest: string): boolean {
  const left = sha256(`enclave-view-key:v1:${secret}`);
  const raw = digest.startsWith("0x") ? digest.slice(2) : digest;
  if (raw.length !== 64) {
    return false;
  }
  const right = Buffer.from(raw, "hex");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export type PublicReceipt = {
  typedHash: string;
  modelHash: string;
  codeHash: string;
  inHash: string;
  outHash: string;
  status: string;
};

const PUBLIC_RECEIPT_KEYS = ["typedHash", "modelHash", "codeHash", "inHash", "outHash", "status"] as const;

export function publicReceiptView(row: {
  typedHash: string;
  modelHash: string;
  codeHash: string;
  inHash: string;
  outHash: string;
  status: string;
}): PublicReceipt {
  return {
    typedHash: row.typedHash,
    modelHash: row.modelHash,
    codeHash: row.codeHash,
    inHash: row.inHash,
    outHash: row.outHash,
    status: row.status,
  };
}

export function publicReceiptLeaksSecrets(payload: Record<string, unknown>): string[] {
  const banned = ["sig", "keyHash", "agentId", "settleTx", "amountUnits", "usdcUnits", "ciphertext", "plaintext"];
  return banned.filter((key) => payload[key] !== undefined && payload[key] !== null);
}

export type PublicPayment = {
  id: string;
  status: string;
  confidential: boolean;
};

const PUBLIC_PAYMENT_KEYS = ["id", "status", "confidential"] as const;

export function publicPaymentView(row: {
  id: string;
  status: string;
  confidential?: boolean | null;
}): PublicPayment {
  return {
    id: row.id,
    status: row.status,
    confidential: Boolean(row.confidential),
  };
}

export function isHashOnlyPayment(payload: Record<string, unknown>): boolean {
  const keys = Object.keys(payload);
  return (
    keys.every((key) => (PUBLIC_PAYMENT_KEYS as readonly string[]).includes(key)) &&
    payload.amountUnits === undefined &&
    payload.settleTx === undefined &&
    payload.keyHash === undefined
  );
}

export function isHashOnlyReceipt(payload: Record<string, unknown>): boolean {
  const keys = Object.keys(payload);
  return (
    keys.every((key) => (PUBLIC_RECEIPT_KEYS as readonly string[]).includes(key)) &&
    publicReceiptLeaksSecrets(payload).length === 0
  );
}
