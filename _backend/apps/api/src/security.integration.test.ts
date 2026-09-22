import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { apiKeys, createDb, payments, usage, mandates, receipts, sessions, agents } from "@enclave/db";
import { decryptAesGcm, encryptAesGcm, sha256Hex } from "@enclave/core";
import { EnclaveGateway } from "./gateway.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import * as chain from "./chain.js";

describe("Postgres gateway security and concurrency", () => {
  const owner = `owner-${randomUUID()}`;
  const other = `other-${randomUUID()}`;
  const ownerHash = sha256Hex(owner);
  const log = createLogger("silent");
  let db: ReturnType<typeof createDb>["db"];
  let sql: ReturnType<typeof createDb>["sql"];
  let gateway: EnclaveGateway;
  let app: ReturnType<typeof createApp>;
  let sessionId: string;
  let wrapKey: Buffer;
  const cfg = loadConfig();
  // Keep DB and CVM real; isolate payment tests from the shared deployer nonce.
  const simulated = { ...cfg, USAGE_METER_ADDRESS: "0x0000000000000000000000000000000000000004", AGENT_MANDATE_ADDRESS: "0x0000000000000000000000000000000000000008" };
  beforeAll(async () => {
    ({ db, sql } = createDb(cfg.DATABASE_URL));
    await db.insert(apiKeys).values([{ keyHash: ownerHash, label: "security-owner" }, { keyHash: sha256Hex(other), label: "security-other" }]);
    gateway = await EnclaveGateway.boot(db, simulated, log, undefined);
    app = createApp(gateway, log);
    const session = await gateway.openSession(owner, await gateway.quote());
    sessionId = session.sessionId;
    wrapKey = gateway.sessionWrapKey(sessionId);
  });
  afterAll(async () => { vi.restoreAllMocks(); await sql?.end({ timeout: 5 }); });

  const payload = (prompt: string = randomUUID()) => ({ sessionId, ...encryptAesGcm(wrapKey, Buffer.from(prompt)) });
  async function post(route: string, body: unknown, apiKey = owner, headers = {}) {
    const response = await app.request(route, { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function paidIntent(body: ReturnType<typeof payload>, idem?: string) {
    const res = await post("/v1/inference", body, owner, idem ? { "idempotency-key": idem } : {});
    expect(res.status).toBe(402);
    const id = res.body.details.accepts[0].extra.paymentId as string;
    expect((await post("/v1/x402/settle", { paymentId: id })).status).toBe(200);
    return id;
  }

  it.each([
    ["/v1/tcb/rotate", { servingImageId: "untrusted" }],
    ["/v1/marketplace/1/approve", {}], ["/v1/marketplace/1/revoke", {}],
    ["/v1/stake", { amountWei: "1" }], ["/v1/unstake", { amountWei: "1" }],
    ["/v1/fees/distribute", {}],
    ["/v1/marketplace/1/bootstrap-approve", {}],
    ["/v1/stake/rewards/claim", {}],
    ["/v1/buyback/reserve", { treasuryBps: 1000 }],
    ["/v1/buyback/execute", { amountUnits: "1", minOut: "1", deadline: "1800000000" }],
    ["/v1/buyback/configure", { router: "0x0000000000000000000000000000000000000100", tokenOut: "0x0000000000000000000000000000000000000200", recipient: "0x0000000000000000000000000000000000000300" }],
    ["/v1/marketplace/list", { modelHash: sha256Hex("model"), codeHash: sha256Hex("code"), version: "v1" }],
  ])("requires admin for %s before shared-wallet operations", async (route, body) => {
    expect((await post(route as string, body)).status).toBe(403);
  });
  it("rejects another owner's session before opening any payment", async () => {
    const before = await db.select().from(payments).where(eq(payments.keyHash, sha256Hex(other)));
    expect((await post("/v1/inference", payload(), other)).status).toBe(401);
    expect(await db.select().from(payments).where(eq(payments.keyHash, sha256Hex(other)))).toHaveLength(before.length);
  });
  it("cannot settle or consume another owner's payment", async () => {
    const body = payload();
    const id = await paidIntent(body);
    expect((await post("/v1/x402/settle", { paymentId: id }, other)).status).toBe(404);
    const otherSession = await gateway.openSession(other, await gateway.quote());
    const otherBody = { sessionId: otherSession.sessionId, ...encryptAesGcm(gateway.sessionWrapKey(otherSession.sessionId), Buffer.from("foreign")), paymentId: id };
    expect((await post("/v1/inference", otherBody, other)).status).toBe(404);
    expect((await db.select().from(payments).where(eq(payments.id, id)))[0]?.status).toBe("settled");
  });
  it("creates a single challenge for concurrent identical intents", async () => {
    const idem = randomUUID(); const body = payload();
    const responses = await Promise.all(Array.from({ length: 8 }, () => post("/v1/inference", body, owner, { "idempotency-key": idem })));
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(402));
    expect(new Set(responses.map((r) => r.body.details.accepts[0].extra.paymentId)).size).toBe(1);
    expect(await db.select().from(payments).where(and(eq(payments.keyHash, ownerHash), eq(payments.intentKey, idem)))).toHaveLength(1);
  });
  it("concurrent paid retries return one receipt and charge usage once", async () => {
    const idem = randomUUID(); const body = payload(); const id = await paidIntent(body, idem);
    const before = (await db.select().from(usage).where(eq(usage.keyHash, ownerHash)))[0]?.calls ?? 0;
    const responses = await Promise.all(Array.from({ length: 6 }, () => post("/v1/inference", { ...body, paymentId: id }, owner, { "idempotency-key": idem })));
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(new Set(responses.map((r) => r.body.typedHash)).size).toBe(1);
    expect((await db.select().from(usage).where(eq(usage.keyHash, ownerHash)))[0]?.calls).toBe(before + 1);
    expect((await db.select().from(payments).where(eq(payments.id, id)))[0]?.status).toBe("consumed");
    const output = decryptAesGcm(wrapKey, responses[0]!.body.output);
    expect(sha256Hex(output)).toBe(responses[0]!.body.receipt.outHash);
    expect(responses.every((response) => JSON.stringify(response.body.output) === JSON.stringify(responses[0]!.body.output))).toBe(true);
  });

  it("rejects changed plaintext under both a pending and a completed idempotency key", async () => {
    const idem = randomUUID();
    const body = payload("original bound request");
    const changed = payload("different request");
    const id = await paidIntent(body, idem);
    expect((await post("/v1/inference", changed, owner, { "idempotency-key": idem })).status).toBe(409);
    expect((await post("/v1/inference", { ...changed, paymentId: id })).status).toBe(409);
    const first = await post("/v1/inference", { ...body, paymentId: id }, owner, { "idempotency-key": idem });
    expect(first.status).toBe(200);
    expect((await post("/v1/inference", { ...changed, paymentId: id }, owner, { "idempotency-key": idem })).status).toBe(409);
    const reencrypted = payload("original bound request");
    const replay = await post("/v1/inference", { ...reencrypted, paymentId: id }, owner, { "idempotency-key": idem });
    expect(replay.status).toBe(200);
    expect(replay.body.typedHash).toBe(first.body.typedHash);
  });

  it("binds a payment to the requested agent and its sealed memory", async () => {
    const first = await gateway.createAgent({ apiKey: owner, name: "bound-agent", dailyLimitUsdc: 1 });
    const second = await gateway.createAgent({ apiKey: owner, name: "different-agent", dailyLimitUsdc: 1 });
    const body = { ...payload("agent request"), agentId: first.id };
    const id = await paidIntent(body);
    expect((await post("/v1/inference", { ...body, agentId: second.id, paymentId: id })).status).toBe(409);
    await gateway.putAgentMemory({ apiKey: owner, agentId: first.id, sessionId, blob: encryptAesGcm(wrapKey, Buffer.from("new agent memory")) });
    expect((await post("/v1/inference", { ...body, paymentId: id })).status).toBe(409);
    expect((await db.select().from(payments).where(eq(payments.id, id)))[0]?.status).toBe("settled");
  });

  it("rejects reuse when the server-owned agent policy hash changes", async () => {
    const agent = await gateway.createAgent({ apiKey: owner, name: "policy-bound", dailyLimitUsdc: 1 });
    const body = { ...payload(), agentId: agent.id };
    const id = await paidIntent(body);
    await db.update(agents).set({ policyHash: sha256Hex("updated policy") }).where(eq(agents.id, agent.id));
    expect((await post("/v1/inference", { ...body, paymentId: id })).status).toBe(409);
  });

  it("keeps receipt provenance tied to the caller's session after another quote is verified", async () => {
    const originalQuote = await gateway.quote();
    const original = await gateway.openSession(owner, originalQuote);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
    const newerQuote = await gateway.quote();
    clock.mockRestore();
    await gateway.openSession(owner, newerQuote);
    expect(sha256Hex(originalQuote.signature)).not.toBe(sha256Hex(newerQuote.signature));
    const key = gateway.sessionWrapKey(original.sessionId);
    const body = { sessionId: original.sessionId, ...encryptAesGcm(key, Buffer.from("older session")) };
    const id = await paidIntent(body);
    const result = await post("/v1/inference", { ...body, paymentId: id });
    expect(result.status).toBe(200);
    expect(result.body.receipt.attRef).toBe(sha256Hex(originalQuote.signature));
    expect(sha256Hex(decryptAesGcm(key, result.body.output))).toBe(result.body.outputHash);
  });

  it("restores a persisted valid session after a gateway reboot", async () => {
    const body = payload("survives a gateway restart");
    const id = await paidIntent(body);
    const restarted = await EnclaveGateway.boot(db, simulated, log, undefined);
    const result = await restarted.infer({ apiKey: owner, sessionId, blob: body, paymentId: id });
    expect(result.receipt.receiptVersion).toBe(2);
    expect(restarted.sessionWrapKey(sessionId)).toEqual(wrapKey);
    expect(result.output).toBeDefined();
    expect(sha256Hex(decryptAesGcm(wrapKey, result.output!))).toBe(result.receipt.outHash);
    const stored = (await db.select().from(receipts).where(eq(receipts.typedHash, result.typedHash)))[0]!;
    expect(stored.receiptVersion).toBe(2);
    expect(stored.nonce).toBe(result.receipt.receiptVersion === 2 ? result.receipt.nonce : undefined);
    expect(stored.chainId).toBe(cfg.ARC_CHAIN_ID);
    expect(stored.verifierAddress).toBe(cfg.ATTESTATION_VERIFIER_ADDRESS);
    expect(JSON.parse(stored.outputJson!)).toEqual(result.output);
  });

  it("returns a local model completion encrypted through REST and the agent SDK", async () => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { content: string }[] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: `local model answer: ${input.messages[0]?.content}` } }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP test port");
    try {
      const local = await EnclaveGateway.boot(db, { ...simulated, INFERENCE_BACKEND: "openai-compatible", INFERENCE_MODEL: "echo", INFERENCE_BASE_URL: `http://127.0.0.1:${address.port}/v1` }, log, undefined);
      const localApp = createApp(local, log);
      const session = await local.openSession(owner, await local.quote());
      const key = local.sessionWrapKey(session.sessionId);
      const body = { sessionId: session.sessionId, ...encryptAesGcm(key, Buffer.from("private local question")) };
      const send = async (route: string, value: unknown) => {
        const response = await localApp.request(route, { method: "POST", headers: { "content-type": "application/json", "x-api-key": owner }, body: JSON.stringify(value) });
        return { status: response.status, body: await response.json() };
      };
      const challenge = await send("/v1/inference", body);
      expect(challenge.status).toBe(402);
      const id = challenge.body.details.accepts[0].extra.paymentId as string;
      expect((await send("/v1/x402/settle", { paymentId: id })).status).toBe(200);
      const result = await send("/v1/agent-sdk/invoke", { tool: "enclave_infer", input: { ...body, paymentId: id } });
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).not.toContain("private local question");
      const output = decryptAesGcm(key, result.body.output);
      expect(output.toString()).toBe("local model answer: private local question");
      expect(sha256Hex(output)).toBe(result.body.receipt.outHash);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });
  it("cannot spend one payment twice with different idempotency keys", async () => {
    const body = payload(); const id = await paidIntent(body);
    const responses = await Promise.all([1,2].map(() => post("/v1/inference", { ...body, paymentId: id }, owner, { "idempotency-key": randomUUID() })));
    expect(responses.map((r) => r.status).sort()).toEqual([200,402]);
  });
  it("distinct paid calls with identical inputs in one second receive independent v2 receipts", async () => {
    const body = payload(); const first = await paidIntent(body); const second = await paidIntent(body);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const responses = await Promise.all([first, second].map((paymentId) => post("/v1/inference", { ...body, paymentId })));
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(new Set(responses.map((response) => response.body.typedHash)).size).toBe(2);
      expect(new Set(responses.map((response) => response.body.receipt.nonce)).size).toBe(2);
      expect(responses.every((response) => response.body.receipt.receiptVersion === 2)).toBe(true);
      expect((await db.select().from(payments).where(eq(payments.id, second)))[0]?.status).toBe("consumed");
    } finally { vi.restoreAllMocks(); }
  });
  it("invalid ciphertext leaves settled payment reusable without spending its mandate twice", async () => {
    const agent = await gateway.createAgent({ apiKey: owner, name: "rollback", dailyLimitUsdc: 1 });
    const body = { ...payload(), agentId: agent.id }; const id = await paidIntent(body);
    const result = await post("/v1/inference", { ...body, paymentId: id, tag: Buffer.alloc(16).toString("base64") });
    expect(result.status).toBe(400);
    expect((await db.select().from(payments).where(eq(payments.id, id)))[0]?.status).toBe("settled");
    expect((await db.select().from(mandates).where(eq(mandates.agent, agent.id)))[0]?.spentTodayUnits).toBe(100000n);
    expect((await post("/v1/inference", { ...body, paymentId: id })).status).toBe(200);
    expect((await db.select().from(mandates).where(eq(mandates.agent, agent.id)))[0]?.spentTodayUnits).toBe(100000n);
  });
  it("serializes simultaneous mandate reservations at the daily limit", async () => {
    const agent = await gateway.createAgent({ apiKey: owner, name: "limited", dailyLimitUsdc: 0.1 });
    const bodies = [1,2].map(() => ({ ...payload(), agentId: agent.id }));
    const challenges = await Promise.all(bodies.map((body) => post("/v1/inference", body)));
    expect(challenges.map((result) => result.status)).toEqual([402, 402]);
    const ids = challenges.map((result) => result.body.details.accepts[0].extra.paymentId as string);
    const settlements = await Promise.all(ids.map((paymentId) => post("/v1/x402/settle", { paymentId })));
    expect(settlements.map((result) => result.status).sort()).toEqual([200,403]);
    const accepted = settlements.findIndex((result) => result.status === 200);
    const denied = accepted === 0 ? 1 : 0;
    expect((await post("/v1/inference", { ...bodies[accepted], paymentId: ids[accepted] })).status).toBe(200);
    expect((await db.select().from(payments).where(eq(payments.id, ids[denied]!)))[0]?.status).toBe("open");
    expect((await db.select().from(mandates).where(eq(mandates.agent, agent.id)))[0]?.spentTodayUnits).toBe(100000n);
  });
  it("view keys reveal only their issuing owner's records and never store the secret", async () => {
    const vk = await gateway.issueViewKey(other, "foreign auditor");
    const exported = await gateway.exportWithViewKey(vk.secret);
    expect(exported.receipts).toHaveLength(0);
    expect(exported.payments).toHaveLength(0);
    const ownerReceipt = (await db.select().from(receipts).where(eq(receipts.keyHash, ownerHash)))[0]!;
    expect((await app.request(`/v1/receipts/${ownerReceipt.typedHash}`, { headers: { "x-view-key": vk.secret } })).status).toBe(404);
  });
  it("agent records and memory writes enforce ownership", async () => {
    const agent = await gateway.createAgent({ apiKey: owner, name: "private", dailyLimitUsdc: 1 });
    await expect(gateway.getAgent(other, agent.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await post(`/v1/agents/${agent.id}/memory`, payload(), other)).status).toBe(404);
  });
  it("creates agents locally and defers chain mandate initialization until settlement", async () => {
    const realGateway = await EnclaveGateway.boot(db, cfg, log, undefined);
    const name = `deferred-${randomUUID()}`;
    const open = vi.fn().mockRejectedValue(new Error("chain revert"));
    const factory = vi.spyOn(chain, "createMandator").mockReturnValue({ open, spend: vi.fn() });
    try {
      const agent = await realGateway.createAgent({ apiKey: owner, name, dailyLimitUsdc: 1 });
      expect(await db.select().from(agents).where(eq(agents.name, name))).toHaveLength(1);
      expect(await db.select().from(mandates).where(eq(mandates.agent, agent.id))).toHaveLength(1);
      expect(factory).not.toHaveBeenCalled();
      const challenge = await post("/v1/inference", { ...payload(), agentId: agent.id });
      expect(challenge.status).toBe(402);
      const id = challenge.body.details.accepts[0].extra.paymentId as string;
      await expect(realGateway.settlePayment(owner, id)).rejects.toThrow("chain revert");
      expect(open).toHaveBeenCalledExactlyOnceWith(agent.id, 1_000_000n);
      expect((await db.select().from(payments).where(eq(payments.id, id)))[0]?.status).toBe("settlement_unknown");
    } finally { vi.restoreAllMocks(); }
  });
  it("serializes concurrent TCB rotations without duplicate policy versions", async () => {
    const admin = `admin-${randomUUID()}`;
    await db.insert(apiKeys).values({ keyHash: sha256Hex(admin), label: "rotation-admin", role: "admin" });
    const result = await Promise.all(["image-a", "image-b", "image-c"].map((image) => gateway.rotateTcbPolicy(admin, image)));
    expect(new Set(result.map((value) => value.recorded.version)).size).toBe(3);
    expect((await gateway.listTcbPolicies()).active.version).toBe(1);
  });
  it("rejects sessions expiring exactly now", async () => {
    const session = await gateway.openSession(owner, await gateway.quote());
    const now = Date.now(); await db.update(sessions).set({ expiresAt: new Date(now) }).where(eq(sessions.id, session.sessionId));
    vi.spyOn(Date, "now").mockReturnValue(now);
    try { await expect(gateway.infer({ apiKey: owner, sessionId: session.sessionId, blob: encryptAesGcm(wrapKey, Buffer.from("expiry")) })).rejects.toMatchObject({ statusCode: 401 }); }
    finally { vi.restoreAllMocks(); }
  });
  it("rejects concurrent settlement claims and preserves uncertain chain state", async () => {
    const realGateway = await EnclaveGateway.boot(db, cfg, log, undefined);
    const body = payload();
    const challenge = await post("/v1/inference", body);
    const id = challenge.body.details.accepts[0].extra.paymentId as string;
    let fail!: (err: Error) => void;
    let submitted!: () => void;
    const started = new Promise<void>((resolve) => { submitted = resolve; });
    const facilitator = chain.createFacilitator(cfg, db);
    const settle = vi.fn<typeof facilitator.settle>(() => { submitted(); return new Promise<`0x${string}`>((_resolve, reject) => { fail = reject; }); });
    vi.spyOn(chain, "createFacilitator").mockReturnValue({ payer: facilitator.payer, settle });
    const first = realGateway.settlePayment(owner, id).catch((err: unknown) => err);
    try {
      await Promise.race([started, first.then((result) => { throw result instanceof Error ? result : new Error("Settlement finished before RPC submission"); })]);
      await expect(realGateway.settlePayment(owner, id)).rejects.toMatchObject({ statusCode: 409 });
      expect(settle).toHaveBeenCalledTimes(1);
      fail(new Error("RPC confirmation timeout"));
      expect(await first).toBeInstanceOf(Error);
      expect((await db.select().from(payments).where(eq(payments.id, id)))[0]?.status).toBe("settlement_unknown");
      settle.mockImplementationOnce((...args) => facilitator.settle(...args));
      await expect(realGateway.settlePayment(owner, id)).resolves.toMatchObject({ paymentId: id });
      expect(settle).toHaveBeenCalledTimes(2);
      expect((await db.select().from(payments).where(eq(payments.id, id)))[0]?.status).toBe("settled");
    } finally { fail?.(new Error("test cleanup")); await first; vi.restoreAllMocks(); }
  });
  it("keeps a committed receipt recoverable when Redis enqueue fails", async () => {
    const add = vi.fn().mockRejectedValue(new Error("Redis unavailable"));
    const queueGateway = await EnclaveGateway.boot(db, simulated, log, { receiptAnchorer: { add } as never });
    const session = await queueGateway.openSession(owner, await queueGateway.quote());
    const blob = encryptAesGcm(queueGateway.sessionWrapKey(session.sessionId), Buffer.from(randomUUID()));
    const body = { sessionId: session.sessionId, ...blob }; const id = await paidIntent(body);
    const result = await queueGateway.infer({ apiKey: owner, sessionId: session.sessionId, blob, paymentId: id });
    expect(add).toHaveBeenCalledOnce();
    expect((await db.select().from(receipts).where(eq(receipts.typedHash, result.typedHash)))[0]?.status).toBe("pending");
    expect((await db.select().from(payments).where(eq(payments.id, id)))[0]?.status).toBe("consumed");
  });
  it.each([ ["enclave_session", {}], ["enclave_settle", { paymentId: "bad" }], ["enclave_settle", { paymentId: randomUUID(), confidential: "false" }], ["enclave_infer", {}], ["unknown", {}] ])("validates SDK tool %s at the same boundary as REST", async (tool, input) => {
    expect((await post("/v1/agent-sdk/invoke", { tool, input })).status).toBe(400);
  });
});
