import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { encryptAesGcm, sha256Hex, type DevCvm, type SignedReceipt } from "@enclave/core";
import { inferenceExecutions, idempotencyKeys, type Database } from "@enclave/db";
import { EnclaveGateway } from "./gateway.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import * as tcb from "./tcb-lifecycle.js";
import { claimInferenceExecution, uncertainInference } from "./inference-execution.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Dispatch = typeof inferenceExecutions.$inferSelect;
type StoredState = { dispatches: Dispatch[]; responses: Array<{ keyHash: string; idempotencyKey: string; requestHash: string; responseJson: string }> };

/** Transactional fault-injection double: the dispatch commit survives a failed
 * later publication commit. Query predicates are inspected rather than ignored. */
function durableDatabase() {
  const dialect = new PgDialect();
  let saved: StoredState = { dispatches: [], responses: [] };
  let publicationFailure: "before-commit" | "lost-ack" | undefined;
  let transactions = 0;
  let tail: Promise<void> = Promise.resolve();
  const db = {
    async transaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      transactions++;
      const work = structuredClone(saved);
      let publishing = false;
      const tx = {
        execute: vi.fn(async () => undefined),
        select: () => ({ from: (table: unknown) => ({ where: (condition: SQL) => ({ limit: async () => {
          const query = dialect.sqlToQuery(condition);
          if (table === inferenceExecutions) return work.dispatches.filter(row => row.paymentId === query.params[0]
            || (row.keyHash === query.params[1] && row.idempotencyKey === query.params[2]));
          expect(table).toBe(idempotencyKeys);
          return work.responses.filter(row => row.keyHash === query.params[0] && row.idempotencyKey === query.params[1]);
        } }) }) }),
        insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({ returning: async () => {
            expect(table).toBe(inferenceExecutions);
            const conflict = work.dispatches.some(row => row.paymentId === values.paymentId
              || (values.idempotencyKey !== null && row.keyHash === values.keyHash && row.idempotencyKey === values.idempotencyKey));
            if (conflict) return [];
            const row = { ...values, claimId: randomUUID(), status: "dispatched", receiptHash: null,
              createdAt: new Date(), completedAt: null } as Dispatch;
            work.dispatches.push(row);
            return [{ claimId: row.claimId }];
          } }),
          onConflictDoUpdate: async () => undefined,
          then: (resolve: (value: undefined) => void) => {
            if (table === idempotencyKeys) work.responses.push(values as StoredState["responses"][number]);
            resolve(undefined);
          },
        }) }),
        update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: (condition: SQL) => ({
          then: (resolve: (value: undefined) => void) => resolve(undefined),
          returning: async () => {
            expect(table).toBe(inferenceExecutions);
            const query = dialect.sqlToQuery(condition);
            const row = work.dispatches.find(item => item.paymentId === query.params[0] && item.claimId === query.params[1]
              && item.keyHash === query.params[2] && item.requestHash === query.params[3] && item.status === query.params[4]);
            if (!row) return [];
            Object.assign(row, values);
            publishing = true;
            return [{ paymentId: row.paymentId }];
          },
        }) }) }),
      };
      try {
        const result = await operation(tx as unknown as Tx);
        if (publishing && publicationFailure === "before-commit") throw new Error("Injected publication commit failure");
        saved = work;
        if (publishing && publicationFailure === "lost-ack") throw new Error("Injected lost commit acknowledgement");
        return result;
      } finally { release(); }
    },
  };
  return { db: db as unknown as Database, snapshot: () => structuredClone(saved), transactions: () => transactions,
    failPublication: (failure: typeof publicationFailure) => { publicationFailure = failure; } };
}

function fixture() {
  const durable = durableDatabase();
  const secret = Buffer.alloc(32, 7);
  const paymentId = randomUUID(), sessionId = randomUUID(), keyHash = sha256Hex("owner fixture");
  const hash = sha256Hex("signed fixture field");
  const config = loadConfig({ DATABASE_URL: "postgres://unit.invalid/dispatch", NODE_ENV: "test",
    INFERENCE_BACKEND: "near-verified", INFERENCE_BASE_URL: "https://test.completions.near.ai/v1",
    INFERENCE_MODEL: "Fixture/Test", INFERENCE_ALLOW_REMOTE: "true", INFERENCE_API_KEY: "fixture-key",
    NEAR_VERIFIER_PYTHON: "fixture-python", NEAR_ATTESTATION_POLICY: "fixture-policy" });
  const receipt: SignedReceipt = { receiptVersion: 2, modelHash: hash, codeHash: hash, inHash: hash, outHash: hash,
    attRef: hash, nonce: hash, ts: 1n, sig: `0x${"11".repeat(65)}` };
  const infer = vi.fn(async () => {
    expect(durable.snapshot().dispatches).toHaveLength(1);
    expect(durable.snapshot().dispatches[0]?.status).toBe("dispatched");
    return { receipt, output: Buffer.from("READY") };
  });
  const cvm = { modelHash: hash, codeHash: hash, sessionSecret: () => secret, infer } as unknown as DevCvm;
  const state = { policyHash: hash } as tcb.TcbState;
  function gateway() {
    const instance = new EnclaveGateway(durable.db, cvm, config, createLogger("silent"), undefined);
    // This unit targets durable dispatch ordering, not authentication/hardware
    // verification, which have independent negative and acceptance suites.
    const access = instance as unknown as {
      requireKey(): Promise<string>; syncTcb(): Promise<{ cvm: DevCvm; state: tcb.TcbState }>;
      requireSession(): Promise<{ id: string; attRef: string }>; assertServingApproved(): Promise<void>;
      assertRuntimeContractWiring(): Promise<void>; consumePayment(...args: unknown[]): Promise<void>;
    };
    vi.spyOn(access, "requireKey").mockResolvedValue(keyHash);
    vi.spyOn(access, "syncTcb").mockResolvedValue({ cvm, state });
    vi.spyOn(access, "requireSession").mockResolvedValue({ id: sessionId, attRef: hash });
    const approval = vi.spyOn(access, "assertServingApproved").mockResolvedValue();
    vi.spyOn(access, "assertRuntimeContractWiring").mockResolvedValue();
    const consume = vi.spyOn(access, "consumePayment").mockResolvedValue();
    return { instance, approval, consume };
  }
  vi.spyOn(tcb, "assertCurrentTcb").mockResolvedValue();
  const input = { apiKey: "fixture-owner", paymentId, sessionId, blob: encryptAesGcm(secret, Buffer.from("READY")), idempotencyKey: randomUUID() };
  return { durable, gateway, input, infer, keyHash };
}

afterEach(() => vi.restoreAllMocks());

describe("durable remote inference dispatch", () => {
  it("commits the dispatch before provider execution and returns exact cached result after restart", async () => {
    const f = fixture();
    const first = f.gateway();
    const result = await first.instance.infer(f.input);
    expect(f.durable.snapshot().dispatches[0]).toMatchObject({ status: "completed", receiptHash: result.typedHash });
    expect(first.consume.mock.calls.map(call => call.at(-1))).toEqual([true, expect.any(String)]);
    const restarted = f.gateway();
    await expect(restarted.instance.infer(f.input)).resolves.toEqual(result);
    expect(f.infer).toHaveBeenCalledOnce();
  });

  it("never dispatches if payment validation fails before the durable claim", async () => {
    const f = fixture(), first = f.gateway();
    first.consume.mockRejectedValueOnce(new Error("Rejected canonical settlement"));
    await expect(first.instance.infer(f.input)).rejects.toThrow("Rejected canonical settlement");
    expect(f.durable.snapshot().dispatches).toHaveLength(0);
    expect(f.infer).not.toHaveBeenCalled();
  });

  it.each(["provider", "publication-commit", "revocation"] as const)("quarantines %s uncertainty across restart without a second execution", async (failure) => {
    const f = fixture(), first = f.gateway();
    if (failure === "provider") f.infer.mockRejectedValueOnce(new Error("Lost response after GPU execution"));
    if (failure === "publication-commit") f.durable.failPublication("before-commit");
    if (failure === "revocation") first.approval.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(new Error("Model revoked during inference"));
    await expect(first.instance.infer(f.input)).rejects.toMatchObject({ code: "INFERENCE_EXECUTION_UNCERTAIN", statusCode: 409, details: { paymentId: f.input.paymentId } });
    expect(f.durable.snapshot().dispatches[0]?.status).toBe("dispatched");
    expect(f.durable.snapshot().responses).toHaveLength(0);
    f.durable.failPublication(undefined);
    await expect(f.gateway().instance.infer(f.input)).rejects.toMatchObject({ code: "INFERENCE_EXECUTION_UNCERTAIN" });
    expect(f.infer).toHaveBeenCalledOnce();
  });

  it("returns a committed result after a lost acknowledgement without resubmission", async () => {
    const f = fixture();
    f.durable.failPublication("lost-ack");
    await expect(f.gateway().instance.infer(f.input)).rejects.toMatchObject({ code: "INFERENCE_EXECUTION_UNCERTAIN" });
    expect(f.durable.snapshot().dispatches[0]?.status).toBe("completed");
    f.durable.failPublication(undefined);
    const result = await f.gateway().instance.infer(f.input);
    expect(result.outputHash).toBe(sha256Hex("signed fixture field"));
    expect(f.infer).toHaveBeenCalledOnce();
  });

  it("concurrent requests commit one dispatch and never invoke the provider twice", async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.gateway().instance.infer(f.input), f.gateway().instance.infer(f.input)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(f.infer).toHaveBeenCalledOnce();
    expect(f.durable.snapshot().dispatches).toHaveLength(1);
  });

  it.each(["keyHash", "requestHash", "idempotencyKey"] as const)("cannot reuse a durable payment claim with changed %s", async (field) => {
    const store = durableDatabase();
    const binding = { paymentId: randomUUID(), keyHash: sha256Hex("owner"), requestHash: sha256Hex("request"), idempotencyKey: randomUUID() };
    await store.db.transaction(tx => claimInferenceExecution(tx, binding));
    await expect(store.db.transaction(tx => claimInferenceExecution(tx, { ...binding, [field]: sha256Hex("changed") }))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.snapshot().dispatches).toHaveLength(1);
  });

  it("cannot bypass a dispatched owner/idempotency claim by supplying a second payment", async () => {
    const store = durableDatabase();
    const binding = { paymentId: randomUUID(), keyHash: sha256Hex("owner"), requestHash: sha256Hex("request"), idempotencyKey: randomUUID() };
    await store.db.transaction(tx => claimInferenceExecution(tx, binding));
    await expect(store.db.transaction(tx => claimInferenceExecution(tx, { ...binding, paymentId: randomUUID() }))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.snapshot().dispatches).toHaveLength(1);
  });

  it("does not disclose provider errors, raw signatures or prompt bytes in uncertainty", () => {
    const error = uncertainInference("public-payment-id");
    expect(error.details).toEqual({ paymentId: "public-payment-id" });
    expect(error.message).not.toMatch(/signature|prompt|token/);
  });
});
