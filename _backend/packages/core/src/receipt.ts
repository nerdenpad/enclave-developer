import {
  type Hex,
  hashTypedData,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sha256Hex } from "./hash.js";

export const LEGACY_RECEIPT_TYPES = {
  InferenceReceipt: [
    { name: "modelHash", type: "bytes32" },
    { name: "codeHash", type: "bytes32" },
    { name: "inHash", type: "bytes32" },
    { name: "outHash", type: "bytes32" },
    { name: "attRef", type: "bytes32" },
    { name: "ts", type: "uint64" },
  ],
} as const;

export const RECEIPT_TYPES = {
  InferenceReceipt: [
    { name: "modelHash", type: "bytes32" },
    { name: "codeHash", type: "bytes32" },
    { name: "inHash", type: "bytes32" },
    { name: "outHash", type: "bytes32" },
    { name: "attRef", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "ts", type: "uint64" },
  ],
} as const;

type ReceiptFields = {
  modelHash: `0x${string}`;
  codeHash: `0x${string}`;
  inHash: `0x${string}`;
  outHash: `0x${string}`;
  attRef: `0x${string}`;
  ts: bigint;
};

export type LegacyInferenceReceipt = ReceiptFields & { receiptVersion: 1 };
export type InferenceReceiptV2 = ReceiptFields & { receiptVersion: 2; nonce: `0x${string}` };
export type InferenceReceipt = LegacyInferenceReceipt | InferenceReceiptV2;

export type SignedReceipt = InferenceReceipt & {
  sig: `0x${string}`;
};

export function receiptDomain(chainId: number, verifyingContract: `0x${string}`, version: 1 | 2 = 2) {
  if (version !== 1 && version !== 2) throw new Error("Unsupported receipt version");
  return {
    name: "ENCLAVE",
    version: version === 1 ? "1" : "2",
    chainId,
    verifyingContract,
  } as const;
}

export function hashesForIo(input: Buffer, output: Buffer): { inHash: `0x${string}`; outHash: `0x${string}` } {
  return { inHash: sha256Hex(input), outHash: sha256Hex(output) };
}

export async function signReceipt<T extends InferenceReceipt>(
  receipt: T,
  privateKey: `0x${string}`,
  chainId: number,
  verifyingContract: `0x${string}`,
): Promise<T & { sig: `0x${string}` }> {
  const account = privateKeyToAccount(privateKey);
  const sig = await account.signTypedData({
    domain: receiptDomain(chainId, verifyingContract, receipt.receiptVersion),
    types: receipt.receiptVersion === 1 ? LEGACY_RECEIPT_TYPES : RECEIPT_TYPES,
    primaryType: "InferenceReceipt",
    message: receipt,
  });
  return { ...receipt, sig };
}

export async function verifyReceiptSignature(
  signed: SignedReceipt,
  expectedSigner: `0x${string}`,
  chainId: number,
  verifyingContract: `0x${string}`,
): Promise<boolean> {
  const recovered = await recoverTypedDataAddress({
    domain: receiptDomain(chainId, verifyingContract, signed.receiptVersion),
    types: signed.receiptVersion === 1 ? LEGACY_RECEIPT_TYPES : RECEIPT_TYPES,
    primaryType: "InferenceReceipt",
    message: signed,
    signature: signed.sig,
  });
  return recovered.toLowerCase() === expectedSigner.toLowerCase();
}

export function receiptTypedHash(
  receipt: InferenceReceipt,
  chainId: number,
  verifyingContract: `0x${string}`,
): Hex {
  return hashTypedData({
    domain: receiptDomain(chainId, verifyingContract, receipt.receiptVersion),
    types: receipt.receiptVersion === 1 ? LEGACY_RECEIPT_TYPES : RECEIPT_TYPES,
    primaryType: "InferenceReceipt",
    message: receipt,
  });
}
