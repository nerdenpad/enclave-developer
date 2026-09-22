import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_RUNTIME_SQL, agentActions, agentRuns, apiKeys, idempotencyKeys, payments, schema, sessions, type Database } from "@enclave/db";
import { PaymentRequiredError, sha256Hex, type AttestationQuote } from "@enclave/core";
import { loadConfig } from "./config.js";
import { AgentRuntime, type AgentRuntimeGateway } from "./agent-runtime.js";
import { PostgresAgentRunStore, type AgentActionRow, type AgentRunRow, type AgentRunStore } from "./agent-runtime-store.js";

const origin = new Date("2030-01-01T00:00:00.000Z");
const owner = `0x${"51".repeat(32)}`;
const otherOwner = `0x${"52".repeat(32)}`;
const zeroHash = `0x${"00".repeat(32)}`;
const at = (milliseconds: number) => new Date(origin.getTime() + milliseconds);
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function actionFor(row: AgentRunRow, kind = "progress"): AgentActionRow {
  return { id: randomUUID(), runId: row.id, sequence: row.ledgerSequence + 1, kind,
    previousHash: row.ledgerHead, actionHash: hash(row.ledgerSequence + 1),
    sealedPayload: JSON.stringify({ ciphertext: "opaque-fixture" }), createdAt: at(row.ledgerSequence + 1) };
}

function fixture(overrides: Partial<AgentRunRow> = {}) {
  const run: AgentRunRow = { id: randomUUID(), ownerKeyHash: owner, agentId: randomUUID(),
    idempotencyKey: randomUUID(), requestHash: hash(11), status: "queued", step: 0, maxSteps: 5,
    maxBudgetUnits: 1_000n, spentUnits: 0n, deadlineAt: at(60_000), sealedState: "opaque-sealed-state",
    version: 0, leaseToken: null, leaseUntil: null, cancelRequested: false, errorCode: null,
    paymentId: null, receiptHash: null, ledgerSequence: 0, ledgerHead: zeroHash, createdAt: origin, updatedAt: origin,
    ...overrides };
  const action = actionFor(run, "created");
  run.ledgerSequence = action.sequence;
  run.ledgerHead = action.actionHash;
  return { run, action };
}

describe("agent runtime store concurrency on real PostgreSQL", () => {
  const config = loadConfig();
  const admin = postgres(config.DATABASE_URL, { max: 1 });
  let connection: ReturnType<typeof postgres>;
  let db: Database;
  let ownedSchema: string;
  let first: PostgresAgentRunStore;
  let second: PostgresAgentRunStore;

  function connect() {
    connection = postgres(config.DATABASE_URL, { max: 5, connection: { search_path: ownedSchema, application_name: ownedSchema } });
    db = drizzle(connection, { schema });
    first = new PostgresAgentRunStore(db);
    second = new PostgresAgentRunStore(db);
  }

  async function insert(overrides: Partial<AgentRunRow> = {}) {
    const value = fixture(overrides);
    return first.insert(value.run, value.action);
  }

  beforeAll(() => { expect(process.env.ENCLAVE_INTEGRATION, "Use only the disposable integration runner").toBe("1"); });
  beforeEach(async () => {
    ownedSchema = `enclave_agent_store_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA "${ownedSchema}"`);
    // Dependencies are empty copies; mutations and constraints remain inside this suite's private schema.
    for (const table of ["api_keys", "sessions", "payments", "idempotency_keys"]) {
      await admin.unsafe(`CREATE TABLE "${ownedSchema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    connect();
    await connection.unsafe(AGENT_RUNTIME_SQL);
    await db.insert(apiKeys).values([{ keyHash: owner, label: "runtime-owner" }, { keyHash: otherOwner, label: "other-owner" }]);
  });
  afterEach(async () => {
    await connection?.end({ timeout: 5 });
    if (ownedSchema && /^enclave_agent_store_[0-9a-f]{32}$/.test(ownedSchema)) await admin.unsafe(`DROP SCHEMA "${ownedSchema}" CASCADE`);
  });
  afterAll(async () => { await admin.end({ timeout: 5 }); });

  it("creates one run and one initial action for concurrent owner/idempotency retries", async () => {
    const inputs = Array.from({ length: 6 }, () => fixture({ idempotencyKey: "same-create" }));
    const results = await Promise.all(inputs.map((value, index) => (index % 2 ? first : second).insert(value.run, value.action)));
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(await db.select().from(agentRuns)).toHaveLength(1);
    expect(await first.actions(results[0]!.id)).toHaveLength(1);
    expect(results.every((row) => row.ledgerSequence === 1 && row.version === 0)).toBe(true);
    const changed = fixture({ idempotencyKey: "same-create", requestHash: hash(99) });
    // The caller can compare the returned immutable requestHash and reject altered retry parameters.
    expect((await second.insert(changed.run, changed.action)).requestHash).toBe(hash(11));
  });

  it("isolates owners while allowing the same idempotency key and stable paginated listing", async () => {
    const ours = await insert({ idempotencyKey: "shared-key" });
    const theirs = await insert({ ownerKeyHash: otherOwner, idempotencyKey: "shared-key" });
    await insert();
    expect(await first.hasOwner(owner)).toBe(true);
    expect(await first.hasOwner(hash(999))).toBe(false);
    await expect(second.get(otherOwner, ours.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(first.get(owner, theirs.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const listed = await first.list(owner, undefined, 10);
    expect(listed).toHaveLength(2);
    expect(listed.every((row) => row.ownerKeyHash === owner)).toBe(true);
    expect(listed.map((row) => row.id)).toEqual([...listed.map((row) => row.id)].sort());
    expect((await second.list(owner, listed[0]!.id, 1)).map((row) => row.id)).toEqual([listed[1]!.id]);
    const mutate = vi.fn(() => ({ patch: { status: "cancelled" }, action: actionFor(ours) }));
    await expect(second.change(ours.id, { owner: otherOwner, now: origin }, mutate)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("allows exactly one independent runner to claim the only queued run", async () => {
    const original = await insert();
    const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).claim(origin, 1_000)));
    const winners = claims.filter((row) => row !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ id: original.id, status: "running", version: 1, leaseUntil: at(1_000) });
    expect(winners[0]!.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(await first.actions(original.id)).toHaveLength(1);
    expect(await second.claim(origin, 1_000)).toBeUndefined();
  });

  it("skips a locked oldest row and claims another queued run without waiting", async () => {
    const oldest = await insert({ createdAt: at(-1_000) });
    const next = await insert();
    const locked = deferred(), release = deferred();
    const holder = db.transaction(async (tx) => {
      await tx.select().from(agentRuns).where(eq(agentRuns.id, oldest.id)).for("update");
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      const claimed = await second.claim(origin, 1_000);
      expect(claimed?.id).toBe(next.id);
      expect((await first.get(owner, oldest.id)).status).toBe("queued");
    } finally { release.resolve(); await holder; }
    expect((await first.claim(origin, 1_000))?.id).toBe(oldest.id);
  });

  it("fences expired and replaced lease tokens before invoking a stale publisher", async () => {
    const original = await insert();
    const stale = (await first.claim(origin, 1_000))!;
    const mutate = vi.fn(() => ({ patch: { status: "completed" }, action: actionFor(stale) }));
    await expect(first.change(original.id, { token: stale.leaseToken!, now: at(1_000) }, mutate)).rejects.toMatchObject({ code: "CONFLICT" });
    const requeued = await second.change(original.id, { owner, version: stale.version, now: at(1_000) }, (row) => ({
      patch: { status: "queued", leaseToken: null, leaseUntil: null }, action: actionFor(row, "recovered"),
    }));
    const current = (await second.claim(at(1_001), 1_000))!;
    expect(current.leaseToken).not.toBe(stale.leaseToken);
    expect(current.version).toBe(requeued.version + 1);
    await expect(first.change(original.id, { token: stale.leaseToken!, now: at(1_002) }, mutate)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mutate).not.toHaveBeenCalled();
    expect(await first.heartbeat(original.id, stale.leaseToken!, at(1_002), 1_000)).toBe(false);
    const completed = await second.change(original.id, { token: current.leaseToken!, now: at(1_002) }, (row) => ({
      patch: { status: "completed", leaseToken: null, leaseUntil: null }, action: actionFor(row, "completed"),
    }));
    expect(completed).toMatchObject({ status: "completed", ledgerSequence: 3, ledgerHead: hash(3) });
    expect((await first.actions(original.id)).map((row) => row.kind)).toEqual(["created", "recovered", "completed"]);
  });

  it("allows only one writer using the same optimistic version and commits a matching ledger head", async () => {
    const original = await insert();
    const writes = await Promise.allSettled([first, second].map((store) => store.change(original.id,
      { owner, version: original.version, now: at(1) }, (row) => ({ patch: { cancelRequested: true }, action: actionFor(row, "cancel_requested") }))));
    expect(writes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((row) => row.status === "rejected")).toHaveLength(1);
    const saved = await first.get(owner, original.id), actions = await second.actions(original.id);
    expect(saved).toMatchObject({ cancelRequested: true, version: 1, ledgerSequence: 2 });
    expect(actions).toHaveLength(2);
    expect(saved.ledgerHead).toBe(actions[1]!.actionHash);
    expect(actions[1]!.previousHash).toBe(actions[0]!.actionHash);
  });

  it("keeps heartbeat renewal fenced and excludes the renewed row from the expiry snapshot", async () => {
    const original = await insert();
    const claimed = (await first.claim(origin, 1_000))!;
    expect(await second.heartbeat(original.id, randomUUID(), at(500), 1_000)).toBe(false);
    expect(await second.heartbeat(original.id, claimed.leaseToken!, at(999), 1_000)).toBe(true);
    expect((await first.get(owner, original.id)).version).toBe(claimed.version);
    expect(await first.expired(at(1_000))).toHaveLength(0);
    expect((await first.expired(at(1_999))).map((row) => row.id)).toEqual([original.id]);
    expect(await second.heartbeat(original.id, claimed.leaseToken!, at(1_999), 1_000)).toBe(false);
  });

  it("rechecks a renewed lease under the row lock before an expiry worker publishes recovery", async () => {
    const original = await insert();
    const claimed = (await first.claim(origin, 1_000))!;
    const runtimeStore: AgentRunStore = first;
    const scan = vi.spyOn(runtimeStore, "expired").mockImplementationOnce(async (now) => {
      const staleSnapshot = await second.expired(now);
      expect(staleSnapshot.map((row) => row.id)).toEqual([original.id]);
      // A heartbeat sampled its timestamp before expiration but completes after the expiry scan.
      expect(await second.heartbeat(original.id, claimed.leaseToken!, at(999), 1_000)).toBe(true);
      return staleSnapshot;
    });
    const gateway: AgentRuntimeGateway = { quote: vi.fn(), openSession: vi.fn(), sessionWrapKey: vi.fn(),
      sessionWrapKeyForOwner: vi.fn(), getAgent: vi.fn(), infer: vi.fn(), settlePayment: vi.fn() };
    const runtime = new AgentRuntime({ store: first, gateway, hostSecret: Buffer.alloc(32, 3), enabled: true,
      paymentMode: "mock", chainId: 31337, leaseMs: 1_000, now: () => at(1_001).getTime() });
    expect(await runtime.runNext()).toBeUndefined();
    expect(scan).toHaveBeenCalledOnce();
    expect(await second.get(owner, original.id)).toMatchObject({ status: "running", version: claimed.version,
      leaseToken: claimed.leaseToken, leaseUntil: at(1_999), errorCode: null });
    expect(await second.actions(original.id)).toHaveLength(1);
    expect(gateway.infer).not.toHaveBeenCalled();
  });

  it.each(["settlement_dispatched", "inference_dispatched"] as const)("rejects %s when its live lease expires while waiting for a PostgreSQL row lock", async (dispatchKind) => {
    const credential = `isolated-runtime-${randomUUID()}`, runOwner = sha256Hex(credential);
    await db.insert(apiKeys).values({ keyHash: runOwner, label: "delayed-dispatch-owner" });
    let clock = origin.getTime();
    const paymentId = randomUUID(), sessionId = randomUUID(), wrapKey = Buffer.alloc(32, 7);
    const quote: AttestationQuote = { cpuQuote: "local-fixture", gpuQuote: "local-fixture", measurement: hash(83) as `0x${string}`,
      tcbVersion: 1, timestamp: clock, signature: `0x${"12".repeat(65)}` };
    const gateway: AgentRuntimeGateway = {
      quote: vi.fn(async () => quote), getAgent: vi.fn(async (_key, id) => ({ id })),
      openSession: vi.fn(async () => ({ sessionId, expiresAt: at(300_000).toISOString() })),
      sessionWrapKey: vi.fn(() => wrapKey), sessionWrapKeyForOwner: vi.fn(async () => wrapKey),
      infer: vi.fn(async (input) => {
        if (input.paymentId) throw new Error("Paid inference must not start after lease expiry");
        await db.insert(payments).values({ id: paymentId, keyHash: runOwner, amountUnits: 100n, status: "open" });
        throw new PaymentRequiredError("required", { x402Version: 1, accepts: [{ scheme: "exact", network: "arc-31337",
          maxAmountRequired: "100", asset: `0x${"11".repeat(20)}`, payTo: `0x${"22".repeat(20)}`,
          extra: { paymentId, receiptPending: true } }] });
      }),
      settlePayment: vi.fn(async (_key, id) => {
        await db.update(payments).set({ status: "settled", settleTx: hash(84) }).where(eq(payments.id, id));
        return { paymentId: id, tx: hash(84), confidential: false };
      }),
    };
    const runtime = new AgentRuntime({ store: first, gateway, hostSecret: Buffer.alloc(32, 8), enabled: true,
      paymentMode: "mock", chainId: 31337, leaseMs: 60_000, now: () => clock });
    const created = await runtime.create(credential, { agentId: randomUUID(), goal: "Exercise delayed dispatch admission",
      maxSteps: 2, maxBudgetUnits: "1000", deadlineAt: at(300_000).toISOString(), idempotencyKey: "delayed-dispatch" });
    const precedingKind = dispatchKind === "settlement_dispatched" ? "payment_required" : "settlement_completed";
    const realChange = first.change.bind(first);
    let intercepted = false, observedLockWait = false;
    let before: AgentRunRow | undefined, beforeActions: AgentActionRow[] | undefined;
    vi.spyOn(first, "change").mockImplementation(async (id, fence, mutate) => {
      const actions = await second.actions(id);
      if (intercepted || actions.at(-1)?.kind !== precedingKind) return realChange(id, fence, mutate);
      intercepted = true;
      const locked = deferred(), release = deferred();
      const holder = db.transaction(async (tx) => {
        await tx.select().from(agentRuns).where(eq(agentRuns.id, id)).for("update");
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      before = await second.get(runOwner, id); beforeActions = actions;
      expect(before.leaseUntil!.getTime()).toBeGreaterThan(fence.now.getTime());
      // The real store begins its transaction with the earlier fence timestamp and blocks on FOR UPDATE.
      const blockedWrite = realChange(id, fence, mutate);
      void blockedWrite.catch(() => undefined);
      try {
        await vi.waitFor(async () => {
          const waiters = await admin`SELECT pid FROM pg_stat_activity WHERE application_name = ${ownedSchema} AND wait_event_type = 'Lock'`;
          expect(waiters.length).toBeGreaterThan(0);
        }, { timeout: 5_000, interval: 20 });
        observedLockWait = true;
        clock = before.leaseUntil!.getTime() + 1;
      } finally { release.resolve(); await holder; }
      return blockedWrite;
    });
    const result = await runtime.runNext();
    expect(observedLockWait).toBe(true);
    expect(result).toMatchObject({ id: created.id, status: "running" });
    expect(await second.get(runOwner, created.id)).toEqual(before);
    expect(await second.actions(created.id)).toEqual(beforeActions);
    expect(gateway.settlePayment).toHaveBeenCalledTimes(dispatchKind === "settlement_dispatched" ? 0 : 1);
    expect(gateway.infer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gateway.infer).mock.calls[0]![0].paymentId).toBeUndefined();
  });

  it("rolls back a newly inserted run when its initial action cannot commit", async () => {
    const existing = fixture();
    await first.insert(existing.run, existing.action);
    const failing = fixture();
    failing.action.id = existing.action.id;
    await expect(second.insert(failing.run, failing.action)).rejects.toThrow();
    await expect(first.get(owner, failing.run.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.select().from(agentRuns)).toHaveLength(1);
    expect(await db.select().from(agentActions)).toHaveLength(1);
  });

  it("rolls back both progress and ledger head when an action violates the unique sequence constraint", async () => {
    const original = await insert();
    await expect(second.change(original.id, { owner, version: original.version, now: at(10) }, (row) => ({
      patch: { status: "completed", spentUnits: 75n, receiptHash: hash(77) },
      action: { ...actionFor(row), sequence: 1 },
    }))).rejects.toThrow();
    expect(await first.get(owner, original.id)).toEqual(original);
    expect(await first.actions(original.id)).toHaveLength(1);
  });

  it("enforces budget constraints atomically before adding a ledger action", async () => {
    const original = await insert({ maxBudgetUnits: 100n });
    await expect(first.change(original.id, { owner, version: original.version, now: at(10) }, (row) => ({
      patch: { spentUnits: 101n }, action: actionFor(row, "settlement_completed"),
    }))).rejects.toThrow();
    expect((await second.get(owner, original.id)).spentUnits).toBe(0n);
    expect(await second.actions(original.id)).toHaveLength(1);
  });

  it("retrieves committed payment and inference proofs after reconnecting without leaking another owner's records", async () => {
    const original = await insert();
    const paid = randomUUID(), session = randomUUID(), expired = randomUUID();
    const responseJson = JSON.stringify({ typedHash: hash(45), output: { ciphertext: "persisted-encrypted-result" } });
    await db.insert(payments).values({ id: paid, keyHash: owner, amountUnits: 75n, status: "settled", settleTx: hash(44) });
    await db.insert(idempotencyKeys).values([
      { keyHash: owner, idempotencyKey: "agent-run:durable-step", typedHash: hash(45), responseJson },
      { keyHash: otherOwner, idempotencyKey: "agent-run:durable-step", typedHash: hash(46), responseJson: "other-owner-response" },
    ]);
    await db.insert(sessions).values([
      { id: session, apiKeyHash: owner, attRef: hash(47), expiresAt: at(1_000) },
      { id: expired, apiKeyHash: owner, attRef: hash(48), expiresAt: origin },
    ]);
    const saved = await first.change(original.id, { owner, version: original.version, now: at(1) }, (row) => ({
      patch: { status: "outcome_unknown", paymentId: paid, receiptHash: hash(45), spentUnits: 75n,
        errorCode: "AGENT_RECONCILIATION_REQUIRED" }, action: actionFor(row, "inference_dispatched"),
    }));
    await connection.end({ timeout: 5 });
    connect();
    expect(await first.get(owner, original.id)).toEqual(saved);
    expect((await first.actions(original.id)).map((row) => row.sequence)).toEqual([1, 2]);
    expect(await first.payment(owner, paid)).toEqual({ status: "settled", settleTx: hash(44), amountUnits: 75n });
    expect(await first.payment(otherOwner, paid)).toBeUndefined();
    expect(await first.payment(owner, randomUUID())).toBeUndefined();
    expect(await first.inference(owner, "agent-run:durable-step")).toEqual({ typedHash: hash(45), responseJson });
    expect(await first.inference(otherOwner, "agent-run:durable-step")).toEqual({ typedHash: hash(46), responseJson: "other-owner-response" });
    expect(await first.inference(owner, "missing-step")).toBeUndefined();
    expect(await first.ownedSession(owner, session, origin)).toBe(true);
    expect(await first.ownedSession(otherOwner, session, origin)).toBe(false);
    expect(await first.ownedSession(owner, expired, origin)).toBe(false);
    expect(await first.ownedSession(owner, randomUUID(), origin)).toBe(false);
  });
});
