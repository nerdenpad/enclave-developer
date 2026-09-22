import { describe, expect, it } from "vitest";
import { isHashOnlyReceipt, publicPaymentView, isHashOnlyPayment, publicReceiptLeaksSecrets, publicReceiptView } from "./viewkey.js";

describe("public receipt redaction", () => {
  it("keeps only hashes and drops sig / payer fields", () => {
    const pub = publicReceiptView({
      typedHash: "0xaaa",
      modelHash: "0xbbb",
      codeHash: "0xccc",
      inHash: "0xddd",
      outHash: "0xeee",
      status: "anchored",
    });
    expect(isHashOnlyReceipt(pub)).toBe(true);
    expect(
      publicReceiptLeaksSecrets({
        ...pub,
        sig: "0xsig",
        keyHash: "0xkey",
        amountUnits: "100",
      }),
    ).toEqual(["sig", "keyHash", "amountUnits"]);
  });

  it("hides payment amounts on the public view", () => {
    const pub = publicPaymentView({
      id: "pay-1",
      status: "settled",
      confidential: true,
    });
    expect(isHashOnlyPayment(pub)).toBe(true);
    expect("amountUnits" in pub).toBe(false);
  });
});
