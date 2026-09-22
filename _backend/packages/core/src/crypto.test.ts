import { describe, expect, it } from "vitest";
import { decryptAesGcm, encryptAesGcm } from "./crypto.js";

const key = Buffer.alloc(32, 0x42);

function flipBase64(value: string): string {
  const bytes = Buffer.from(value, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString("base64");
}

describe("AES-256-GCM encrypted transport", () => {
  it.each([Buffer.alloc(0), Buffer.from("private prompt: Привет 🔐"), Buffer.from([0, 255, 128, 0, 1])])(
    "round-trips empty, UTF-8 and binary plaintext %#",
    (plaintext) => {
      const encrypted = encryptAesGcm(key, plaintext);
      expect(Buffer.from(encrypted.iv, "base64")).toHaveLength(12);
      expect(Buffer.from(encrypted.tag, "base64")).toHaveLength(16);
      expect(decryptAesGcm(key, encrypted)).toEqual(plaintext);
    },
  );

  it("uses a fresh nonce so repeated prompts do not expose equality", () => {
    const prompt = Buffer.from("same prompt");
    const first = encryptAesGcm(key, prompt);
    const second = encryptAesGcm(key, prompt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(decryptAesGcm(key, first)).toEqual(decryptAesGcm(key, second));
  });

  it.each(["iv", "tag", "ciphertext"] as const)("authenticates %s before returning plaintext", (field) => {
    const blob = encryptAesGcm(key, Buffer.from("private output"));
    expect(() => decryptAesGcm(key, { ...blob, [field]: flipBase64(blob[field]) })).toThrow();
  });

  it("rejects decryption with another session key", () => {
    expect(() => decryptAesGcm(Buffer.alloc(32, 0x43), encryptAesGcm(key, Buffer.from("secret")))).toThrow();
  });

  it.each([0, 16, 24, 31, 33])("rejects a %i-byte key", (size) => {
    const wrongKey = Buffer.alloc(size);
    expect(() => encryptAesGcm(wrongKey, Buffer.from("secret"))).toThrow();
    expect(() => decryptAesGcm(wrongKey, encryptAesGcm(key, Buffer.from("secret")))).toThrow();
  });

  it.each([0, 1, 8, 11, 13, 16])("rejects a %i-byte transport nonce", (size) => {
    const blob = encryptAesGcm(key, Buffer.from("secret"));
    expect(() => decryptAesGcm(key, { ...blob, iv: Buffer.alloc(size).toString("base64") })).toThrow();
  });
});
