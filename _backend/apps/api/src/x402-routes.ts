import { Hono } from "hono";
import { AppError, ValidationError } from "@enclave/core";
import type { EnclaveGateway } from "./gateway.js";
import { InferBody } from "./validation.js";
import { X402_HEADERS, decodePaymentSignature, encodePaymentRequired, encodePaymentResponse } from "./x402-v2.js";

/** Mount with app.route('/v2', createX402Routes(gateway)). API-key/session authentication still applies. */
export function createX402Routes(gateway: Pick<EnclaveGateway, "x402Infer" | "health">) {
  const router = new Hono();
  router.post("/inference", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new ValidationError({ body: "Invalid JSON" }); }
    const parsed = InferBody.safeParse(body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    if (parsed.data.paymentId || c.req.header("x-payment")) throw new ValidationError({ payment: "Use PAYMENT-SIGNATURE for x402 v2" });
    const header = c.req.header(X402_HEADERS.signature);
    const payload = header ? decodePaymentSignature(header) : undefined;
    const resourceUrl = new URL(c.req.url);
    // A query is part of the advertised resource identity. Never trust forwarded host/proto headers.
    resourceUrl.hash = "";
    c.header("Access-Control-Expose-Headers", `${X402_HEADERS.required}, ${X402_HEADERS.response}`);
    c.header("Cache-Control", "no-store");
    let settled = false;
    try {
      const outcome = await gateway.x402Infer({ apiKey: c.req.header("x-api-key") ?? "", sessionId: parsed.data.sessionId,
        blob: { iv: parsed.data.iv, tag: parsed.data.tag, ciphertext: parsed.data.ciphertext }, agentId: parsed.data.agentId,
        idempotencyKey: c.req.header("idempotency-key") ?? undefined }, resourceUrl.href, payload);
      if (outcome.kind === "required") {
        c.header(X402_HEADERS.required, encodePaymentRequired(outcome.required));
        return c.json({ error: "PAYMENT-SIGNATURE header is required" }, 402);
      }
      c.header(X402_HEADERS.response, encodePaymentResponse({ success: true, transaction: outcome.tx, payer: outcome.payer, chainId: outcome.chainId }));
      settled = true;
      if (outcome.kind === "inference-error") throw outcome.error;
      return c.json({ ...outcome.result, receipt: { ...outcome.result.receipt, ts: outcome.result.receipt.ts.toString() } });
    } catch (error) {
      if (payload && !settled) c.header(X402_HEADERS.response, encodePaymentResponse({ success: false, transaction: "", chainId: gateway.health().chainId,
        errorReason: error instanceof AppError && error.code === "SETTLEMENT_PENDING" ? "settlement_pending" : "payment_failed" }));
      throw error;
    }
  });
  return router;
}
