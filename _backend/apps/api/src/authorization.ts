import { isAddress, keccak256, stringToHex, verifyTypedData, zeroAddress, type Hex } from "viem";
import { ValidationError } from "@enclave/core";
import type { Config } from "./config.js";
import type { PaymentAuthorization } from "./chain.js";

export const authorizationTypes = { ReceiveWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] } as const;

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_CANONICAL_S = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function authorizationError(): ValidationError {
  return new ValidationError({ authorization: "Invalid, expired, or mismatched USDC receive authorization" });
}

function uint256(value: string): bigint {
  if (!/^\d{1,78}$/.test(value)) throw authorizationError();
  const parsed = BigInt(value);
  if (parsed > MAX_UINT256) throw authorizationError();
  return parsed;
}

export function authorizationData(config: Config, paymentId: string, amount: bigint, from: Hex, validAfter: string, validBefore: string) {
  const after = uint256(validAfter);
  const before = uint256(validBefore);
  if (!paymentId || amount <= 0n || amount > MAX_UINT256 || !isAddress(from, { strict: false }) || from.toLowerCase() === zeroAddress || after >= before) {
    throw authorizationError();
  }
  return {
    domain: { name: config.USDC_EIP712_NAME, version: config.USDC_EIP712_VERSION, chainId: config.ARC_CHAIN_ID, verifyingContract: config.USDC_ADDRESS as Hex },
    types: authorizationTypes, primaryType: "ReceiveWithAuthorization" as const,
    message: { from, to: config.USAGE_METER_ADDRESS as Hex, value: amount, validAfter: after, validBefore: before, nonce: keccak256(stringToHex(paymentId)) },
  };
}

export async function validateAuthorization(config: Config, paymentId: string, amount: bigint, auth: PaymentAuthorization) {
  try {
    const data = authorizationData(config, paymentId, amount, auth.from, auth.validAfter, auth.validBefore);
    const now = BigInt(Math.floor(Date.now() / 1000));
    // ERC-3009 requires strictly greater/less than, including exact boundary seconds.
    if (data.message.validAfter >= now || data.message.validBefore <= now) throw authorizationError();
    if (!/^0x[0-9a-fA-F]{130}$/.test(auth.signature)) throw authorizationError();
    const s = BigInt(`0x${auth.signature.slice(66, 130)}`);
    const v = Number.parseInt(auth.signature.slice(130), 16);
    if (s > MAX_CANONICAL_S || ![27, 28].includes(v)) throw authorizationError();
    if (!await verifyTypedData({ ...data, address: auth.from, signature: auth.signature })) throw authorizationError();
  } catch { throw authorizationError(); }
}
