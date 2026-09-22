import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type AesGcmBlob = {
  iv: string;
  tag: string;
  ciphertext: string;
};

export function encryptAesGcm(key: Buffer, plaintext: Buffer): AesGcmBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptAesGcm(key: Buffer, blob: AesGcmBlob): Buffer {
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const ciphertext = Buffer.from(blob.ciphertext, "base64");
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("Invalid AES-GCM IV or authentication tag length");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
