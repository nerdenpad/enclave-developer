import { describe, expect, it, vi } from "vitest";
import { AppError } from "@enclave/core";
import { inferenceExecutionFailureCode, runClaimedInference } from "./inference-execution.js";

describe("private inference failure observation", () => {
  it("records the original failure once while preserving the generic quarantine response", async () => {
    const original = new AppError("NEAR_VERIFICATION_FAILED", "private provider response", 503, { token: "private-token" });
    const execute = vi.fn().mockRejectedValue(original), record = vi.fn(() => undefined);
    await expect(runClaimedInference("payment-id", execute, record)).rejects.toMatchObject({
      code: "INFERENCE_EXECUTION_UNCERTAIN", statusCode: 409, details: { paymentId: "payment-id" },
    });
    expect(execute).toHaveBeenCalledOnce(); expect(record).toHaveBeenCalledExactlyOnceWith(original);
  });

  it("a failing observer cannot escape quarantine or retry execution", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("private provider failure"));
    const record = vi.fn(() => { throw new Error("private logging failure"); });
    const result = await runClaimedInference("payment-id", execute, record).catch(error => error);
    expect(result).toMatchObject({ code: "INFERENCE_EXECUTION_UNCERTAIN", details: { paymentId: "payment-id" } });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(record).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
  });

  it("successful execution returns its exact result without failure telemetry", async () => {
    const value = { result: "fixture" }, execute = vi.fn().mockResolvedValue(value), record = vi.fn(() => undefined);
    await expect(runClaimedInference("payment-id", execute, record)).resolves.toBe(value);
    expect(execute).toHaveBeenCalledOnce(); expect(record).not.toHaveBeenCalled();
  });

  it("copies only fixed typed error codes, never arbitrary fields", () => {
    expect(inferenceExecutionFailureCode(new AppError("NEAR_VERIFICATION_FAILED", "private"))).toBe("NEAR_VERIFICATION_FAILED");
    expect(inferenceExecutionFailureCode(new AppError("private-code", "private", 500, { secret: "private" }))).toBe("EXECUTION_FAILED");
    expect(inferenceExecutionFailureCode(Object.assign(new Error("private"), { code: "NEAR_VERIFICATION_FAILED" }))).toBe("EXECUTION_FAILED");
    expect(inferenceExecutionFailureCode(null)).toBe("EXECUTION_FAILED");
  });
});
