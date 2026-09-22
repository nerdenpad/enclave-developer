export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class AttestationFailedError extends AppError {
  constructor(message = "Attestation verification failed") {
    super("ATTESTATION_FAILED", message, 403);
  }
}

export class KeyNotReleasedError extends AppError {
  constructor() {
    super("KEY_NOT_RELEASED", "No secret is released before attestation verifies", 403);
  }
}

export class TamperedImageError extends AppError {
  constructor() {
    super("TAMPERED_IMAGE", "Serving image measurement does not match TCB policy", 403);
  }
}

export class MandateBreachError extends AppError {
  constructor(message = "Mandate limit exceeded") {
    super("MANDATE_BREACH", message, 403);
  }
}

export class PaymentRequiredError extends AppError {
  constructor(
    message = "Payment required",
    public readonly payment: unknown,
  ) {
    super("PAYMENT_REQUIRED", message, 402, payment);
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown) {
    super("VALIDATION_FAILED", "Validation failed", 400, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super("NOT_FOUND", `${resource} not found: ${id}`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message, 409);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super("UNAUTHORIZED", message, 401);
  }
}

export class ModelNotApprovedError extends AppError {
  constructor(message = "Model is not approved in the registry") {
    super("MODEL_NOT_APPROVED", message, 403);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super("FORBIDDEN", message, 403);
  }
}
