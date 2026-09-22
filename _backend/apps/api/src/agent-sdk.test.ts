import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSdkManifest, ValidationError } from "@enclave/core";
import { EnclaveGateway } from "./gateway.js";
import { SettleBody } from "./validation.js";

const paymentId = "10000000-0000-4000-8000-000000000001";
const authorization = {
  from: "0x1111111111111111111111111111111111111111",
  validAfter: "0", validBefore: "1800000000", signature: `0x${"12".repeat(64)}1b`,
};
const settlePayment = vi.fn<EnclaveGateway["settlePayment"]>();
// Exercise the real SDK dispatcher and its schema. Only the downstream settlement
// boundary is substituted; authorization cryptography has its own unit/integration tests.
const invoke = (input: Record<string, unknown>) => EnclaveGateway.prototype.invokeAgentTool.call(
  { settlePayment } as unknown as EnclaveGateway, "sdk-owner", "enclave_settle", input,
);

beforeEach(() => {
  settlePayment.mockReset().mockResolvedValue({ paymentId, tx: "confirmed-tx", confidential: false });
});

describe("SDK settlement authorization contract", () => {
  it("forwards every authorization field without dropping or changing the signature", async () => {
    await expect(invoke({ paymentId, authorization })).resolves.toEqual({ paymentId, tx: "confirmed-tx", confidential: false });
    expect(settlePayment).toHaveBeenCalledExactlyOnceWith("sdk-owner", paymentId, false, authorization);
  });

  it("preserves the existing optional mock settlement input and confidential flag", async () => {
    await invoke({ paymentId });
    expect(settlePayment).toHaveBeenLastCalledWith("sdk-owner", paymentId, false, undefined);
    await invoke({ paymentId, confidential: true });
    expect(settlePayment).toHaveBeenLastCalledWith("sdk-owner", paymentId, true, undefined);
  });

  it.each(["from", "validAfter", "validBefore", "signature"] as const)("rejects incomplete authorization missing %s before settlement", async (field) => {
    const incomplete: Record<string, unknown> = { ...authorization };
    delete incomplete[field];
    await expect(invoke({ paymentId, authorization: incomplete })).rejects.toBeInstanceOf(ValidationError);
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it.each([
    ["from", "0x1234"], ["validAfter", "-1"], ["validBefore", "9".repeat(79)], ["signature", "0x1234"],
  ])("keeps the advertised %s pattern consistent with REST and SDK validation", async (field, invalid) => {
    const settle = agentSdkManifest().tools.find((tool) => tool.name === "enclave_settle")!;
    const schema = settle.input_schema as { properties: { authorization: { properties: Record<string, { pattern: string }> } } };
    const pattern = new RegExp(schema.properties.authorization.properties[field!]!.pattern);
    expect(pattern.test(authorization[field as keyof typeof authorization])).toBe(true);
    expect(pattern.test(invalid!)).toBe(false);
    const input = { paymentId, authorization: { ...authorization, [field!]: invalid } };
    expect(SettleBody.safeParse(input).success).toBe(false);
    await expect(invoke(input)).rejects.toBeInstanceOf(ValidationError);
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it("requires decimal validity strings to avoid unsafe JSON integer conversion", async () => {
    await expect(invoke({ paymentId, authorization: { ...authorization, validBefore: 1_800_000_000 } })).rejects.toBeInstanceOf(ValidationError);
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it("propagates settlement authorization failures to the SDK caller", async () => {
    const failure = new ValidationError({ authorization: "Expired authorization" });
    settlePayment.mockRejectedValueOnce(failure);
    await expect(invoke({ paymentId, authorization })).rejects.toBe(failure);
  });
});
