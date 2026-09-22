import { describe, expect, it } from "vitest";
import {
  AppError,
  AttestationFailedError,
  ConflictError,
  ForbiddenError,
  KeyNotReleasedError,
  MandateBreachError,
  ModelNotApprovedError,
  NotFoundError,
  PaymentRequiredError,
  TamperedImageError,
  UnauthorizedError,
  ValidationError,
} from "./errors.js";

describe("HTTP error contracts", () => {
  it.each([
    [new AttestationFailedError(), "ATTESTATION_FAILED", 403],
    [new KeyNotReleasedError(), "KEY_NOT_RELEASED", 403],
    [new TamperedImageError(), "TAMPERED_IMAGE", 403],
    [new MandateBreachError(), "MANDATE_BREACH", 403],
    [new ModelNotApprovedError(), "MODEL_NOT_APPROVED", 403],
    [new ForbiddenError(), "FORBIDDEN", 403],
    [new UnauthorizedError(), "UNAUTHORIZED", 401],
    [new ConflictError("already consumed"), "CONFLICT", 409],
    [new NotFoundError("receipt", "receipt-1"), "NOT_FOUND", 404],
    [new ValidationError({ field: "invalid" }), "VALIDATION_FAILED", 400],
  ] as const)("retains a stable code and HTTP status %#", (error, code, statusCode) => {
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(code);
    expect(error.statusCode).toBe(statusCode);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("preserves a payment challenge as typed 402 details", () => {
    const challenge = { x402Version: 1, accepts: [] };
    const error = new PaymentRequiredError(undefined, challenge);
    expect(error.statusCode).toBe(402);
    expect(error.code).toBe("PAYMENT_REQUIRED");
    expect(error.payment).toBe(challenge);
    expect(error.details).toBe(challenge);
  });

  it("preserves validation details and custom messages", () => {
    const details = { issues: ["missing session"] };
    expect(new ValidationError(details).details).toBe(details);
    expect(new AppError("INTERNAL", "internal").statusCode).toBe(500);
    expect(new UnauthorizedError("wrong key").message).toBe("wrong key");
    expect(new ForbiddenError("wrong owner").message).toBe("wrong owner");
    expect(new NotFoundError("receipt", "receipt-1").message).toContain("receipt-1");
  });
});
