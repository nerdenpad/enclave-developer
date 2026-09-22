import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError, sha256Hex } from "@enclave/core";
import { createApp } from "./app.js";
import type { EnclaveGateway } from "./gateway.js";
import { createLogger } from "./logger.js";

const gateway = { rotateTcbPolicy: vi.fn(), activateTcbPolicy: vi.fn(), listModel: vi.fn() };
let app: ReturnType<typeof createApp>;
function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "admin", ...extra }, body: JSON.stringify(body) });
}
beforeEach(() => {
  Object.values(gateway).forEach((method) => method.mockReset().mockResolvedValue({ ok: true }));
  app = createApp(gateway as unknown as EnclaveGateway, createLogger("silent"));
});

describe("software TCB lifecycle HTTP contract", () => {
  it("forwards proposal version and stable idempotency identity", async () => {
    expect((await post("/v1/tcb/rotate", { servingImageId: "image-v2", version: 2 }, { "idempotency-key": "proposal-v2" })).status).toBe(201);
    expect(gateway.rotateTcbPolicy).toHaveBeenCalledExactlyOnceWith("admin", "image-v2", { version: 2, idempotencyKey: "proposal-v2" });
  });
  it("requires an explicit expected predecessor for activation", async () => {
    expect((await post("/v1/tcb/2/activate", { expectedActiveVersion: 1 }, { "idempotency-key": "activate-v2" })).status).toBe(200);
    expect(gateway.activateTcbPolicy).toHaveBeenCalledExactlyOnceWith("admin", 2, 1, "activate-v2");
  });
  it.each([["2", {}], ["x", { expectedActiveVersion: 1 }], ["0", { expectedActiveVersion: 1 }],
    ["2", { expectedActiveVersion: 0 }], ["2", { expectedActiveVersion: 1, hardwarePolicy: "override" }]])(
    "rejects invalid or additional activation fields %#", async (version, body) => {
      expect((await post(`/v1/tcb/${version}/activate`, body)).status).toBe(400);
      expect(gateway.activateTcbPolicy).not.toHaveBeenCalled();
    });
  it("preserves gateway authorization errors", async () => {
    gateway.activateTcbPolicy.mockRejectedValue(new UnauthorizedError("API key required"));
    expect((await post("/v1/tcb/2/activate", { expectedActiveVersion: 1 }, { "x-api-key": "" })).status).toBe(401);
    expect(gateway.activateTcbPolicy.mock.calls[0]![0]).toBe("");
  });
  it("passes a complete policy commitment to marketplace registration", async () => {
    const body = { modelHash: sha256Hex("model"), codeHash: sha256Hex("code"), version: "v2", policyHash: sha256Hex("policy"), policyVersion: 2 };
    expect((await post("/v1/marketplace/list", body, { "idempotency-key": "listing-v2" })).status).toBe(201);
    expect(gateway.listModel).toHaveBeenCalledExactlyOnceWith({ ...body, bps: 0, apiKey: "admin", idempotencyKey: "listing-v2" });
  });
  it.each([{ policyHash: sha256Hex("policy") }, { policyVersion: 2 }, { policyHash: "bad", policyVersion: 2 },
    { policyHash: sha256Hex("policy"), policyVersion: 2_147_483_648 }])("rejects partial or malformed marketplace commitments %#", async (binding) => {
    expect((await post("/v1/marketplace/list", { modelHash: sha256Hex("model"), codeHash: sha256Hex("code"), version: "v2", ...binding })).status).toBe(400);
    expect(gateway.listModel).not.toHaveBeenCalled();
  });
});
