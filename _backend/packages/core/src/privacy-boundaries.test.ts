import { describe, expect, it } from "vitest";
import {
  bannedSecretFields,
  hashViewSecret,
  isHashOnlyPayment,
  isHashOnlyReceipt,
  publicPaymentView,
  publicReceiptLeaksSecrets,
  publicReceiptView,
  secretMaterialHits,
  sha256Hex,
  viewSecretMatches,
} from "./index.js";

describe("view-key secrecy and public redaction", () => {
  const receipt = {
    typedHash: sha256Hex("receipt"),
    modelHash: sha256Hex("model"),
    codeHash: sha256Hex("code"),
    inHash: sha256Hex("input"),
    outHash: sha256Hex("output"),
    status: "anchored",
  };

  it("strips all private and newly added fields from a full database receipt", () => {
    const row = {
      ...receipt,
      sig: "signature",
      keyHash: "api-key-hash",
      agentId: "agent",
      settleTx: "tx",
      amountUnits: 500n,
      ciphertext: "secret",
      newPrivateField: "future field",
    };
    const view = publicReceiptView(row);
    expect(view).toEqual(receipt);
    expect(isHashOnlyReceipt(view)).toBe(true);
    expect(row.sig).toBe("signature");
    expect(isHashOnlyReceipt(row)).toBe(false);
    expect(isHashOnlyReceipt({ ...view, unexpected: null })).toBe(false);
  });

  it("reports every known secret field, including falsey but disclosed values", () => {
    expect(publicReceiptLeaksSecrets({
      sig: "", keyHash: "key", agentId: 0, settleTx: false, amountUnits: "0", usdcUnits: 0,
      ciphertext: "cipher", plaintext: "plain",
    })).toEqual(["sig", "keyHash", "agentId", "settleTx", "amountUnits", "usdcUnits", "ciphertext", "plaintext"]);
    expect(publicReceiptLeaksSecrets({ sig: null, keyHash: undefined })).toEqual([]);
  });

  it("redacts payment identity and amount fields and normalizes missing confidentiality", () => {
    const full = { id: "payment", status: "settled", confidential: true, amountUnits: 100n, settleTx: "tx", keyHash: "key" };
    expect(publicPaymentView(full)).toEqual({ id: "payment", status: "settled", confidential: true });
    expect(publicPaymentView({ id: "payment", status: "open" }).confidential).toBe(false);
    expect(publicPaymentView({ id: "payment", status: "open", confidential: null }).confidential).toBe(false);
    expect(isHashOnlyPayment(full)).toBe(false);
    expect(isHashOnlyPayment({ ...publicPaymentView(full), unknown: "sensitive" })).toBe(false);
  });

  it("uses domain-separated view-secret digests and accepts case-insensitive digest hex", () => {
    const secret = "auditor-secret";
    const digest = hashViewSecret(secret);
    expect(digest).not.toBe(sha256Hex(secret));
    expect(viewSecretMatches(secret, digest.slice(2))).toBe(true);
    expect(viewSecretMatches(secret, `0x${digest.slice(2).toUpperCase()}`)).toBe(true);
    expect(viewSecretMatches("Auditor-secret", digest)).toBe(false);
  });

  it.each(["", "0x", "0x1234", "z".repeat(64), `${"a".repeat(62)}gg`, "a".repeat(66)])(
    "rejects malformed view-key digests without throwing %#",
    (digest) => expect(viewSecretMatches("secret", digest)).toBe(false),
  );

  it("finds nested banned fields in arrays once and ignores primitive/null values", () => {
    const payload = [null, false, "safe", { privateKey: "a", nested: [{ privateKey: "b", prompt: "secret" }] }, { memoryPlaintext: "memory" }];
    expect(bannedSecretFields(payload)).toEqual(["privateKey", "prompt", "memoryPlaintext"]);
    expect(bannedSecretFields(null)).toEqual([]);
  });

  it("finds prefixed and unprefixed secret hex regardless of case, excluding short noise", () => {
    const secret = "0xABCDEF0123456789ABCDEF0123456789";
    expect(secretMaterialHits({ value: secret.slice(2).toLowerCase() }, [secret, "0xabc", ""])).toEqual([secret]);
    expect(secretMaterialHits({ value: "safe" }, [secret])).toEqual([]);
  });
});
