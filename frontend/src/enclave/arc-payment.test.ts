import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { receiveData, signArcPayment } from "./arc-payment";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const intent = () => ({ payer: account.address, meter: `0x${"22".repeat(20)}`, amountUnits: "100000", paymentId: "10000000-0000-4000-8000-000000000002", validBefore: String(Math.floor(Date.now() / 1000) + 600) });
describe("bounded Arc payment signing", () => {
  it("requests only a six-decimal receive authorization with the exact Arc USDC domain", async () => {
    const input = intent();
    const request = vi.fn(async () => account.signTypedData(receiveData(input)));
    const auth = await signArcPayment(input, request);
    expect(auth.from).toBe(account.address);
    expect(request).toHaveBeenCalledTimes(1);
    const call = (request.mock.calls as unknown as [{ method: string; params: string[] }][])[0]![0];
    expect(call.method).toBe("eth_signTypedData_v4");
    const payload = JSON.parse(call.params[1]!);
    expect(payload.domain).toEqual({ name: "USDC", version: "2", chainId: 5042, verifyingContract: "0x3600000000000000000000000000000000000000" });
    expect(payload.primaryType).toBe("ReceiveWithAuthorization");
    expect(payload.message.value).toBe("100000");
    expect(payload.message.to).toBe(input.meter);
    expect(payload.message.validBefore).toBe(input.validBefore);
  });
  it("rejects a signature for a different amount", async () => {
    const input = intent();
    await expect(signArcPayment(input, async () => account.signTypedData(receiveData({ ...input, amountUnits: "200000" })))).rejects.toThrow("does not match");
  });
  it.each(["0", "-1", "0.1", "1000000000000000000"])("rejects invalid/oversized atomic-unit amount %s before requesting approval", async amountUnits => {
    const request = vi.fn();
    await expect(signArcPayment({ ...intent(), amountUnits }, request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects indefinite or expired payment permissions", () => {
    expect(() => receiveData({ ...intent(), validBefore: "1" })).toThrow();
    expect(() => receiveData({ ...intent(), validBefore: String(Math.floor(Date.now() / 1000) + 1801) })).toThrow();
  });
});
