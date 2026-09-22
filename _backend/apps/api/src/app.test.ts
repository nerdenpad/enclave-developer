import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, ForbiddenError, PaymentRequiredError, UnauthorizedError, sha256Hex } from "@enclave/core";
import { createApp } from "./app.js";
import type { EnclaveGateway } from "./gateway.js";
import { createLogger } from "./logger.js";
import type { AgentRuntime } from "./agent-runtime.js";

const uuid = "10000000-0000-4000-8000-000000000001";
const hash = sha256Hex("test");
const receipt = { receiptVersion: 2, nonce: sha256Hex("invocation"), modelHash: hash, codeHash: hash, inHash: hash, outHash: hash, attRef: hash, ts: 42n, sig: "0xab" };
const encryptedOutput = { iv: "output-iv", tag: "output-tag", ciphertext: "encrypted-result" };
const quote = { cpuQuote: "cpu", gpuQuote: "gpu", measurement: hash, tcbVersion: 1, timestamp: Date.now(), signature: "0xab" };
const inferBody = { sessionId: uuid, iv: "a", tag: "b", ciphertext: "c" };
const methods = ["sessionWrapKeyForOwner", "activateTcbPolicy", "health", "quote", "openSession", "sessionWrapKey", "infer", "settlePayment", "paymentAuthorization", "listChainEvents", "exportWithViewKey", "getPublicReceipt", "getPublicPayment", "agentSdkTools", "invokeAgentTool", "listModels", "solvency", "createAgent", "listAgents", "getAgent", "putAgentMemory", "stakeEncl", "unstakeEncl", "stakeStatus", "feeSplitPreview", "distributeFees", "listBuybacks", "listTcbPolicies", "rotateTcbPolicy", "listMarketplace", "listModel", "approveListing", "bootstrapApproveListing", "listingApprovalStatus", "revokeListing", "issueViewKey", "stakingRewards", "claimStakingRewards", "buybackStatus", "configureBuyback", "setBuybackReserve", "executeBuyback"] as const;
let gateway: Record<typeof methods[number], ReturnType<typeof vi.fn>>;
let app: ReturnType<typeof createApp>;
function post(path: string, body: unknown, headers = {}) { return app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "owner", ...headers }, body: JSON.stringify(body) }); }

beforeEach(() => {
  gateway = Object.fromEntries(methods.map((name) => [name, vi.fn().mockResolvedValue({})])) as typeof gateway;
  gateway.health.mockReturnValue({ ok: true, teeMode: "dev" });
  gateway.quote.mockResolvedValue(quote);
  gateway.openSession.mockResolvedValue({ sessionId: uuid, expiresAt: "later" });
  gateway.sessionWrapKey.mockReturnValue(Buffer.alloc(32, 1));
  gateway.sessionWrapKeyForOwner.mockResolvedValue(Buffer.alloc(32, 1));
  gateway.infer.mockResolvedValue({ receipt, typedHash: hash, outputHash: hash, output: encryptedOutput });
  gateway.listChainEvents.mockResolvedValue([{ blockNumber: 9007199254740993n }]);
  app = createApp(gateway as unknown as EnclaveGateway, createLogger("silent"));
});

describe("HTTP contracts", () => {
  it("mounts the optional runtime using the caller identity", async () => {
    const runtime = { list: vi.fn().mockResolvedValue([{ id: uuid, status: "queued" }]) };
    const withJobs = createApp(gateway as unknown as EnclaveGateway, createLogger("silent"), runtime as unknown as AgentRuntime);
    const result = await withJobs.request("/v1/agent-runs", { headers: { "x-api-key": "job-owner" } });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual([{ id: uuid, status: "queued" }]);
    expect(runtime.list).toHaveBeenCalledExactlyOnceWith("job-owner", undefined, 50);
  });
  it("does not release a wrapping key if policy admission changed after session creation", async () => {
    gateway.sessionWrapKeyForOwner.mockRejectedValue(new AppError("TCB_CHANGED", "Refresh attestation", 409));
    const response = await post("/v1/session", quote);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain(Buffer.alloc(32, 1).toString("base64"));
    expect(gateway.sessionWrapKey).not.toHaveBeenCalled();
  });
  it("separates a versioned proposal from compare-and-swap activation", async () => {
    expect((await post("/v1/tcb/rotate", { servingImageId: "next-image", version: 2 }, { "idempotency-key": "propose-two" })).status).toBe(201);
    expect(gateway.rotateTcbPolicy).toHaveBeenCalledExactlyOnceWith("owner", "next-image", { version: 2, idempotencyKey: "propose-two" });
    expect(gateway.activateTcbPolicy).not.toHaveBeenCalled();
    expect((await post("/v1/tcb/2/activate", { expectedActiveVersion: 1 }, { "idempotency-key": "activate-two" })).status).toBe(200);
    expect(gateway.activateTcbPolicy).toHaveBeenCalledExactlyOnceWith("owner", 2, 1, "activate-two");
  });
  it.each([
    ["zero", { expectedActiveVersion: 1 }], ["0", { expectedActiveVersion: 1 }], ["2.5", { expectedActiveVersion: 1 }],
    ["2147483648", { expectedActiveVersion: 1 }], ["2", {}], ["2", { expectedActiveVersion: 0 }],
    ["2", { expectedActiveVersion: 1, policyHash: hash }],
  ])("rejects invalid activation before invoking the gateway %#", async (version, body) => {
    expect((await post(`/v1/tcb/${version}/activate`, body)).status).toBe(400);
    expect(gateway.activateTcbPolicy).not.toHaveBeenCalled();
  });
  it("passes policy-aware listing and its replay key together", async () => {
    const input = { modelHash: hash, codeHash: hash, policyHash: hash, policyVersion: 2, version: "v2", bps: 100 };
    expect((await post("/v1/marketplace/list", input, { "idempotency-key": "listing-two" })).status).toBe(201);
    expect(gateway.listModel).toHaveBeenCalledExactlyOnceWith({ apiKey: "owner", ...input, idempotencyKey: "listing-two" });
  });
  it.each([{ policyHash: hash }, { policyVersion: 2 }])("requires both policy commitment fields %#", async (partial) => {
    expect((await post("/v1/marketplace/list", { modelHash: hash, codeHash: hash, version: "v2", ...partial })).status).toBe(400);
    expect(gateway.listModel).not.toHaveBeenCalled();
  });
  it.each([
    ["POST", "/v1/stake", "stakeEncl", { amountWei: "1" }],
    ["POST", "/v1/unstake", "unstakeEncl", { amountWei: "1" }],
    ["POST", "/v1/fees/distribute", "distributeFees", {}],
    ["POST", "/v1/stake/rewards/claim", "claimStakingRewards", {}],
    ["POST", "/v1/buyback/configure", "configureBuyback", { router: "0x0000000000000000000000000000000000000100", tokenOut: "0x0000000000000000000000000000000000000200", recipient: "0x0000000000000000000000000000000000000300" }],
    ["POST", "/v1/buyback/reserve", "setBuybackReserve", { treasuryBps: 1000 }],
    ["POST", "/v1/buyback/execute", "executeBuyback", { amountUnits: "100", minOut: "1", deadline: "1800000000" }],
    ["POST", "/v1/tcb/rotate", "rotateTcbPolicy", { servingImageId: "image" }],
    ["POST", "/v1/marketplace/1/approve", "approveListing", {}],
    ["POST", "/v1/marketplace/1/bootstrap-approve", "bootstrapApproveListing", {}],
    ["POST", "/v1/marketplace/1/revoke", "revokeListing", {}],
    ["POST", "/v1/compliance/view-keys", "issueViewKey", { label: "auditor" }],
    ["POST", "/v1/agent-sdk/invoke", "invokeAgentTool", { tool: "enclave_infer", input: inferBody }],
    ["GET", "/v1/agents", "listAgents", undefined],
    ["GET", `/v1/agents/${uuid}`, "getAgent", undefined],
    ["GET", "/v1/stake", "stakeStatus", undefined],
    ["GET", "/v1/fees/split", "feeSplitPreview", undefined],
    ["GET", "/v1/buyback", "listBuybacks", undefined],
    ["GET", "/v1/stake/rewards", "stakingRewards", undefined],
    ["GET", "/v1/buyback/status", "buybackStatus", undefined],
  ] as const)("does not invent a caller identity for unauthenticated %s %s", async (method, route, operation, body) => {
    gateway[operation].mockRejectedValue(new UnauthorizedError("API key required"));
    const res = await app.request(route, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    expect(res.status).toBe(401);
    expect(gateway[operation].mock.calls[0]?.[0]).toBe("");
  });
  it("forwards the exact signed authorization after validating the HTTP schema", async () => {
    const authorization = { from: "0x0000000000000000000000000000000000000100", validAfter: "0", validBefore: "1800000000", signature: `0x${"11".repeat(65)}` };
    expect((await post("/v1/x402/settle", { paymentId: uuid, authorization })).status).toBe(200);
    expect(gateway.settlePayment).toHaveBeenCalledExactlyOnceWith("owner", uuid, false, authorization);
  });
  it("uses a validated body payment ID when a conflicting header is supplied", async () => {
    expect((await post("/v1/inference", { ...inferBody, paymentId: uuid }, { "x-payment": "invalid" })).status).toBe(200);
    expect(gateway.infer).toHaveBeenCalledWith(expect.objectContaining({ paymentId: uuid }));
  });
  it("returns an authorized receipt including its original verification domain", async () => {
    const row = { typedHash: hash, receiptVersion: 2, nonce: receipt.nonce, chainId: 31337, verifierAddress: "0x0000000000000000000000000000000000000100" };
    gateway.exportWithViewKey.mockResolvedValue({ receipts: [row] });
    const response = await app.request(`/v1/receipts/${hash}`, { headers: { "x-view-key": "auditor" } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(row);
  });
  it("rejects a payment absent from an otherwise valid auditor export", async () => {
    gateway.exportWithViewKey.mockResolvedValue({ payments: [] });
    expect((await app.request(`/v1/payments/${uuid}`, { headers: { "x-view-key": "auditor" } })).status).toBe(404);
    expect(gateway.getPublicPayment).not.toHaveBeenCalled();
  });
  it.each([
    [`/v1/agents/${uuid}/memory`, { ...inferBody, sessionId: "invalid", iv: "" }],
    ["/v1/unstake", { amountWei: "1.5" }],
    ["/v1/tcb/rotate", { servingImageId: "" }],
    ["/v1/agent-sdk/invoke", { tool: "", input: {} }],
  ])("rejects malformed domain input on %s", async (route, body) => {
    expect((await post(route as string, body)).status).toBe(400);
  });
  it("does not interpret the marketplace list route as a numeric listing id", async () => {
    const body = { modelHash: hash, codeHash: hash, version: "v1" };
    expect((await post("/v1/marketplace/list", body)).status).toBe(201);
    expect(gateway.listModel).toHaveBeenCalledWith({ apiKey: "owner", ...body, bps: 0 });
  });
  it.each(["not-an-id", "0", "-1", "1.5", "2147483648"])("rejects invalid listing id %s", async (id) => {
    expect((await post(`/v1/marketplace/${id}/approve`, {})).status).toBe(400);
    expect(gateway.approveListing).not.toHaveBeenCalled();
  });
  it.each(["/v1/agents/bad", "/v1/payments/bad"])("rejects invalid UUID path %s", async (route) => {
    expect((await app.request(route)).status).toBe(400);
  });
  it("opens a session only after quote validation and serializes its wrap key", async () => {
    const res = await post("/v1/session", quote);
    expect(res.status).toBe(201);
    expect(gateway.openSession).toHaveBeenCalledWith("owner", quote);
    expect(gateway.sessionWrapKeyForOwner).toHaveBeenCalledWith("owner", uuid);
    expect(gateway.sessionWrapKey).not.toHaveBeenCalled();
    expect((await res.json()).wrapKey).toBe(Buffer.alloc(32, 1).toString("base64"));
  });
  it.each([uuid, JSON.stringify({ paymentId: uuid }), JSON.stringify({ extra: { paymentId: uuid } })])("supports payment transport %s", async (token) => {
    const res = await post("/v1/inference", inferBody, { "x-payment": token, "idempotency-key": "retry" });
    expect(res.status).toBe(200);
    expect(gateway.infer).toHaveBeenCalledWith(expect.objectContaining({ paymentId: uuid, idempotencyKey: "retry" }));
    expect((await res.json()).receipt.ts).toBe("42");
  });
  it.each(["null", "{}", "[]", '{"paymentId":42}', "garbage", '"not-a-uuid"'])("rejects malformed payment header %s before gateway", async (token) => {
    expect((await post("/v1/inference", inferBody, { "x-payment": token })).status).toBe(400);
    expect(gateway.infer).not.toHaveBeenCalled();
  });
  it("keeps the x402 challenge on HTTP 402", async () => {
    const challenge = { accepts: [{ extra: { paymentId: uuid } }] };
    gateway.infer.mockRejectedValue(new PaymentRequiredError("pay", challenge));
    const res = await post("/v1/inference", inferBody);
    expect(res.status).toBe(402);
    expect((await res.json()).details).toEqual(challenge);
  });
  it("returns the encrypted result and the v2 nonce without exposing plaintext", async () => {
    const response = await post("/v1/inference", inferBody, { "x-payment": uuid });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ output: encryptedOutput, receipt: { receiptVersion: 2, nonce: receipt.nonce, ts: "42" } });
  });

  it("returns owner-scoped USDC authorization typed data for the chosen payer", async () => {
    const payer = "0x0000000000000000000000000000000000000100";
    const result = { paymentId: uuid, mode: "authorized", typedData: { primaryType: "ReceiveWithAuthorization", message: { value: "100000" } } };
    gateway.paymentAuthorization.mockResolvedValue(result);
    const response = await app.request(`/v1/payments/${uuid}/authorization?from=${payer}`, { headers: { "x-api-key": "owner" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(gateway.paymentAuthorization).toHaveBeenCalledExactlyOnceWith("owner", uuid, payer);
  });

  it.each([
    `/v1/payments/${uuid}/authorization`,
    `/v1/payments/${uuid}/authorization?from=bad`,
    `/v1/payments/not-a-uuid/authorization?from=0x0000000000000000000000000000000000000100`,
  ])("rejects malformed authorization request %s", async (route) => {
    expect((await app.request(route)).status).toBe(400);
    expect(gateway.paymentAuthorization).not.toHaveBeenCalled();
  });

  it("preserves owner and payment-state errors from authorization lookup", async () => {
    const route = `/v1/payments/${uuid}/authorization?from=0x0000000000000000000000000000000000000100`;
    for (const status of [401, 404, 409]) {
      gateway.paymentAuthorization.mockRejectedValue(new AppError("DENIED", "denied", status));
      expect((await app.request(route)).status).toBe(status);
    }
  });
  it.each(["/v1/session", "/v1/inference", "/v1/agents", "/v1/x402/settle", "/v1/compliance/view-keys", "/v1/tcb/rotate", "/v1/stake", "/v1/unstake", "/v1/marketplace/list", "/v1/agent-sdk/invoke", "/v1/buyback/configure", "/v1/buyback/reserve", "/v1/buyback/execute"])("rejects invalid JSON at %s", async (route) => {
    const res = await app.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: "{broken" });
    expect(res.status).toBe(400);
    expect((await res.json()).title).toBe("VALIDATION_FAILED");
  });
  it.each([
    ["/v1/session", { ...quote, measurement: "bad" }],
    ["/v1/inference", { ...inferBody, sessionId: "bad" }],
    ["/v1/x402/settle", { paymentId: uuid, confidential: "false" }],
    ["/v1/agents", { name: "agent", dailyLimitUsdc: 1, iv: "partial" }],
    ["/v1/agents", { name: "agent", dailyLimitUsdc: -1 }],
    ["/v1/agents", { name: "agent", dailyLimitUsdc: 1, iv: "a", tag: "b", ciphertext: "c" }],
    ["/v1/stake", { amountWei: "-1" }],
    ["/v1/marketplace/list", { modelHash: hash, codeHash: hash, version: "v1", bps: 10001 }],
    ["/v1/compliance/view-keys", { label: "" }],
  ])("validates request schema at %s", async (route, body) => { expect((await post(route as string, body)).status).toBe(400); });
  it.each(["-1", "0", "1.5", "101", "Infinity", "abc"])("rejects invalid event limit %s", async (limit) => {
    expect((await app.request(`/v1/chain/events?limit=${limit}`)).status).toBe(400);
    expect(gateway.listChainEvents).not.toHaveBeenCalled();
  });
  it("serializes chain block numbers without precision loss", async () => {
    const res = await app.request("/v1/chain/events?limit=20");
    expect(gateway.listChainEvents).toHaveBeenCalledWith(20);
    expect((await res.json())[0].blockNumber).toBe("9007199254740993");
  });
  it.each(["-1", "1.5", "abc", "Infinity"])("rejects fee amount %s as 400", async (amount) => {
    expect((await app.request(`/v1/fees/split?amount=${amount}`)).status).toBe(400);
  });
  it("does not expose internal error messages", async () => {
    gateway.quote.mockRejectedValue(new Error("database-password-secret"));
    const res = await app.request("/v1/attestation/quote");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("database-password-secret");
  });
  it.each([401, 403, 404, 409, 503])("preserves application status %s", async (status) => {
    gateway.quote.mockRejectedValue(new AppError("TEST", "public error", status));
    expect((await app.request("/v1/attestation/quote")).status).toBe(status);
  });
  it("uses owner-scoped export for auditor receipt lookup", async () => {
    gateway.exportWithViewKey.mockResolvedValue({ receipts: [], payments: [] });
    const res = await app.request(`/v1/receipts/${hash}`, { headers: { "x-view-key": "auditor" } });
    expect(res.status).toBe(404);
    expect(gateway.getPublicReceipt).not.toHaveBeenCalled();
  });
  it("never falls back to public payment on invalid view-key", async () => {
    gateway.exportWithViewKey.mockRejectedValue(new ForbiddenError("Invalid view key"));
    expect((await app.request(`/v1/payments/${uuid}`, { headers: { "x-view-key": "bad" } })).status).toBe(403);
    expect(gateway.getPublicPayment).not.toHaveBeenCalled();
  });
  it("returns auditor payment only when present in scoped export", async () => {
    gateway.exportWithViewKey.mockResolvedValue({ payments: [{ id: uuid, amountUnits: "100" }] });
    expect(await (await app.request(`/v1/payments/${uuid}`, { headers: { "x-view-key": "auditor" } })).json()).toEqual({ id: uuid, amountUnits: "100" });
  });

  it("keeps timed approval and explicitly enabled local bootstrap on separate routes", async () => {
    expect((await post("/v1/marketplace/12/approve", {})).status).toBe(200);
    expect(gateway.approveListing).toHaveBeenCalledExactlyOnceWith("owner", 12);
    expect(gateway.bootstrapApproveListing).not.toHaveBeenCalled();
    expect((await post("/v1/marketplace/12/bootstrap-approve", {})).status).toBe(200);
    expect(gateway.bootstrapApproveListing).toHaveBeenCalledExactlyOnceWith("owner", 12);
    gateway.listingApprovalStatus.mockResolvedValue({ state: "pending", availableAt: "1800003600" });
    const status = await app.request("/v1/marketplace/12/approval");
    expect(await status.json()).toEqual({ state: "pending", availableAt: "1800003600" });
    expect(gateway.listingApprovalStatus).toHaveBeenCalledExactlyOnceWith(12);
  });

  it("forwards caller identity to staking reward and buyback status operations", async () => {
    expect((await app.request("/v1/stake/rewards", { headers: { "x-api-key": "owner" } })).status).toBe(200);
    expect(gateway.stakingRewards).toHaveBeenCalledExactlyOnceWith("owner");
    expect((await post("/v1/stake/rewards/claim", {})).status).toBe(200);
    expect(gateway.claimStakingRewards).toHaveBeenCalledExactlyOnceWith("owner");
    expect((await app.request("/v1/buyback/status", { headers: { "x-api-key": "owner" } })).status).toBe(200);
    expect(gateway.buybackStatus).toHaveBeenCalledExactlyOnceWith("owner");
  });

  it("forwards validated buyback configuration and reserves", async () => {
    const input = { router: "0x0000000000000000000000000000000000000100", tokenOut: "0x0000000000000000000000000000000000000200", recipient: "0x0000000000000000000000000000000000000300" };
    expect((await post("/v1/buyback/configure", input)).status).toBe(200);
    expect(gateway.configureBuyback).toHaveBeenCalledExactlyOnceWith("owner", input);
    expect((await post("/v1/buyback/reserve", { treasuryBps: 1000 })).status).toBe(200);
    expect(gateway.setBuybackReserve).toHaveBeenCalledExactlyOnceWith("owner", 1000);
  });

  it("preserves bigint execution amount, slippage floor and deadline", async () => {
    const amount = (10n ** 24n + 1n).toString();
    expect((await post("/v1/buyback/execute", { amountUnits: amount, minOut: "999", deadline: "1800000000" })).status).toBe(200);
    expect(gateway.executeBuyback).toHaveBeenCalledExactlyOnceWith("owner", { amountUnits: BigInt(amount), minOut: 999n, deadline: 1800000000n });
  });

  it.each([
    ["/v1/buyback/configure", { router: "0x0000000000000000000000000000000000000000", tokenOut: "bad", recipient: "bad" }],
    ["/v1/buyback/reserve", { treasuryBps: -1 }], ["/v1/buyback/reserve", { treasuryBps: 1001 }],
    ["/v1/buyback/reserve", { treasuryBps: 1.5 }],
    ["/v1/buyback/execute", { amountUnits: "0", minOut: "1", deadline: "1" }],
    ["/v1/buyback/execute", { amountUnits: "1", minOut: "0", deadline: "1" }],
    ["/v1/buyback/execute", { amountUnits: (1n << 256n).toString(), minOut: "1", deadline: "1" }],
  ])("rejects invalid economic operation at %s", async (path, input) => {
    expect((await post(path as string, input)).status).toBe(400);
    expect(gateway.executeBuyback).not.toHaveBeenCalled();
    expect(gateway.configureBuyback).not.toHaveBeenCalled();
    expect(gateway.setBuybackReserve).not.toHaveBeenCalled();
  });
});
