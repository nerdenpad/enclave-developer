import { keccak256, recoverTypedDataAddress, stringToHex, type Hex } from "viem";
import { z } from "zod";
import arc from "./arc-mainnet.json" with { type: "json" };

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value => !/^0x0{40}$/i.test(value));
export const ArcPaymentPolicySchema = z.object({
  meter: address, verifier: address, receiptSigner: address,
  maxAmountUnits: z.string().regex(/^[1-9][0-9]{0,17}$/),
}).strict();
export type ArcPaymentPolicy = z.infer<typeof ArcPaymentPolicySchema>;
export const receiveTypes = { ReceiveWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] } as const;
export type ArcPaymentIntent = { payer: string; meter: string; amountUnits: string; paymentId: string; validBefore: string };
export type ArcAuthorization = { from: Hex; validAfter: string; validBefore: string; signature: Hex };
export function receiveData(intent: ArcPaymentIntent) {
  const parsed = z.object({ payer: address, meter: address, amountUnits: z.string().regex(/^[1-9][0-9]{0,17}$/),
    paymentId: z.string().uuid(), validBefore: z.string().regex(/^[1-9][0-9]{0,11}$/) }).strict().parse(intent);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(parsed.validBefore) <= now || BigInt(parsed.validBefore) > now + 1800n) throw Error("Payment authorization has expired or lasts too long");
  return { domain: { name: arc.usdc.eip712Name, version: arc.usdc.eip712Version, chainId: arc.chainId, verifyingContract: arc.usdc.address as Hex },
    types: receiveTypes, primaryType: "ReceiveWithAuthorization" as const,
    message: { from: parsed.payer as Hex, to: parsed.meter as Hex, value: BigInt(parsed.amountUnits), validAfter: 0n,
      validBefore: BigInt(parsed.validBefore), nonce: keccak256(stringToHex(parsed.paymentId)) } };
}
export async function signArcPayment(intent: ArcPaymentIntent, request: (args: { method: string; params: unknown[] }) => Promise<unknown>): Promise<ArcAuthorization> {
  const data = receiveData(intent);
  const payload = JSON.stringify({ ...data, types: { EIP712Domain: [
    { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
  ], ...data.types } }, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  const signature = await request({ method: "eth_signTypedData_v4", params: [intent.payer, payload] });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw Error("Wallet returned an unsupported signature");
  if ((await recoverTypedDataAddress({ ...data, signature: signature as Hex })).toLowerCase() !== intent.payer.toLowerCase()) throw Error("Wallet signature does not match the selected payer");
  // Do not accept approval that arrived after the authorization expired.
  receiveData(intent);
  return { from: intent.payer as Hex, validAfter: "0", validBefore: intent.validBefore, signature: signature as Hex };
}

// Explicit release configuration is required in addition to an authorized gateway.
// No environment values are supplied on the public pilot.
export function configuredArcPaymentPolicy(): ArcPaymentPolicy | null {
  if (import.meta.env["VITE_ARC_PAYMENTS_ENABLED"] !== "true") return null;
  const parsed = ArcPaymentPolicySchema.safeParse({ meter: import.meta.env["VITE_ARC_USAGE_METER"],
    verifier: import.meta.env["VITE_ARC_VERIFIER"], receiptSigner: import.meta.env["VITE_ARC_RECEIPT_SIGNER"],
    maxAmountUnits: import.meta.env["VITE_ARC_MAX_PAYMENT_UNITS"] });
  return parsed.success ? parsed.data : null;
}
