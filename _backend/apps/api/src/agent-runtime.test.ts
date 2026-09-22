import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, PaymentRequiredError, UnauthorizedError, decryptAesGcm, encryptAesGcm, sha256Hex, type AttestationQuote } from "@enclave/core";
import { AgentRuntime, type AgentRuntimeOptions, type AgentRuntimeGateway } from "./agent-runtime.js";
import { assertRunFence, type AgentRunStore, type AgentRunRow, type AgentActionRow, type AgentRunChange, type RunFence } from "./agent-runtime-store.js";
import { createAgentRuntimeRoutes } from "./agent-runtime-routes.js";

const apiKey = "API-KEY-SECRET-CANARY", otherKey = "ANOTHER-API-KEY";
const owner = sha256Hex(apiKey), otherOwner = sha256Hex(otherKey);
const agentId = randomUUID(), goal = "PRIVATE-GOAL-CANARY: solve a bounded planning task";
const hex = `0x${"ab".repeat(32)}` as const, signature = `0x${"12".repeat(65)}` as const;
const quote: AttestationQuote = { cpuQuote: "dev", gpuQuote: "dev", measurement: hex, tcbVersion: 1, timestamp: Date.now(), signature };
const clone = <T>(value: T): T => structuredClone(value);
const authorization = { from: `0x${"22".repeat(20)}` as `0x${string}`, validAfter: "0", validBefore: "9999999999", signature: signature as `0x${string}` };

class MemoryStore implements AgentRunStore {
  rows = new Map<string, AgentRunRow>(); journal = new Map<string, AgentActionRow[]>();
  intents = new Map<string, { owner: string; status: string; settleTx: string | null; amountUnits: bigint }>();
  responses = new Map<string, { owner: string; responseJson: string; typedHash: string }>();
  sessions = new Map<string, { owner: string; key: Buffer; expiresAt: number }>();
  now = Date.now(); failKind: string | undefined; onExpired: (() => void) | undefined; onChange: ((kind: string, row: AgentRunRow) => void) | undefined;
  async hasOwner(key: string) { return key === owner || key === otherOwner; }
  async insert(row: AgentRunRow, action: AgentActionRow) {
    const existing = [...this.rows.values()].find((r) => r.ownerKeyHash === row.ownerKeyHash && r.idempotencyKey === row.idempotencyKey);
    if (existing) return clone(existing);
    this.rows.set(row.id, clone(row)); this.journal.set(row.id, [clone(action)]); return clone(row);
  }
  async get(key: string, id: string) { const row = this.rows.get(id); if (!row || row.ownerKeyHash !== key) throw new NotFoundError("agent run", id); return clone(row); }
  async list(key: string, after: string | undefined, limit: number) { return [...this.rows.values()].filter((r) => r.ownerKeyHash === key && (!after || r.id > after)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit).map(clone); }
  async actions(id: string) { return clone(this.journal.get(id) ?? []); }
  async claim(now: Date, leaseMs: number) {
    const row = [...this.rows.values()].find((r) => r.status === "queued"); if (!row) return undefined;
    row.status = "running"; row.leaseToken = randomUUID(); row.leaseUntil = new Date(now.getTime() + leaseMs); row.version++; return clone(row);
  }
  async expired(now: Date) { const rows = [...this.rows.values()].filter((r) => r.status === "running" && r.leaseUntil! <= now).map(clone); this.onExpired?.(); return rows; }
  async heartbeat(id: string, token: string, now: Date, leaseMs: number) {
    const row = this.rows.get(id); if (!row || row.status !== "running" || row.leaseToken !== token || row.leaseUntil! <= now) return false;
    row.leaseUntil = new Date(now.getTime() + leaseMs); return true;
  }
  async change(id: string, fence: RunFence, mutate: (row: AgentRunRow) => AgentRunChange) {
    const row = this.rows.get(id); assertRunFence(row, id, fence);
    const change = mutate(clone(row));
    if (this.failKind === change.action.kind) { this.failKind = undefined; throw new Error(`${apiKey} injected write outage`); }
    this.onChange?.(change.action.kind, row);
    Object.assign(row, clone(change.patch), { version: row.version + 1, ledgerSequence: change.action.sequence, ledgerHead: change.action.actionHash, updatedAt: fence.now });
    this.journal.get(id)!.push(clone(change.action)); return clone(row);
  }
  async inference(key: string, id: string) { const row = this.responses.get(id); return row?.owner === key ? clone(row) : undefined; }
  async payment(key: string, id: string) { const row = this.intents.get(id); return row?.owner === key ? clone(row) : undefined; }
  async ownedSession(key: string, id: string, now: Date) { const session = this.sessions.get(id); return session?.owner === key && session.expiresAt > now.getTime(); }
}

function fixture(options: Partial<AgentRuntimeOptions> = {}) {
  const store = new MemoryStore(); let providerCalls = 0;
  let decisions: unknown[] = [{ action: "complete", output: "PRIVATE-ANSWER-CANARY" }];
  const gateway: AgentRuntimeGateway = {
    quote: vi.fn(async () => quote),
    getAgent: vi.fn(async (key, id) => { if (key !== apiKey) throw new NotFoundError("agent", id); return { id }; }),
    openSession: vi.fn(async (key) => {
      const sessionId = randomUUID(), expiresAt = store.now + 1_800_000;
      store.sessions.set(sessionId, { owner: sha256Hex(key), key: createHash("sha256").update(sessionId).digest(), expiresAt });
      return { sessionId, expiresAt: new Date(expiresAt).toISOString() };
    }),
    sessionWrapKey: (id) => store.sessions.get(id)!.key,
    sessionWrapKeyForOwner: vi.fn(async (key, id) => { if (!await store.ownedSession(sha256Hex(key), id, new Date(store.now))) throw new UnauthorizedError(); return store.sessions.get(id)!.key; }),
    infer: vi.fn(async (input) => {
      if (!input.paymentId) {
        const paymentId = randomUUID(); store.intents.set(paymentId, { owner: sha256Hex(input.apiKey), status: "open", settleTx: null, amountUnits: 100n });
        throw new PaymentRequiredError("required", { x402Version: 1, accepts: [{ scheme: "exact", network: "arc-31337", maxAmountRequired: "100", payTo: authorization.from,
          asset: authorization.from, extra: { paymentId, receiptPending: true } }] });
      }
      providerCalls++;
      const plaintext = Buffer.from(JSON.stringify(decisions.shift()));
      const result = { typedHash: hex, outputHash: sha256Hex(plaintext), output: encryptAesGcm(store.sessions.get(input.sessionId)!.key, plaintext) };
      store.responses.set(input.idempotencyKey!, { owner: sha256Hex(input.apiKey), responseJson: JSON.stringify(result), typedHash: hex });
      store.intents.get(input.paymentId)!.status = "consumed";
      return result;
    }),
    settlePayment: vi.fn(async (_key, id) => { Object.assign(store.intents.get(id)!, { status: "settled", settleTx: hex }); return { paymentId: id, tx: hex, confidential: false }; }),
  };
  const config: AgentRuntimeOptions = { store, gateway, hostSecret: Buffer.alloc(32, 33), enabled: true, paymentMode: "mock", chainId: 31337,
    now: () => store.now, ...options };
  const runtime = new AgentRuntime(config);
  const create = (changes = {}) => runtime.create(apiKey, { agentId, goal, maxSteps: 3, maxBudgetUnits: "1000",
    deadlineAt: new Date(store.now + 600_000).toISOString(), idempotencyKey: randomUUID(), ...changes });
  return { store, gateway, runtime, config, create, calls: () => providerCalls, decisions: (value: unknown[]) => { decisions = value; } };
}
afterEach(() => vi.restoreAllMocks());

describe("durable software agent runtime", () => {
  it("executes a real bounded multi-step protocol and exports only encrypted final output", async () => {
    const f = fixture(); f.decisions([{ action: "continue", output: "Interim context" }, { action: "complete", output: "Final answer" }]);
    const run = await f.create(); expect((await f.runtime.runNext())?.status).toBe("queued");
    expect((await f.runtime.runNext())?.status).toBe("completed"); expect(f.calls()).toBe(2);
    const session = await f.gateway.openSession(apiKey, quote);
    const result = await f.runtime.get(apiKey, run.id, { sessionId: session.sessionId });
    expect(result.spentUnits).toBe("200"); expect(result.step).toBe(2);
    expect(decryptAesGcm(f.gateway.sessionWrapKey(session.sessionId), result.output!).toString()).toBe("Final answer");
    expect(result.actions.filter((a) => a.kind === "inference_dispatched")).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/Final answer|PRIVATE-GOAL|API-KEY/);
    const stored = JSON.stringify({ rows: [...f.store.rows.values()].map(({ maxBudgetUnits, spentUnits, ...r }) => ({ ...r, maxBudgetUnits: String(maxBudgetUnits), spentUnits: String(spentUnits) })), actions: [...f.store.journal.values()] });
    expect(stored).not.toMatch(/PRIVATE-GOAL|API-KEY|Interim context|Final answer/);
  });
  it("atomically claims a run once across independent runtime instances", async () => {
    const f = fixture(); await f.create(); const second = new AgentRuntime(f.config);
    const result = await Promise.all([f.runtime.runNext(), second.runNext()]);
    expect(result.filter(Boolean)).toHaveLength(1); expect(f.calls()).toBe(1);
  });
  it("uses owner-scoped create idempotency and rejects changed input", async () => {
    const f = fixture(), key = randomUUID();
    const [a, b] = await Promise.all([f.create({ idempotencyKey: key }), f.create({ idempotencyKey: key })]);
    expect(a.id).toBe(b.id); expect(f.store.rows.size).toBe(1); expect(f.store.journal.get(a.id)).toHaveLength(1);
    await expect(f.create({ idempotencyKey: key, goal: "different" })).rejects.toThrow(ConflictError);
  });
  it("rejects cross-owner get, cancel, resume, agent selection and result sessions", async () => {
    const f = fixture(), run = await f.create();
    for (const method of ["get", "cancel", "resume"] as const) await expect(f.runtime[method](otherKey, run.id)).rejects.toThrow(NotFoundError);
    expect(await f.runtime.list(otherKey)).toEqual([]);
    await expect(f.runtime.create(otherKey, { agentId, goal, maxSteps: 1, maxBudgetUnits: "100", deadlineAt: new Date(f.store.now + 1000).toISOString(), idempotencyKey: "foreign" })).rejects.toThrow(NotFoundError);
    const session = await f.gateway.openSession(otherKey, quote);
    await expect(f.runtime.get(apiKey, run.id, { sessionId: session.sessionId })).rejects.toMatchObject({ code: "AGENT_RESULT_SESSION_INVALID" });
    await expect(f.runtime.list("bad-key")).rejects.toThrow(UnauthorizedError);
  });
  it("pauses authorized payments until an external authorization is supplied", async () => {
    const f = fixture({ paymentMode: "authorized", chainId: 5042002 }), run = await f.create();
    expect((await f.runtime.runNext())?.status).toBe("awaiting_payment"); expect(f.calls()).toBe(0); expect(f.gateway.settlePayment).not.toHaveBeenCalled();
    await expect(f.runtime.resume(apiKey, run.id)).rejects.toMatchObject({ code: "AGENT_PAYMENT_AUTHORIZATION_REQUIRED" });
    await f.runtime.resume(apiKey, run.id, { authorization });
    await f.runtime.resume(apiKey, run.id, { authorization });
    expect((await f.runtime.runNext())?.status).toBe("completed");
    expect(f.gateway.settlePayment).toHaveBeenCalledExactlyOnceWith(apiKey, expect.any(String), false, authorization);
    expect(JSON.stringify(await f.runtime.get(apiKey, run.id))).not.toContain(authorization.signature);
  });
  it.each(["abc", (1n << 256n).toString(), "-1"])("rejects malformed external authorization %s without settling", async (value) => {
    const f = fixture({ paymentMode: "authorized" }), run = await f.create(); await f.runtime.runNext();
    await expect(f.runtime.resume(apiKey, run.id, { authorization: { ...authorization, validBefore: value } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(f.gateway.settlePayment).not.toHaveBeenCalled();
  });
  it("rejects a payment challenge not owned by the run owner", async () => {
    const f = fixture(); await f.create(); const original = f.store.payment.bind(f.store);
    vi.spyOn(f.store, "payment").mockImplementation((key, id) => original(key === owner ? otherOwner : key, id));
    expect((await f.runtime.runNext())?.status).toBe("failed"); expect(f.calls()).toBe(0); expect(f.gateway.settlePayment).not.toHaveBeenCalled();
  });
  it("enforces the run budget before any settlement or paid model call", async () => {
    const f = fixture(); await f.create({ maxBudgetUnits: "99" });
    expect((await f.runtime.runNext())?.errorCode).toBe("AGENT_BUDGET_LIMIT"); expect(f.calls()).toBe(0); expect(f.gateway.settlePayment).not.toHaveBeenCalled();
  });
  it("enforces the step count without charging for an extra step", async () => {
    const f = fixture(); f.decisions([{ action: "continue", output: "Continue" }]); await f.create({ maxSteps: 1 });
    expect((await f.runtime.runNext())?.status).toBe("exhausted"); expect(await f.runtime.runNext()).toBeUndefined(); expect(f.calls()).toBe(1);
  });
  it("stops before preparing a run whose deadline expired", async () => {
    const f = fixture(); await f.create({ deadlineAt: new Date(f.store.now + 1).toISOString() }); f.store.now += 2;
    expect((await f.runtime.runNext())?.status).toBe("exhausted"); expect(f.gateway.quote).not.toHaveBeenCalled();
  });
  it("does not invoke payment when deadline expires while committing its dispatch marker", async () => {
    const f = fixture({ leaseMs: 720_000 }); await f.create(); f.store.onChange = (kind) => { if (kind === "settlement_dispatched") f.store.now += 700_000; };
    expect((await f.runtime.runNext())?.status).toBe("outcome_unknown"); expect(f.gateway.settlePayment).not.toHaveBeenCalled();
  });
  it.each(["hello", { action: "shell", output: "run cmd" }, { action: "complete", output: "x", tools: ["shell"] }])("rejects arbitrary tool instructions and malformed decisions %#", async (decision) => {
    const f = fixture(); f.decisions([decision]); const run = await f.create();
    expect((await f.runtime.runNext())?.errorCode).toBe("AGENT_DECISION_INVALID");
    const result = await f.runtime.get(apiKey, run.id); expect(result.status).toBe("failed"); expect(result.receiptHash).toBe(hex); expect(result.spentUnits).toBe("100");
  });
  it("cancels queued and payment-paused runs idempotently", async () => {
    const f = fixture({ paymentMode: "authorized" }), a = await f.create(), b = await f.create();
    await f.runtime.cancel(apiKey, a.id); await f.runtime.cancel(apiKey, a.id);
    await f.runtime.runNext(); expect((await f.runtime.cancel(apiKey, b.id)).status).toBe("cancelled");
    expect(await f.runtime.runNext()).toBeUndefined(); expect(f.calls()).toBe(0);
  });
  it("records a known inference after concurrent cancellation but does not publish the cancelled result", async () => {
    const f = fixture(), run = await f.create(); const original = vi.mocked(f.gateway.infer).getMockImplementation()!;
    vi.spyOn(f.gateway, "infer").mockImplementation(async (input) => {
      if (input.paymentId) await f.runtime.cancel(apiKey, run.id); return original(input);
    });
    expect((await f.runtime.runNext())?.status).toBe("cancelled"); expect(f.calls()).toBe(1);
    const session = await f.gateway.openSession(apiKey, quote); expect((await f.runtime.get(apiKey, run.id, { sessionId: session.sessionId })).output).toBeUndefined();
  });
  it("does not infer after cancellation during settlement", async () => {
    const f = fixture(), run = await f.create(); const original = vi.mocked(f.gateway.settlePayment).getMockImplementation()!;
    vi.spyOn(f.gateway, "settlePayment").mockImplementation(async (...args) => { const r = await original(...args); await f.runtime.cancel(apiKey, run.id); return r; });
    const result = await f.runtime.runNext(); expect(result?.status).toBe("cancelled"); expect(result?.spentUnits).toBe("100"); expect(f.calls()).toBe(0);
  });
  it.each(["settlement_dispatched", "inference_dispatched"])("honors cancellation committed before locked %s admission", async (kind) => {
    const f = fixture(), run = await f.create(), original = f.store.change.bind(f.store); let intercepted = false;
    vi.spyOn(f.store, "change").mockImplementation(async (id, fence, mutate) => {
      if (!intercepted && mutate(clone(f.store.rows.get(id)!)).action.kind === kind) {
        intercepted = true; await f.runtime.cancel(apiKey, id);
      }
      return original(id, fence, mutate);
    });
    expect((await f.runtime.runNext())?.status).toBe("cancelled"); expect(f.calls()).toBe(0);
    expect(f.gateway.settlePayment).toHaveBeenCalledTimes(kind === "settlement_dispatched" ? 0 : 1);
    expect(f.store.journal.get(run.id)!.some((action) => action.kind === kind)).toBe(false);
    expect((await f.runtime.get(apiKey, run.id)).status).toBe("cancelled");
  });
  it("rejects dispatch when a row lock delay has consumed the lease", async () => {
    const f = fixture({ leaseMs: 1000 }), run = await f.create(), original = f.store.change.bind(f.store); let delayed = false;
    vi.spyOn(f.store, "change").mockImplementation(async (id, fence, mutate) => {
      if (!delayed && mutate(clone(f.store.rows.get(id)!)).action.kind === "settlement_dispatched") { delayed = true; f.store.now += 1001; }
      return original(id, fence, mutate);
    });
    expect((await f.runtime.runNext())?.status).toBe("running"); expect(f.gateway.settlePayment).not.toHaveBeenCalled();
    expect(f.store.journal.get(run.id)!.some((a) => a.kind === "settlement_dispatched")).toBe(false);
    await f.runtime.runNext(); expect((await f.runtime.get(apiKey, run.id)).status).toBe("outcome_unknown");
  });
  it("quarantines a provider timeout without blindly retrying or storing its exception", async () => {
    const f = fixture({ callTimeoutMs: 10 }), run = await f.create(); const original = vi.mocked(f.gateway.infer).getMockImplementation()!;
    vi.spyOn(f.gateway, "infer").mockImplementation((input) => input.paymentId ? new Promise(() => {}) : original(input));
    expect((await f.runtime.runNext())?.status).toBe("outcome_unknown"); expect(await f.runtime.runNext()).toBeUndefined();
    await expect(f.runtime.resume(apiKey, run.id)).rejects.toMatchObject({ code: "AGENT_RECONCILIATION_REQUIRED" });
    expect(f.gateway.infer).toHaveBeenCalledTimes(2);
  });
  it("recovers a committed inference after restart through read-only proof, never another POST", async () => {
    const f = fixture(), run = await f.create(); const original = vi.mocked(f.gateway.infer).getMockImplementation()!;
    vi.spyOn(f.gateway, "infer").mockImplementation(async (input) => { const r = await original(input); if (input.paymentId) throw new Error(`${apiKey} lost transport`); return r; });
    expect((await f.runtime.runNext())?.status).toBe("outcome_unknown");
    const restarted = new AgentRuntime(f.config); expect((await restarted.resume(apiKey, run.id)).status).toBe("completed"); expect(f.calls()).toBe(1);
    expect(JSON.stringify(await restarted.get(apiKey, run.id))).not.toContain(apiKey);
  });
  it("keeps committed settlement marker on checkpoint failure and reconciles without paying twice", async () => {
    const f = fixture(), run = await f.create(); f.store.failKind = "settlement_completed";
    expect((await f.runtime.runNext())?.status).toBe("outcome_unknown"); expect(f.calls()).toBe(0);
    expect((await f.runtime.resume(apiKey, run.id)).spentUnits).toBe("100");
    expect((await f.runtime.runNext())?.status).toBe("completed"); expect(f.gateway.settlePayment).toHaveBeenCalledOnce(); expect(f.calls()).toBe(1);
  });
  it("does not resume unknown settlement until a matching owner-owned settled intent exists", async () => {
    const f = fixture(), run = await f.create(); vi.spyOn(f.gateway, "settlePayment").mockRejectedValue(new Error("uncertain"));
    await f.runtime.runNext(); await expect(f.runtime.resume(apiKey, run.id)).rejects.toMatchObject({ code: "AGENT_RECONCILIATION_REQUIRED" }); expect(f.calls()).toBe(0);
  });
  it("quarantines an expired claimed run and fences stale workers", async () => {
    const f = fixture(), run = await f.create(); const claim = await f.store.claim(new Date(f.store.now), 1000);
    f.store.now += 1001; expect(await f.runtime.runNext()).toBeUndefined(); expect((await f.runtime.get(apiKey, run.id)).status).toBe("outcome_unknown");
    expect(await f.store.heartbeat(run.id, claim!.leaseToken!, new Date(f.store.now), 1000)).toBe(false);
    expect((await f.runtime.resume(apiKey, run.id)).status).toBe("queued"); expect((await f.runtime.runNext())?.status).toBe("completed");
  });
  it("does not quarantine a lease renewed after the expired-rows snapshot", async () => {
    const f = fixture(), run = await f.create(); await f.store.claim(new Date(f.store.now), 1000); f.store.now += 1001;
    f.store.onExpired = () => { f.store.rows.get(run.id)!.leaseUntil = new Date(f.store.now + 1000); };
    expect(await f.runtime.runNext()).toBeUndefined(); expect((await f.runtime.get(apiKey, run.id)).status).toBe("running");
  });
  it("rejects state swapping, altered run budgets, wrong host keys and journal tampering", async () => {
    const f = fixture(), a = await f.create(), b = await f.create(); const saved = f.store.rows.get(a.id)!.sealedState;
    f.store.rows.get(a.id)!.sealedState = f.store.rows.get(b.id)!.sealedState;
    await expect(f.runtime.get(apiKey, a.id)).rejects.toMatchObject({ code: "AGENT_STATE_UNAVAILABLE" });
    f.store.rows.get(a.id)!.sealedState = saved; f.store.rows.get(a.id)!.maxBudgetUnits++;
    await expect(f.runtime.get(apiKey, a.id)).rejects.toMatchObject({ code: "AGENT_STATE_UNAVAILABLE" }); f.store.rows.get(a.id)!.maxBudgetUnits--;
    await expect(new AgentRuntime({ ...f.config, hostSecret: Buffer.alloc(32, 44) }).get(apiKey, a.id)).rejects.toMatchObject({ code: "AGENT_STATE_UNAVAILABLE" });
    f.store.journal.get(a.id)![0]!.kind = "forged";
    await expect(f.runtime.get(apiKey, a.id)).rejects.toMatchObject({ code: "AGENT_JOURNAL_INVALID" });
  });
  it("retries a concurrent journal append before asserting snapshot integrity", async () => {
    const f = fixture(), run = await f.create(), actions = f.store.actions.bind(f.store); let appended = false;
    vi.spyOn(f.store, "actions").mockImplementation(async (id) => {
      if (!appended) { appended = true; await f.runtime.cancel(apiKey, id); } return actions(id);
    });
    const result = await f.runtime.get(apiKey, run.id);
    expect(result.status).toBe("cancelled"); expect(result.actions).toHaveLength(2);
    expect(f.store.actions).toHaveBeenCalledTimes(2);
  });
  it("bounds snapshot retries and returns conflict rather than a false corruption alarm", async () => {
    const f = fixture(), run = await f.create(), actions = f.store.actions.bind(f.store);
    vi.spyOn(f.store, "actions").mockImplementation(async (id) => { f.store.rows.get(id)!.version++; return actions(id); });
    await expect(f.runtime.get(apiKey, run.id)).rejects.toMatchObject({ code: "AGENT_STATE_CHANGED", statusCode: 409 });
    expect(f.store.actions).toHaveBeenCalledTimes(3);
  });
  it("stops an unrecoverable ciphertext before any model or payment operation", async () => {
    const f = fixture(), run = await f.create(); f.store.rows.get(run.id)!.sealedState = "corrupt";
    expect((await f.runtime.runNext())?.errorCode).toBe("AGENT_STATE_UNAVAILABLE");
    expect(f.gateway.infer).not.toHaveBeenCalled(); expect(f.gateway.settlePayment).not.toHaveBeenCalled();
  });
  it("refuses to use an expired session after external payment authorization", async () => {
    const f = fixture({ paymentMode: "authorized" }), run = await f.create(), open = vi.mocked(f.gateway.openSession).getMockImplementation()!;
    vi.mocked(f.gateway.openSession).mockImplementation(async (...args) => ({ ...await open(...args), expiresAt: new Date(f.store.now + 1000).toISOString() }));
    await f.runtime.runNext(); await f.runtime.resume(apiKey, run.id, { authorization }); f.store.now += 1001;
    expect((await f.runtime.runNext())?.errorCode).toBe("AGENT_SESSION_EXPIRED"); expect(f.gateway.settlePayment).not.toHaveBeenCalled();
  });
  it("requires current gateway session key release when exporting the result", async () => {
    const f = fixture(), run = await f.create(); await f.runtime.runNext(); const session = await f.gateway.openSession(apiKey, quote);
    vi.spyOn(f.gateway, "sessionWrapKeyForOwner").mockRejectedValue(new Error("TCB revoked"));
    await expect(f.runtime.get(apiKey, run.id, { sessionId: session.sessionId })).rejects.toThrow("TCB revoked");
  });
  it("paginates owner runs with a bounded stable UUID cursor", async () => {
    const f = fixture(); await f.create(); await f.create(); const first = await f.runtime.list(apiKey, undefined, 1), second = await f.runtime.list(apiKey, first[0]!.id, 1);
    expect(first).toHaveLength(1); expect(second).toHaveLength(1); expect(first[0]!.id).not.toBe(second[0]!.id);
  });
});

describe("agent runtime HTTP and configuration boundary", () => {
  it("is disabled by default, and disabled mode tolerates a non-local legacy mock profile", async () => {
    const f = fixture({ enabled: false, chainId: 5042002 }); expect(await f.runtime.runNext()).toBeUndefined(); await expect(f.create()).rejects.toMatchObject({ code: "AGENT_RUNTIME_DISABLED" });
  });
  it.each([{ hostSecret: Buffer.alloc(31) }, { paymentMode: "mock" as const, chainId: 1 }, { maxSteps: 0 }, { maxBudgetUnits: 0n }, { maxDurationMs: Infinity }, { leaseMs: 999 }, { callTimeoutMs: 360001 }])("rejects unsafe configuration %#", (config) => {
    expect(() => fixture(config)).toThrow();
  });
  it.each([{ maxSteps: 101 }, { maxSteps: 26 }, { maxBudgetUnits: "0" }, { maxBudgetUnits: "10000001" }, { deadlineAt: "invalid" }, { extra: "no" }, { goal: "" }])("rejects unbounded or malformed runs %#", async (changes) => {
    const f = fixture(); await expect(f.create(changes)).rejects.toMatchObject({ code: "VALIDATION_FAILED" }); expect(f.store.rows.size).toBe(0);
  });
  it("exposes create/get/list/cancel/resume and rejects malformed/oversized requests without leaking raw errors", async () => {
    const f = fixture(), app = createAgentRuntimeRoutes(f.runtime);
    const body = { agentId, goal, maxSteps: 1, maxBudgetUnits: "1000", deadlineAt: new Date(f.store.now + 600000).toISOString(), idempotencyKey: "http-create" };
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const created = await app.request("/", { method: "POST", headers, body: JSON.stringify(body) }); expect(created.status).toBe(201);
    const id = (await created.json() as { id: string }).id;
    expect((await app.request(`/${id}`, { headers })).status).toBe(200);
    expect((await app.request("/", { headers })).status).toBe(200);
    expect((await app.request(`/${id}/cancel`, { method: "POST", headers })).status).toBe(200);
    expect((await app.request(`/${id}/resume`, { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect((await app.request("/", { method: "POST", headers, body: "bad" })).status).toBe(400);
    expect((await app.request("/", { method: "POST", headers, body: "x".repeat(32769) })).status).toBe(413);
    expect((await app.request("/bad", { headers })).status).toBe(400);
    expect((await app.request(`/${id}`, { headers: { "x-api-key": otherKey } })).status).toBe(404);
    expect((await app.request("/?limit=0", { headers })).status).toBe(400);
    vi.spyOn(f.runtime, "list").mockRejectedValue(new Error(`${apiKey} ${goal}`));
    const failed = await app.request("/", { headers }); expect(failed.status).toBe(500); expect(await failed.text()).not.toContain("CANARY");
  });
});
