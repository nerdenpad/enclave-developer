import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, tcbPolicy, type Database } from "@enclave/db";
import { tcbPolicyHash, type TcbPolicy } from "@enclave/core";
import { loadConfig } from "./config.js";
import { assertCurrentTcb, createTcbStore, TcbLifecycle, type TcbStore } from "./tcb-lifecycle.js";
import type { verifyTcbApproval } from "./tcb-chain.js";

const policy: TcbPolicy = { version: 1, servingImageId: "isolated-tcb-bootstrap", requireCpuTee: true, requireGpuCc: true };
const modelHash = `0x${"82".repeat(32)}` as const;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("TCB lifecycle concurrency on real PostgreSQL", () => {
  const config = { ...loadConfig(), ALLOW_LOCAL_BOOTSTRAP: false };
  const admin = postgres(config.DATABASE_URL, { max: 1 });
  let connection: ReturnType<typeof postgres>;
  let db: Database;
  let ownedSchema: string;
  let store: TcbStore;
  let first: TcbLifecycle;
  let second: TcbLifecycle;
  const approve = vi.fn<typeof verifyTcbApproval>();

  beforeAll(() => { expect(process.env.ENCLAVE_INTEGRATION, "Use only the disposable integration runner").toBe("1"); });
  beforeEach(async () => {
    ownedSchema = `enclave_tcb_review_${randomUUID().replaceAll("-", "")}`;
    // Only this random schema is owned by this suite; active policy changes cannot leak into other suites.
    await admin.unsafe(`CREATE SCHEMA "${ownedSchema}"`);
    await admin.unsafe(`CREATE TABLE "${ownedSchema}".tcb_policy (LIKE public.tcb_policy INCLUDING ALL)`);
    connection = postgres(config.DATABASE_URL, { max: 5, connection: { search_path: ownedSchema, application_name: ownedSchema } });
    db = drizzle(connection, { schema });
    store = createTcbStore(db);
    approve.mockReset().mockResolvedValue({ mode: "onchain", scope: "31337:isolated-genesis:isolated-registry", listingId: 2n });
    first = new TcbLifecycle(store, config, policy, modelHash, approve);
    second = new TcbLifecycle(createTcbStore(db), config, policy, modelHash, approve);
  });
  afterEach(async () => {
    await connection?.end({ timeout: 5 });
    if (ownedSchema && /^enclave_tcb_review_[0-9a-f]{32}$/.test(ownedSchema)) await admin.unsafe(`DROP SCHEMA "${ownedSchema}" CASCADE`);
  });
  afterAll(async () => { await admin.end({ timeout: 5 }); });

  it("initializes exactly one active policy across independent lifecycle instances", async () => {
    await Promise.all([first.initialize(), second.initialize()]);
    const rows = await db.select().from(tcbPolicy);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1, status: "active", activationMode: "legacy" });
  });

  it("allocates distinct proposal versions under concurrent PostgreSQL advisory locks", async () => {
    const results = await Promise.all([
      first.propose("image-two", { idempotencyKey: "proposal-a" }),
      second.propose("image-three", { idempotencyKey: "proposal-b" }),
    ]);
    expect(results.map((row) => row.recorded.version).sort()).toEqual([2, 3]);
    const rows = await db.select().from(tcbPolicy);
    expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(2);
  });

  it("allows only one activation based on the same expected active version", async () => {
    await first.propose("image-two", { version: 2, idempotencyKey: "proposal-2" });
    await first.propose("image-three", { version: 3, idempotencyKey: "proposal-3" });
    const results = await Promise.allSettled([first.activate(2, 1, "activate-2"), second.activate(3, 1, "activate-3")]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((row) => row.status === "rejected")).toHaveLength(1);
    const rows = await db.select().from(tcbPolicy);
    const active = rows.filter((row) => row.status === "active");
    expect(active).toHaveLength(1);
    expect(rows.find((row) => row.version === 1)?.status).toBe("retired");
    const restarted = new TcbLifecycle(createTcbStore(db), config, policy, modelHash, approve);
    expect((await restarted.current()).version).toBe(active[0]!.version);
  });

  it("keeps explicit proposal versions and acknowledged idempotency keys immutable", async () => {
    const proposal = await first.propose("image-two", { version: 2, idempotencyKey: "stable" });
    expect((await second.propose("image-two", { version: 2, idempotencyKey: "stable" })).recorded.policyHash).toBe(proposal.recorded.policyHash);
    await expect(second.propose("image-three", { version: 2, idempotencyKey: "stable" })).rejects.toThrow("another proposal");
    await expect(second.propose("image-two", { version: 2, idempotencyKey: "unrecorded-alias" })).rejects.toThrow("another idempotency key");
    await first.activate(2, 1, "activation");
    expect((await second.activate(2, 1, "activation")).alreadyActive).toBe(true);
    await expect(second.activate(2, 99, "activation")).rejects.toThrow("another activation");
    expect(await db.select().from(tcbPolicy)).toHaveLength(2);
  });

  it("rolls back retirement when a failure occurs before the new policy becomes active", async () => {
    await first.propose("image-two", { version: 2 });
    const faulty: TcbStore = { ...store, exclusive: (operation) => store.exclusive((tx) => operation({ ...tx,
      update: async (version, patch) => {
        await tx.update(version, patch);
        if (version === 1 && patch.status === "retired") throw new Error("Injected failure after retirement");
      },
    })) };
    const failing = new TcbLifecycle(faulty, config, policy, modelHash, approve);
    await expect(failing.activate(2, 1)).rejects.toThrow("after retirement");
    expect((await first.current()).version).toBe(1);
    const rows = await db.select().from(tcbPolicy);
    expect(rows.find((row) => row.version === 2)?.status).toBe("pending");
  });

  it("holds activation until an already admitted publication transaction commits", async () => {
    await first.propose("image-two", { version: 2 });
    await second.initialize();
    const admitted = deferred(); const release = deferred();
    const publication = db.transaction(async (tx) => {
      await assertCurrentTcb(tx, tcbPolicyHash(policy));
      admitted.resolve(); await release.promise;
    });
    await admitted.promise;
    let activated = false;
    const activation = second.activate(2, 1).then((result) => { activated = true; return result; });
    try {
      await vi.waitFor(async () => {
        const waiters = await admin`SELECT pid FROM pg_stat_activity WHERE application_name = ${ownedSchema} AND wait_event_type = 'Lock'`;
        expect(waiters.length).toBeGreaterThan(0);
      }, { timeout: 5000 });
      expect(activated).toBe(false);
    } finally { release.resolve(); }
    await publication; await activation;
    expect((await first.current()).version).toBe(2);
  });

  it("rejects an in-flight transaction's old policy at publication after another instance activates", async () => {
    await first.propose("image-two", { version: 2 });
    await second.initialize();
    const started = deferred(); const finishInference = deferred();
    const inFlight = db.transaction(async (tx) => {
      // Establish the transaction before rotation, as inference does while awaiting its provider.
      await tx.select().from(tcbPolicy);
      started.resolve(); await finishInference.promise;
      await assertCurrentTcb(tx, tcbPolicyHash(policy));
    });
    await started.promise;
    try { await second.activate(2, 1); }
    finally { finishInference.resolve(); }
    await expect(inFlight).rejects.toThrow("TCB policy changed");
    expect((await first.current()).version).toBe(2);
  });
});
