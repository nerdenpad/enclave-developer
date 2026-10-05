import { describe, expect, it, vi } from "vitest";
import { AppError } from "./errors.js";
import { createNearAttestationError, getNearAttestationFailure, isNearAttestationError, isUnapprovedNearWorkload,
  type NearAttestationFailure } from "./near-attestation-error.js";

describe("trusted NEAR attestation error diagnostics", () => {
  it("brands only internally created errors and retains the existing public enum diagnostic", () => {
    const failure = { stage: "verifier", reason: "rejected", verifierError: "WORKLOAD_NOT_APPROVED" } as const;
    const error = createNearAttestationError(failure);
    expect(error).toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED", statusCode: 503, details: { attestationFailure: failure } });
    expect(getNearAttestationFailure(error)).toEqual(failure);
    expect(isNearAttestationError(error)).toBe(true);
    expect(isUnapprovedNearWorkload(error)).toBe(true);
    expect(Object.isFrozen(getNearAttestationFailure(error))).toBe(true);
    const forged = new AppError(error.code, error.message, error.statusCode, error.details);
    expect(getNearAttestationFailure(forged)).toBeUndefined();
    expect(isNearAttestationError(forged)).toBe(false);
    expect(isUnapprovedNearWorkload(forged)).toBe(false);
  });

  it("keeps the trusted snapshot independent of mutable input and public details", () => {
    const failure: NearAttestationFailure = { stage: "transport", reason: "tls" };
    const error = createNearAttestationError(failure);
    failure.reason = "request";
    (error.details as { attestationFailure: { reason: string } }).attestationFailure.reason = "private forged value";
    expect(getNearAttestationFailure(error)).toEqual({ stage: "transport", reason: "tls" });
  });

  it.each([
    { stage: "verifier", reason: "rejected", verifierError: "CPU_TCB_REJECTED\nprivate token" },
    { stage: "verifier", reason: "rejected", verifierError: "CPU_TCB_REJECTED", report: "private report" },
    { stage: "transport", reason: "private reason" }, { stage: "private stage", reason: "request" },
  ])("reduces unknown or additional diagnostic fields to the fixed generic enum %#", failure => {
    const error = createNearAttestationError(failure as NearAttestationFailure);
    expect(getNearAttestationFailure(error)).toEqual({ stage: "transport", reason: "request" });
    expect(JSON.stringify(error)).not.toMatch(/private|token|report/);
  });

  it("never inspects properties on untrusted errors", () => {
    const read = vi.fn(() => { throw new Error("private getter payload"); });
    const error = Object.defineProperties({}, { code: { get: read }, message: { get: read }, details: { get: read } });
    expect(getNearAttestationFailure(error)).toBeUndefined();
    expect(isNearAttestationError(error)).toBe(false);
    expect(isUnapprovedNearWorkload(error)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    for (const value of [null, undefined, false, 503, "private error"]) expect(getNearAttestationFailure(value)).toBeUndefined();
  });
});
