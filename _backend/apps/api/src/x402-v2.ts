import { z } from "zod";
import { getAddress, isAddress, verifyTypedData, zeroAddress, type Hex } from "viem";
import { AppError, ValidationError } from "@enclave/core";

// Official exact EVM EIP-3009/HTTP transport, limited to canonical EOA signatures.
// https://github.com/x402-foundation/x402/tree/main/specs
export const X402_HEADERS = { required: "PAYMENT-REQUIRED", signature: "PAYMENT-SIGNATURE", response: "PAYMENT-RESPONSE" } as const;
export const X402_TIMEOUT_SECONDS = 300;
const MAX_UINT = (1n << 256n) - 1n;
const MAX_S = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const address = z.string().refine((s) => isAddress(s, { strict: false }) && s.toLowerCase() !== zeroAddress);
const uint = z.string().regex(/^(0|[1-9]\d{0,77})$/).refine((s) => BigInt(s) <= MAX_UINT);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const resource = z.object({ url: z.string().url(), description: z.string().optional(), mimeType: z.string().optional() }).strict();
const requirements = z.object({
  scheme: z.literal("exact"), network: z.string().regex(/^eip155:[1-9]\d*$/),
  amount: uint.refine((s) => BigInt(s) > 0n), asset: address, payTo: address,
  maxTimeoutSeconds: z.number().int().positive().max(3600),
  extra: z.object({ assetTransferMethod: z.literal("eip3009"), name: z.string().min(1), version: z.string().min(1), enclavePaymentId: z.string().uuid() }).strict(),
}).strict();
const authorization = z.object({ from: address, to: address, value: uint, validAfter: uint, validBefore: uint, nonce: hex32 }).strict();
const payloadSchema = z.object({
  x402Version: z.literal(2), resource: resource.optional(), accepted: requirements,
  payload: z.object({ authorization, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict(),
  extensions: z.object({}).strict().optional(),
}).strict();
export type X402Requirement = z.infer<typeof requirements>;
export type X402PaymentRequired = { x402Version: 2; resource: z.infer<typeof resource>; accepts: [X402Requirement] };
export type X402Payload = z.infer<typeof payloadSchema>;
export type TransferAuthorization = z.infer<typeof authorization> & { signature: Hex };
/** Chain proof succeeded but durable API finalization needs retry. Never advertise this as an unpaid request. */
export class X402PaidError extends AppError {
  constructor(readonly tx: Hex, readonly payer: Hex) {
    super("SETTLEMENT_PENDING", "Payment confirmed; completion pending reconciliation", 503);
  }
}
export const transferAuthorizationTypes = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] } as const;

function invalid(): ValidationError { return new ValidationError({ payment: "Invalid x402 v2 exact EIP-3009 payment" }); }
export function caip2(chainId: number): `eip155:${number}` {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw invalid();
  return `eip155:${chainId}`;
}
export function createPaymentRequired(input: {
  resourceUrl: string; paymentId: string; chainId: number; amount: bigint; asset: string; payTo: string;
  domainName: string; domainVersion: string; maxTimeoutSeconds?: number;
}): X402PaymentRequired {
  try {
    const url = new URL(input.resourceUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw invalid();
    return {
      x402Version: 2, resource: { url: input.resourceUrl, description: "Encrypted ENCLAVE inference", mimeType: "application/json" },
      accepts: [requirements.parse({ scheme: "exact", network: caip2(input.chainId), amount: input.amount.toString(),
        asset: getAddress(input.asset), payTo: getAddress(input.payTo), maxTimeoutSeconds: input.maxTimeoutSeconds ?? X402_TIMEOUT_SECONDS,
        extra: { assetTransferMethod: "eip3009", name: input.domainName, version: input.domainVersion, enclavePaymentId: input.paymentId },
      })],
    };
  } catch { throw invalid(); }
}

export function encodePaymentRequired(value: X402PaymentRequired): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64"); }
export function decodePaymentSignature(header: string): X402Payload {
  try {
    if (header.length === 0 || header.length > 24_000 || header.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(header)) throw invalid();
    const bytes = Buffer.from(header, "base64");
    if (bytes.toString("base64") !== header) throw invalid();
    return payloadSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { throw invalid(); }
}

export function transferTypedData(expected: X402Requirement, auth: TransferAuthorization) {
  const chainId = Number(expected.network.slice(7));
  if (caip2(chainId) !== expected.network) throw invalid();
  return {
    domain: { name: expected.extra.name, version: expected.extra.version, chainId, verifyingContract: expected.asset as Hex },
    types: transferAuthorizationTypes, primaryType: "TransferWithAuthorization" as const,
    message: { from: auth.from as Hex, to: auth.to as Hex, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce as Hex },
  };
}

/** allowExpired is only for an identical durably persisted authorization being reconciled/replayed. */
export async function validateExactPayload(payload: X402Payload, expected: X402PaymentRequired, options: { nowSeconds?: number; allowExpired?: boolean } = {}): Promise<TransferAuthorization> {
  try {
    const parsed = payloadSchema.parse(payload);
    const a = parsed.accepted;
    const e = requirements.parse(expected.accepts[0]);
    if (parsed.resource && (parsed.resource.url !== expected.resource.url || parsed.resource.description !== expected.resource.description || parsed.resource.mimeType !== expected.resource.mimeType)) throw invalid();
    if (a.scheme !== e.scheme || a.network !== e.network || a.amount !== e.amount || a.asset.toLowerCase() !== e.asset.toLowerCase() || a.payTo.toLowerCase() !== e.payTo.toLowerCase() || a.maxTimeoutSeconds !== e.maxTimeoutSeconds) throw invalid();
    if (a.extra.assetTransferMethod !== e.extra.assetTransferMethod || a.extra.name !== e.extra.name || a.extra.version !== e.extra.version || a.extra.enclavePaymentId !== e.extra.enclavePaymentId) throw invalid();
    const auth: TransferAuthorization = { ...parsed.payload.authorization, signature: parsed.payload.signature as Hex };
    if (auth.to.toLowerCase() !== e.payTo.toLowerCase() || auth.value !== e.amount || BigInt(auth.validAfter) >= BigInt(auth.validBefore)) throw invalid();
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(now) || now < 0) throw invalid();
    if (!options.allowExpired && (BigInt(auth.validAfter) >= BigInt(now) || BigInt(auth.validBefore) <= BigInt(now) || BigInt(auth.validBefore) > BigInt(now + e.maxTimeoutSeconds))) throw invalid();
    const s = BigInt(`0x${auth.signature.slice(66, 130)}`);
    const v = Number.parseInt(auth.signature.slice(130), 16);
    if (s === 0n || s > MAX_S || ![27, 28].includes(v)) throw invalid();
    if (!await verifyTypedData({ ...transferTypedData(e, auth), address: auth.from as Hex, signature: auth.signature })) throw invalid();
    return { ...auth, from: getAddress(auth.from), to: getAddress(auth.to), nonce: auth.nonce.toLowerCase(), signature: auth.signature.toLowerCase() as Hex };
  } catch { throw invalid(); }
}

export function encodePaymentResponse(input: { success: boolean; transaction: string; chainId: number; payer?: string; errorReason?: string }): string {
  if (input.success && !/^0x[0-9a-fA-F]{64}$/.test(input.transaction)) throw invalid();
  return Buffer.from(JSON.stringify({ success: input.success, transaction: input.transaction, network: caip2(input.chainId),
    ...(input.payer ? { payer: getAddress(input.payer) } : {}), ...(input.errorReason ? { errorReason: input.errorReason } : {}),
  }), "utf8").toString("base64");
}
