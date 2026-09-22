import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeys, models, payments, receipts, idempotencyKeys, agentRuns, agentActions, schema, type Database } from "@enclave/db";
import { DevCvm, decryptAesGcm, measurementOf, sha256Hex, usdcToUnits, verifyReceiptSignature,
  type InferenceAdapter, type SignedReceipt } from "@enclave/core";
import { AgentRuntime, PostgresAgentRunStore } from "./agent-runtime.js";
import { EnclaveGateway } from "./gateway.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { loadOrCreateCvmKeys, storedToBuffers } from "./cvm-store.js";
import { verifySettlementProof } from "./settlement-proof.js";
import { meterConfigured, marketplaceConfigured } from "./chain.js";

/** The provider is a local strict-JSON fixture. PostgreSQL, gateway cryptography and Anvil payments are real. */
describe("software agent runtime through real gateway, Postgres and local Anvil settlement", () => {
  const config = { ...loadConfig(), PAYMENT_MODE: "mock" as const, INFERENCE_BACKEND: "echo" as const };
  const ownedSchema = `agent_gateway_${randomUUID().replaceAll("-", "")}`;
  const administrator = postgres(config.DATABASE_URL, { max: 1 });
  const connection = postgres(config.DATABASE_URL, { max: 10, connection: { search_path: ownedSchema } });
  const db: Database = drizzle(connection, { schema });
  const tables = ["api_keys", "models", "tcb_policy", "sessions", "payments", "receipts", "usage", "mandates",
    "idempotency_keys", "agents", "chain_transactions", "agent_runs", "agent_actions"];
  const owner = "agent-runtime-gateway-owner";
  const other = "agent-runtime-gateway-other";
  const goal = "PRIVATE RUNTIME GOAL: produce a two-step explanation";
  const interim = "PRIVATE INTERIM CONTEXT";
  const answer = "PRIVATE FINAL RESULT";
  const price = usdcToUnits(config.INFERENCE_PRICE_USDC);
  const policy = { version: config.TCB_POLICY_VERSION, servingImageId: config.SERVING_IMAGE_ID, requireCpuTee: true, requireGpuCc: true } as const;
  const hostSecret = Buffer.alloc(32, 73);
  const log = createLogger("silent");
  let keys: Awaited<ReturnType<typeof loadOrCreateCvmKeys>>;
  let gateway: EnclaveGateway;
  let cvm: DevCvm;
  let store: PostgresAgentRunStore;
  let runtime: AgentRuntime;
  let agentId: string;
  let decisions: Array<{ action: "continue" | "complete"; output: string }>;
  const provider = vi.fn<InferenceAdapter>();

  async function makeGateway() {
    const createdCvm = await DevCvm.create({ policy, modelId: "echo", chainId: config.ARC_CHAIN_ID,
      verifyingContract: config.ATTESTATION_VERIFIER_ADDRESS as `0x${string}`, inference: provider }, keys.vendor, storedToBuffers(keys.stored));
    return { cvm: createdCvm, gateway: new EnclaveGateway(db, createdCvm, config, log, undefined) };
  }
  function makeRuntime(nextGateway: EnclaveGateway, nextStore = new PostgresAgentRunStore(db)) {
    return new AgentRuntime({ store: nextStore, gateway: nextGateway, hostSecret, enabled: true,
      paymentMode: "mock", chainId: config.ARC_CHAIN_ID, maxSteps: 3, maxBudgetUnits: price * 3n,
      maxDurationMs: 600_000, leaseMs: 240_000, callTimeoutMs: 120_000 });
  }
  function runInput(idempotencyKey = randomUUID()) {
    return { agentId, goal, maxSteps: 3, maxBudgetUnits: (price * 3n).toString(),
      deadlineAt: new Date(Date.now() + 300_000).toISOString(), idempotencyKey };
  }
  async function exportSession(target: EnclaveGateway, apiKey = owner) {
    const created = await target.openSession(apiKey, await target.quote());
    return { id: created.sessionId, key: await target.sessionWrapKeyForOwner(apiKey, created.sessionId) };
  }

  beforeAll(async () => {
    expect(process.env.ENCLAVE_INTEGRATION, "Use only the disposable integration runner").toBe("1");
    expect(config.ARC_CHAIN_ID).toBe(31337);
    expect(meterConfigured(config) && marketplaceConfigured(config)).toBe(true);
    if (!/^agent_gateway_[a-f0-9]{32}$/.test(ownedSchema)) throw new Error("Invalid isolated test schema");
    await administrator`create schema ${administrator(ownedSchema)}`;
    for (const table of tables) await administrator`create table ${administrator(ownedSchema)}.${administrator(table)} (like public.${administrator(table)} including all)`;
    keys = await loadOrCreateCvmKeys(); // The runner's disposable deployment signer, never printed or copied to artifacts.
  });
  beforeEach(async () => {
    for (const table of tables) await connection`truncate table ${connection(table)}`;
    await db.insert(apiKeys).values([{ keyHash: sha256Hex(owner), label: "agent-runtime-owner", role: "user" },
      { keyHash: sha256Hex(other), label: "agent-runtime-other", role: "user" }]);
    const seedModel = await administrator`select * from public.models where model_hash = ${sha256Hex("model:echo")} and code_hash = ${measurementOf(policy)}`;
    expect(seedModel).toHaveLength(1);
    await connection`insert into models select * from public.models where model_hash = ${sha256Hex("model:echo")} and code_hash = ${measurementOf(policy)}`;
    expect((await db.select().from(models))[0]).toMatchObject({ approved: true, revoked: false });
    decisions = [{ action: "continue", output: interim }, { action: "complete", output: answer }];
    provider.mockReset().mockImplementation(async (input) => {
      const prompt = JSON.parse(input.toString("utf8")) as { goal: string; step: number; context: string[] };
      expect(prompt.goal).toBe(goal);
      expect(prompt.step).toBe(provider.mock.calls.length);
      expect(prompt.context).toEqual(prompt.step === 1 ? [] : [interim]);
      const decision = decisions.shift();
      if (!decision) throw new Error("Unexpected repeated model generation");
      return Buffer.from(JSON.stringify(decision));
    });
    ({ cvm, gateway } = await makeGateway());
    const agent = await gateway.createAgent({ apiKey: owner, name: "Bounded integration agent", dailyLimitUsdc: 100, allowedModels: [cvm.modelHash] });
    agentId = agent.id;
    store = new PostgresAgentRunStore(db);
    runtime = makeRuntime(gateway, store);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    await connection.end({ timeout: 5 });
    if (!/^agent_gateway_[a-f0-9]{32}$/.test(ownedSchema)) throw new Error("Invalid isolated test schema");
    await administrator`drop schema if exists ${administrator(ownedSchema)} cascade`;
    await administrator.end({ timeout: 5 });
  });

  it("executes two paid steps across restart and exports only an owned encrypted result without replaying generation", async () => {
    const input = runInput();
    const created = await runtime.create(owner, input);
    expect((await runtime.create(owner, input)).id).toBe(created.id);
    expect(await runtime.runNext()).toMatchObject({ status: "queued", step: 1, spentUnits: price.toString() });
    expect(provider).toHaveBeenCalledTimes(1);
    const restartedGateway = (await makeGateway()).gateway;
    const restarted = makeRuntime(restartedGateway);
    expect(await restarted.runNext()).toMatchObject({ status: "completed", step: 2, spentUnits: (price * 2n).toString() });
    const session = await exportSession(restartedGateway);
    const result = await restarted.get(owner, created.id, { sessionId: session.id });
    expect(decryptAesGcm(session.key, result.output!).toString()).toBe(answer);
    expect(result.actions).toHaveLength(13);
    expect(result.actions.map((action) => action.sequence)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    for (const kind of ["settlement_dispatched", "settlement_completed", "inference_dispatched", "inference_completed"]) {
      expect(result.actions.filter((action) => action.kind === kind)).toHaveLength(2);
    }
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE RUNTIME GOAL|PRIVATE INTERIM CONTEXT|PRIVATE FINAL RESULT|agent-runtime-gateway-owner/);
    const paid = await db.select().from(payments);
    expect(paid).toHaveLength(2);
    for (const payment of paid) {
      expect(payment).toMatchObject({ status: "consumed", amountUnits: price, agentId, settlementMode: "mock" });
      expect(payment.settleTx).toMatch(/^0x[0-9a-f]{64}$/i);
      await verifySettlementProof(config, { paymentId: payment.id, txHash: payment.settleTx!, amount: price, confidential: false });
    }
    const signed = await db.select().from(receipts);
    expect(signed).toHaveLength(2);
    for (const receipt of signed) {
      expect(await verifyReceiptSignature({ ...receipt, receiptVersion: 2, nonce: receipt.nonce! } as SignedReceipt,
        cvm.enclaveAddress, config.ARC_CHAIN_ID, config.ATTESTATION_VERIFIER_ADDRESS as `0x${string}`)).toBe(true);
    }
    expect(await db.select().from(idempotencyKeys)).toHaveLength(2);
    const savedRuns = await db.select().from(agentRuns);
    const savedActions = await db.select().from(agentActions);
    expect(savedRuns).toHaveLength(1);
    expect(JSON.stringify({ state: savedRuns[0]!.sealedState, actions: savedActions })).not.toMatch(/PRIVATE RUNTIME GOAL|PRIVATE INTERIM CONTEXT|PRIVATE FINAL RESULT|agent-runtime-gateway-owner/);
    expect(await restarted.runNext()).toBeUndefined();
    expect((await restarted.resume(owner, created.id)).status).toBe("completed");
    expect((await restarted.create(owner, input)).id).toBe(created.id);
    expect((await restarted.get(owner, created.id, { sessionId: session.id })).status).toBe("completed");
    expect(provider).toHaveBeenCalledTimes(2);
    expect(await db.select().from(payments)).toHaveLength(2);
    expect(await db.select().from(agentActions)).toHaveLength(13);
    await expect(restarted.get(other, created.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await restarted.list(other)).toEqual([]);
    const foreign = await exportSession(restartedGateway, other);
    await expect(restarted.get(owner, created.id, { sessionId: foreign.id })).rejects.toMatchObject({ code: "AGENT_RESULT_SESSION_INVALID" });
  });

  it("reconciles a persisted gateway result after a runtime journal failure without a second debit or model call", async () => {
    decisions = [{ action: "complete", output: answer }];
    const run = await runtime.create(owner, runInput());
    let interrupt = true;
    const originalChange = store.change.bind(store);
    vi.spyOn(store, "change").mockImplementation((id, fence, mutate) => originalChange(id, fence, (row) => {
      const change = mutate(row);
      if (interrupt && change.action.kind === "inference_completed") { interrupt = false; throw new Error("Injected runtime journal outage"); }
      return change;
    }));
    expect(await runtime.runNext()).toMatchObject({ status: "outcome_unknown", errorCode: "AGENT_RECONCILIATION_REQUIRED" });
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await db.select().from(payments))[0]!.status).toBe("consumed");
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(await db.select().from(idempotencyKeys)).toHaveLength(1);
    const restartedGateway = (await makeGateway()).gateway;
    const restarted = makeRuntime(restartedGateway);
    expect(await restarted.resume(owner, run.id)).toMatchObject({ status: "completed", step: 1, spentUnits: price.toString() });
    const session = await exportSession(restartedGateway);
    const result = await restarted.get(owner, run.id, { sessionId: session.id });
    expect(decryptAesGcm(session.key, result.output!).toString()).toBe(answer);
    expect(result.actions.filter((action) => action.kind === "inference_completed")).toHaveLength(1);
    expect(result.actions.filter((action) => action.kind === "settlement_dispatched")).toHaveLength(1);
    expect(await restarted.runNext()).toBeUndefined();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await db.select().from(payments)).toHaveLength(1);
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run.id)))[0]!.spentUnits).toBe(price);
  });
});
