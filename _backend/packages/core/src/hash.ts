import { createHash, createHmac, randomBytes } from "node:crypto";

export function sha256(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest();
}

export function sha256Hex(data: Buffer | string): `0x${string}` {
  return `0x${sha256(data).toString("hex")}`;
}

export function hmacSha256(key: Buffer, data: Buffer | string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export function randomBytes32(): Buffer {
  return randomBytes(32);
}

export function toHex(buf: Buffer): `0x${string}` {
  return `0x${buf.toString("hex")}`;
}

export function fromHex(hex: string): Buffer {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) {
    throw new Error("odd hex length");
  }
  if (!/^[0-9a-fA-F]*$/.test(h)) {
    throw new Error("invalid hex characters");
  }
  return Buffer.from(h, "hex");
}

export function isHex32(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
