import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalTcbPolicy, tcbPolicyRecord, type TcbPolicy } from "@enclave/core";
import { TcbLifecycle, type TcbRow, type TcbStore } from "./tcb-lifecycle.js";
import { loadConfig } from "./config.js";
import type { verifyTcbApproval } from "./tcb-chain.js";

const policy: TcbPolicy = { version: 1, servingImageId: "image-one", requireCpuTee: true, requireGpuCc: true };
const modelHash = `0x${"12".repeat(32)}` as const;
const config = loadConfig({ DATABASE_URL: "postgres://test.invalid/tcb", NODE_ENV: "test" });
const scope = "5042002:genesis:registry";

/** Atomic, serialized transactions with rollback; deliberately independent of Drizzle's SQL adapter. */
function memoryStore(initial: TcbRow[] = []) {
  let rows = structuredClone(initial);
  let tail = Promise.resolve();
  const store: TcbStore = {
    list: async () => structuredClone(rows),
    exclusive: (operation) => {
      const pending = tail.then(async () => {
        let snapshot = structuredClone(rows);
        const value = await operation({
          list: async () => structuredClone(snapshot),
          insert: async (row) => {
            if (snapshot.some((existing) => existing.version === row.version)) throw new Error("unique version");
            snapshot.push({ id: randomUUID(), createdAt: new Date(), policyHash: null, policyJson: null, status: "pending",
              proposalKey: null, activationKey: null, activationRequestHash: null, activationMode: null, activationScope: null,
              activatedAt: null, ...row } as TcbRow);
          },
          update: async (version, patch) => { snapshot = snapshot.map((row) => row.version === version ? { ...row, ...patch } as TcbRow : row); },
        });
        rows = snapshot;
        return value;
      });
      tail = pending.then(() => undefined, () => undefined);
      return pending;
    },
  };
  return store;
}
function fixture(initial: TcbRow[] = [], options = config) {
  const store = memoryStore(initial);
  const approve = vi.fn<typeof verifyTcbApproval>().mockResolvedValue({ mode: "onchain", scope, listingId: 2n });
  return { store, approve, lifecycle: new TcbLifecycle(store, options, policy, modelHash, approve) };
}

describe("durable software TCB lifecycle", () => {
  it("bootstraps legacy software state once across concurrent processes without claiming chain approval", async () => {
    const { store, approve, lifecycle } = fixture();
    const other = new TcbLifecycle(store, config, policy, modelHash, approve);
    const [first, second] = await Promise.all([lifecycle.current(), other.current()]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "active", binding: "legacy", trustMode: "development-software", version: 1 });
    expect((await store.list())).toHaveLength(1);
    expect(approve).not.toHaveBeenCalled();
  });

  it("rejects same-version configuration or stored commitment collisions", async () => {
    const { store, approve, lifecycle } = fixture();
    await lifecycle.initialize();
    await expect(new TcbLifecycle(store, config, { ...policy, servingImageId: "collision" }, modelHash, approve).initialize()).rejects.toThrow("different immutable policy");
    const corrupted = await store.list();
    corrupted[0]!.policyHash = `0x${"ff".repeat(32)}`;
    await expect(fixture(corrupted).lifecycle.initialize()).rejects.toThrow("inconsistent");
  });

  it("migrates exact legacy rows without overwriting their policy identity", async () => {
    const legacy = { id: randomUUID(), ...tcbPolicyRecord(policy), policyHash: null, policyJson: null, status: "pending", createdAt: new Date(),
      proposalKey: null, activationKey: null, activationRequestHash: null, activationMode: null, activationScope: null, activatedAt: null } as TcbRow;
    const { store, lifecycle } = fixture([legacy]);
    expect((await lifecycle.current()).binding).toBe("legacy");
    expect((await store.list())[0]).toMatchObject({ id: legacy.id, policyJson: canonicalTcbPolicy(policy), status: "active" });
  });

  it("never silently bootstraps an older policy when activation history has lost its active row", async () => {
    const { store, lifecycle } = fixture();
    await lifecycle.propose("two");
    await lifecycle.activate(2, 1);
    const corrupt = (await store.list()).map((row) => ({ ...row, status: "retired" }));
    const restarted = fixture(corrupt);
    await expect(restarted.lifecycle.initialize()).rejects.toThrow("explicit recovery");
    expect((await restarted.store.list()).every((row) => row.status === "retired")).toBe(true);
  });

  it("proposes pending policy idempotently without changing active serving", async () => {
    const { lifecycle, approve } = fixture();
    const a = await lifecycle.propose("image-two", { idempotencyKey: "proposal-one" });
    const b = await lifecycle.propose("image-two", { idempotencyKey: "proposal-one" });
    expect(b).toEqual(a);
    expect(a.recorded).toMatchObject({ version: 2, status: "pending", binding: "unapproved", servingImageId: "image-two" });
    expect(a.servingUnchanged).toBe(true);
    expect((await lifecycle.current()).version).toBe(1);
    expect(approve).not.toHaveBeenCalled();
    await expect(lifecycle.propose("changed", { idempotencyKey: "proposal-one" })).rejects.toThrow("another proposal");
    await expect(lifecycle.propose("image-two", { version: 2, idempotencyKey: "different-key" })).rejects.toThrow("another idempotency key");
    await expect(lifecycle.propose("changed", { version: 2 })).rejects.toThrow("another immutable policy");
  });

  it("allocates unique versions for concurrent proposals and deduplicates implicit retries", async () => {
    const { lifecycle } = fixture();
    const results = await Promise.all(["a", "b", "c"].map((image) => lifecycle.propose(image)));
    expect(results.map((item) => item.recorded.version).sort()).toEqual([2, 3, 4]);
    expect((await lifecycle.propose("a")).recorded.version).toBe(2);
    expect((await lifecycle.list()).history).toHaveLength(4);
  });

  it("requires exact onchain approval and atomically retains the previous policy on failure", async () => {
    const { lifecycle, approve } = fixture();
    const pending = (await lifecycle.propose("image-two")).recorded;
    approve.mockRejectedValueOnce(new Error("unapproved policy"));
    await expect(lifecycle.activate(2, 1, "activate-two")).rejects.toThrow("unapproved policy");
    expect((await lifecycle.current()).version).toBe(1);
    expect((await lifecycle.list()).history[0]!.status).toBe("pending");
    const result = await lifecycle.activate(2, 1, "activate-two");
    expect(approve).toHaveBeenLastCalledWith(config, { modelHash, codeHash: pending.measurement, policyHash: pending.policyHash, version: 2 });
    expect(result.active).toMatchObject({ version: 2, binding: "onchain", scope, status: "active" });
    expect((await lifecycle.list()).history.find((row) => row.version === 1)!.status).toBe("retired");
  });

  it("persists activation across restart and compares the complete replay request", async () => {
    const { lifecycle, store, approve } = fixture();
    await lifecycle.propose("image-two");
    await lifecycle.activate(2, 1, "activation");
    const restarted = new TcbLifecycle(store, config, policy, modelHash, approve);
    expect((await restarted.current()).version).toBe(2);
    expect((await restarted.activate(2, 1, "activation")).alreadyActive).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    await expect(restarted.activate(2, 999, "activation")).rejects.toThrow("another activation");
    await expect(restarted.activate(1, 2, "activation")).rejects.toThrow("another activation");
    await expect(restarted.activate(1, 2)).rejects.toThrow("newer pending");
  });

  it("uses a predecessor CAS so racing activations cannot overwrite each other", async () => {
    const { lifecycle } = fixture();
    await lifecycle.propose("two");
    await lifecycle.propose("three");
    const outcomes = await Promise.allSettled([lifecycle.activate(2, 1, "a"), lifecycle.activate(3, 1, "b")]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((await lifecycle.list()).history.filter((row) => row.status === "active")).toHaveLength(1);
  });

  it.each([{ chain: 31337, enabled: true, fixture: true }, { chain: 31337, enabled: false, fixture: false },
    { chain: 1337, enabled: true, fixture: false }, { chain: 5042002, enabled: true, fixture: false }])(
    "allows explicit local fixture only on chain31337: $chain / $enabled", async ({ chain, enabled, fixture: allowed }) => {
      const settings = { ...config, ARC_CHAIN_ID: chain, ALLOW_LOCAL_BOOTSTRAP: enabled };
      const { lifecycle, approve } = fixture([], settings);
      await lifecycle.propose("two");
      const result = await lifecycle.activate(2, 1);
      expect(result.active.binding).toBe(allowed ? "local-fixture" : "onchain");
      expect(approve).toHaveBeenCalledTimes(allowed ? 0 : 1);
    });

  it.each([0, -1, 2_147_483_648, 1.5, NaN])("rejects invalid activation version %s", async (version) => {
    await expect(fixture().lifecycle.activate(version, 1)).rejects.toThrow("Invalid software TCB version");
  });

  it("rejects missing proposals, stale expectations, invalid mutation keys and malformed policy content", async () => {
    const { lifecycle } = fixture();
    await expect(lifecycle.activate(2, 1)).rejects.toThrow("Propose");
    await lifecycle.propose("two");
    await expect(lifecycle.activate(2, 3)).rejects.toThrow("changed");
    await expect(lifecycle.activate(2, 1, "bad key")).rejects.toThrow("idempotency");
    await expect(lifecycle.propose("two", { idempotencyKey: "bad key" })).rejects.toThrow("idempotency");
    await expect(lifecycle.propose(" ")).rejects.toThrow("Invalid development TCB policy");
  });
});
