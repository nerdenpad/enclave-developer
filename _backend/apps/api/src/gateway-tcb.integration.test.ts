import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { apiKeys, models, payments, receipts, sessions, agents, usage, schema, type Database } from "@enclave/db";
import { DevCvm, PaymentRequiredError, encryptAesGcm, decryptAesGcm, sha256Hex, measurementOf, type InferenceAdapter } from "@enclave/core";
import { EnclaveGateway } from "./gateway.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import * as cvmStore from "./cvm-store.js";
import * as chain from "./tcb-chain.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe("gateway software TCB activation with real Postgres", () => {
  const configured = loadConfig();
  const isolatedSchema = `tcb_gateway_${randomUUID().replaceAll("-", "")}`;
  const adminSql = postgres(configured.DATABASE_URL, { max: 1 });
  const connection = postgres(configured.DATABASE_URL, { max: 10, connection: { search_path: isolatedSchema } });
  const db: Database = drizzle(connection, { schema });
  const tables = ["api_keys", "models", "tcb_policy", "sessions", "payments", "receipts", "usage", "mandates", "idempotency_keys", "agents"];
  const config = { ...configured, NODE_ENV: "test" as const, ARC_CHAIN_ID: 31337, PAYMENT_MODE: "mock" as const,
    INFERENCE_BACKEND: "echo" as const, TCB_POLICY_VERSION: 1, SERVING_IMAGE_ID: "gateway-tcb-v1", ALLOW_LOCAL_BOOTSTRAP: true,
    MODEL_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000003",
    USAGE_METER_ADDRESS: "0x0000000000000000000000000000000000000004",
    AGENT_MANDATE_ADDRESS: "0x0000000000000000000000000000000000000008" };
  const owner = "tcb-fixture-admin";
  const other = "tcb-fixture-user";
  const modelHash = sha256Hex("model:echo");
  const policy = { version: 1, servingImageId: config.SERVING_IMAGE_ID, requireCpuTee: true, requireGpuCc: true } as const;
  const stored = { vendorPrivateKey: `0x${"11".repeat(32)}`, enclavePrivateKey: `0x${"22".repeat(32)}`,
    wrappingKey: `0x${"33".repeat(32)}`, modelKey: `0x${"44".repeat(32)}` } as const;
  const vendor = { privateKey: stored.vendorPrivateKey, address: privateKeyToAccount(stored.vendorPrivateKey).address };
  const log = createLogger("silent");
  let gateway: EnclaveGateway;

  beforeAll(async () => {
    expect(process.env.ENCLAVE_INTEGRATION, "Use only the disposable integration runner").toBe("1");
    if (!/^tcb_gateway_[a-f0-9]{32}$/.test(isolatedSchema)) throw new Error("Invalid isolated test schema");
    await adminSql`create schema ${adminSql(isolatedSchema)}`;
    for (const table of tables) await adminSql`create table ${adminSql(isolatedSchema)}.${adminSql(table)} (like public.${adminSql(table)} including all)`;
  });
  beforeEach(async () => {
    for (const table of tables) await connection`truncate table ${connection(table)}`;
    vi.spyOn(cvmStore, "loadOrCreateCvmKeys").mockResolvedValue({ stored, vendor });
    await db.insert(apiKeys).values([{ keyHash: sha256Hex(owner), label: "tcb-admin", role: "admin" },
      { keyHash: sha256Hex(other), label: "tcb-user", role: "user" }]);
    await db.insert(models).values({ modelHash, codeHash: measurementOf(policy), version: "v1", provider: "fixture", approved: true });
    gateway = await EnclaveGateway.boot(db, config, log, undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    await connection.end({ timeout: 5 });
    if (!/^tcb_gateway_[a-f0-9]{32}$/.test(isolatedSchema)) throw new Error("Invalid isolated test schema");
    await adminSql`drop schema if exists ${adminSql(isolatedSchema)} cascade`;
    await adminSql.end({ timeout: 5 });
  });

  async function propose() {
    const result = await gateway.rotateTcbPolicy(owner, "gateway-tcb-v2", { version: 2, idempotencyKey: "proposal-v2" });
    await db.insert(models).values({ modelHash, codeHash: result.recorded.measurement, version: "v2", provider: "fixture", approved: true });
    return result.recorded;
  }
  async function session(target = gateway) {
    const quote = await target.quote();
    const created = await target.openSession(owner, quote);
    return { quote, ...created, key: await target.sessionWrapKeyForOwner(owner, created.sessionId) };
  }
  async function paid(target: EnclaveGateway, sessionId: string, key: Buffer) {
    const input = { apiKey: owner, sessionId, blob: encryptAesGcm(key, Buffer.from("TCB acceptance prompt")) };
    let id: string;
    try { await target.infer(input); throw new Error("Expected payment challenge"); }
    catch (error) {
      if (!(error instanceof PaymentRequiredError)) throw error;
      id = (error.payment as { accepts: Array<{ extra: { paymentId: string } }> }).accepts[0]!.extra.paymentId;
    }
    await target.settlePayment(owner, id);
    return { ...input, paymentId: id };
  }
  async function withBackend(inference: InferenceAdapter) {
    const cvm = await DevCvm.create({ policy, modelId: "echo", chainId: config.ARC_CHAIN_ID,
      verifyingContract: config.ATTESTATION_VERIFIER_ADDRESS as `0x${string}`, inference }, vendor, cvmStore.storedToBuffers(stored));
    return { cvm, gateway: new EnclaveGateway(db, cvm, config, log, undefined) };
  }

  it("activates the complete CVM policy, synchronizes another gateway and restart, and revokes old sessions", async () => {
    const old = await session();
    const peer = await EnclaveGateway.boot(db, config, log, undefined);
    const pending = await propose();
    expect((await gateway.quote()).measurement).toBe(old.quote.measurement);
    const activated = await gateway.activateTcbPolicy(owner, 2, 1, "activation-v2");
    expect(activated.active).toMatchObject({ binding: "local-fixture", trustMode: "development-software", version: 2 });
    const quote = await peer.quote();
    expect(quote).toMatchObject({ tcbVersion: 2, measurement: pending.measurement });
    await expect(peer.openSession(owner, old.quote)).rejects.toThrow();
    await expect(peer.sessionWrapKeyForOwner(owner, old.sessionId)).rejects.toThrow();
    await expect(peer.infer({ apiKey: owner, sessionId: old.sessionId, blob: encryptAesGcm(old.key, Buffer.from("stale")) })).rejects.toThrow();
    const fresh = await session(peer);
    const input = await paid(peer, fresh.sessionId, fresh.key);
    const result = await peer.infer(input);
    expect(result.receipt).toMatchObject({ receiptVersion: 2, codeHash: pending.measurement, attRef: sha256Hex(fresh.quote.signature) });
    expect(sha256Hex(decryptAesGcm(fresh.key, result.output!))).toBe(result.outputHash);
    const restarted = await EnclaveGateway.boot(db, config, log, undefined);
    expect((await restarted.policy()).version).toBe(2);
    expect(await restarted.sessionWrapKeyForOwner(owner, fresh.sessionId)).toEqual(fresh.key);
    await expect(restarted.sessionWrapKeyForOwner(owner, old.sessionId)).rejects.toThrow();
    await expect(restarted.sessionWrapKeyForOwner(other, fresh.sessionId)).rejects.toThrow("Invalid session");
  });

  it("discards an in-flight old-policy inference and rolls back consumption after another process activates", async () => {
    const entered = deferred<void>();
    const finish = deferred<Buffer>();
    const running = await withBackend(async () => { entered.resolve(); return finish.promise; });
    const old = await session(running.gateway);
    const input = await paid(running.gateway, old.sessionId, old.key);
    await propose();
    const request = running.gateway.infer(input).then((value) => ({ value }), (error: unknown) => ({ error }));
    await Promise.race([entered.promise, request.then(() => { throw new Error("Inference never reached the controlled backend"); })]);
    try {
      await gateway.activateTcbPolicy(owner, 2, 1);
      finish.resolve(Buffer.from("old policy output"));
      expect(await request).toMatchObject({ error: { code: "CONFLICT" } });
      expect(await db.select().from(receipts)).toHaveLength(0);
      expect(await db.select().from(usage)).toHaveLength(0);
      expect((await db.select().from(payments).where(eq(payments.id, input.paymentId)))[0]!.status).toBe("settled");
    } finally { finish.resolve(Buffer.from("cleanup")); await request; }
  });

  it("rejects a session admitted concurrently with activation before persisting it", async () => {
    const controlled = await withBackend(async () => Buffer.from("unused"));
    const quote = await controlled.gateway.quote();
    await propose();
    const entered = deferred<void>(); const finish = deferred<void>();
    const release = controlled.cvm.releaseKeys.bind(controlled.cvm);
    vi.spyOn(controlled.cvm, "releaseKeys").mockImplementation(async (...args) => { await release(...args); entered.resolve(); await finish.promise; });
    const pending = controlled.gateway.openSession(owner, quote).then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    try {
      await gateway.activateTcbPolicy(owner, 2, 1);
      finish.resolve();
      expect(await pending).toMatchObject({ error: { code: "CONFLICT" } });
      expect(await db.select().from(sessions)).toHaveLength(0);
    } finally { finish.resolve(); await pending; }
  });

  it.each(["create", "update"] as const)("fences %s memory writes from a session retired while the request was in flight", async (operation) => {
    const old = await session();
    const agent = await gateway.createAgent({ apiKey: owner, name: "before rotation", dailyLimitUsdc: 1 });
    await propose();
    const peer = await EnclaveGateway.boot(db, config, log, undefined);
    const entered = deferred<void>(); const finish = deferred<void>();
    type SessionGateway = { requireSession(...args: [string, string, DevCvm?]): Promise<typeof sessions.$inferSelect> };
    const internal = gateway as unknown as SessionGateway;
    const original = internal.requireSession.bind(internal);
    vi.spyOn(internal, "requireSession").mockImplementation(async (...args) => { const row = await original(...args); entered.resolve(); await finish.promise; return row; });
    const blob = encryptAesGcm(old.key, Buffer.from("must not be committed"));
    const promise = operation === "create"
      ? gateway.createAgent({ apiKey: owner, name: "stale create", dailyLimitUsdc: 1, sessionId: old.sessionId, memory: blob })
      : gateway.putAgentMemory({ apiKey: owner, agentId: agent.id, sessionId: old.sessionId, blob });
    const outcome = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    try {
      await peer.activateTcbPolicy(owner, 2, 1); finish.resolve();
      expect(await outcome).toMatchObject({ error: { code: "CONFLICT" } });
      const storedAgents = await db.select().from(agents);
      expect(storedAgents).toHaveLength(1);
      expect(storedAgents[0]!.memoryHash).toBe(sha256Hex(Buffer.alloc(0)));
    } finally { finish.resolve(); await outcome; }
  });

  it("rechecks onchain approval and deployment scope at restart and session/quote boundaries", async () => {
    const strictConfig = { ...config, ALLOW_LOCAL_BOOTSTRAP: false };
    const approval = vi.spyOn(chain, "verifyTcbApproval").mockResolvedValue({ mode: "onchain", scope: "31337:genesis-a:registry-a", listingId: 2n });
    const strict = await EnclaveGateway.boot(db, strictConfig, log, undefined);
    const pending = await propose();
    await strict.activateTcbPolicy(owner, 2, 1);
    expect((await strict.quote()).measurement).toBe(pending.measurement);
    approval.mockResolvedValue({ mode: "onchain", scope: "31337:genesis-b:registry-a", listingId: 2n });
    await expect(strict.quote()).rejects.toThrow("another chain deployment");
    await expect(EnclaveGateway.boot(db, strictConfig, log, undefined)).rejects.toThrow("another chain deployment");
    approval.mockRejectedValue(new Error("policy revoked"));
    await expect(strict.quote()).rejects.toThrow("policy revoked");
  });

  it("rejects cross-owner key export and non-admin activation without side effects", async () => {
    const active = await session();
    await propose();
    await expect(gateway.sessionWrapKeyForOwner(other, active.sessionId)).rejects.toThrow("Invalid session");
    await expect(gateway.activateTcbPolicy(other, 2, 1)).rejects.toThrow("Administrator");
    expect((await gateway.policy()).version).toBe(1);
  });

  it("registers the stored policy commitment with a stable durable key and preserves approved DB metadata on retry", async () => {
    const pending = (await gateway.rotateTcbPolicy(owner, "registered-image-v2", { version: 2 })).recorded;
    const registryConfig = { ...config, MODEL_REGISTRY_ADDRESS: `0x${"33".repeat(20)}` };
    const registryGateway = await EnclaveGateway.boot(db, registryConfig, log, undefined);
    const original = chain.createTcbRegistry;
    const list = vi.fn<ReturnType<typeof chain.createTcbRegistry>["listWithPolicy"]>().mockResolvedValue({ id: 42n, tx: `0x${"ab".repeat(32)}` });
    vi.spyOn(chain, "createTcbRegistry").mockImplementation((...args) => ({ ...original(...args), listWithPolicy: list }));
    const input = { apiKey: owner, modelHash, codeHash: pending.measurement, policyHash: pending.policyHash,
      policyVersion: pending.version, version: "v2", bps: 100, idempotencyKey: "stable-policy-list" };
    await expect(registryGateway.listModel({ ...input, policyHash: sha256Hex("wrong") })).rejects.toThrow("stored TCB policy");
    expect(list).not.toHaveBeenCalled();
    const first = await registryGateway.listModel(input);
    expect(list.mock.calls[0]!.slice(0, 2)).toEqual([{ modelHash, codeHash: pending.measurement, policyHash: pending.policyHash, policyVersion: 2n }, 100]);
    await db.update(models).set({ approved: true }).where(eq(models.id, first.id!));
    const replay = await registryGateway.listModel(input);
    expect(replay.id).toBe(first.id);
    expect(replay.approved).toBe(true);
    expect(list.mock.calls[1]![2]).toBe(list.mock.calls[0]![2]);
    expect((await db.select().from(models).where(eq(models.codeHash, pending.measurement)))).toHaveLength(1);
    await registryGateway.activateTcbPolicy(owner, 2, 1);
    expect((await registryGateway.listModel(input)).id).toBe(first.id);
  });
});
