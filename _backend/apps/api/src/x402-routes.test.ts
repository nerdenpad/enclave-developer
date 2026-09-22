import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@enclave/core";
import type { EnclaveGateway } from "./gateway.js";
import { createX402Routes } from "./x402-routes.js";
import { createPaymentRequired } from "./x402-v2.js";

const payer = "0x0000000000000000000000000000000000000100";
const required = createPaymentRequired({ resourceUrl: "http://localhost/v2/inference", paymentId: "10000000-0000-4000-8000-000000000001",
  chainId: 31337, amount: 100000n, asset: payer, payTo: "0x0000000000000000000000000000000000000200", domainName: "USD Coin", domainVersion: "2" });
const payload = { x402Version: 2, resource: required.resource, accepted: required.accepts[0], payload: {
  signature: `0x${"11".repeat(64)}1b`, authorization: { from: payer, to: required.accepts[0].payTo, value: "100000", validAfter: "0", validBefore: "1800000300", nonce: `0x${"aa".repeat(32)}` },
} };
const body = { sessionId: "10000000-0000-4000-8000-000000000002", iv: Buffer.alloc(12).toString("base64"), tag: Buffer.alloc(16).toString("base64"), ciphertext: "aGk=" };
const tx = `0x${"ab".repeat(32)}`;
function fixture() {
  const infer = vi.fn();
  const gateway = { x402Infer: infer, health: () => ({ chainId: 31337 }) } as unknown as Pick<EnclaveGateway, "x402Infer" | "health">;
  const app = new Hono().onError((error, c) => c.json({ code: error instanceof AppError ? error.code : "INTERNAL" }, error instanceof AppError ? error.statusCode as 400 : 500));
  app.route("/v2", createX402Routes(gateway));
  const send = (input: unknown = body, headers: Record<string, string> = {}) => app.request("http://localhost/v2/inference", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "test-key", ...headers }, body: JSON.stringify(input) });
  const paid = () => send(body, { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") });
  return { app, send, paid, infer };
}
function receipt(response: Response) { return JSON.parse(Buffer.from(response.headers.get("PAYMENT-RESPONSE")!, "base64").toString()); }
describe("x402 HTTP routing boundaries", () => {
  it("returns the standard challenge and preserves session authentication and resource identity", async () => {
    const f = fixture(); f.infer.mockResolvedValue({ kind: "required", required });
    const response = await f.send(body, { "idempotency-key": "retry-key", "x-forwarded-host": "attacker.example" });
    expect(response.status).toBe(402);
    expect(JSON.parse(Buffer.from(response.headers.get("PAYMENT-REQUIRED")!, "base64").toString())).toEqual(required);
    expect(f.infer).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "test-key", sessionId: body.sessionId, idempotencyKey: "retry-key" }), "http://localhost/v2/inference", undefined);
    expect(response.headers.get("access-control-expose-headers")).toContain("PAYMENT-RESPONSE");
  });
  it("rejects malformed JSON without consulting the gateway", async () => {
    const f = fixture(); const response = await f.app.request("/v2/inference", { method: "POST", body: "{" });
    expect(response.status).toBe(400); expect(f.infer).not.toHaveBeenCalled();
  });
  it.each([{}, { ...body, paymentId: required.accepts[0].extra.enclavePaymentId }])("rejects invalid body or legacy payment tokens", async (input) => {
    const f = fixture(); expect((await f.send(input)).status).toBe(400); expect(f.infer).not.toHaveBeenCalled();
  });
  it.each([{ "x-payment": "legacy" }, { "PAYMENT-SIGNATURE": "not-base64" }])("rejects invalid header transport", async (headers) => {
    const f = fixture(); expect((await f.send(body, headers)).status).toBe(400); expect(f.infer).not.toHaveBeenCalled();
  });
  it("does not invent a payment response for a disabled endpoint", async () => {
    const f = fixture(); f.infer.mockRejectedValue(new AppError("X402_UNAVAILABLE", "Unavailable", 503));
    const response = await f.send(); expect(response.status).toBe(503); expect(response.headers.get("PAYMENT-RESPONSE")).toBeNull();
  });
  it("identifies a pending settlement and preserves its HTTP status", async () => {
    const f = fixture(); f.infer.mockRejectedValue(new AppError("SETTLEMENT_PENDING", "Pending", 503));
    const response = await f.paid(); expect(response.status).toBe(503);
    expect(receipt(response)).toEqual({ success: false, transaction: "", network: "eip155:31337", errorReason: "settlement_pending" });
  });
  it("serializes receipt timestamps while retaining the proven settlement transaction", async () => {
    const f = fixture(); f.infer.mockResolvedValue({ kind: "success", result: { receipt: { ts: 123n }, output: body }, tx, payer, chainId: 31337 });
    const response = await f.paid(); expect(response.status).toBe(200); expect((await response.json()).receipt.ts).toBe("123");
    expect(receipt(response)).toMatchObject({ success: true, transaction: tx, payer });
  });
  it("reports an already settled payment truthfully even when inference fails", async () => {
    const f = fixture(); f.infer.mockResolvedValue({ kind: "inference-error", error: new AppError("INFERENCE_UNAVAILABLE", "Offline", 503), tx, payer, chainId: 31337 });
    const response = await f.paid(); expect(response.status).toBe(503);
    expect(receipt(response)).toMatchObject({ success: true, transaction: tx, payer });
  });
});
