import { eq, sql } from "drizzle-orm";
import { tcbPolicy, type Database } from "@enclave/db";
import { ConflictError, canonicalTcbPolicy, parseTcbPolicy, tcbPolicyRecord, sha256Hex, type TcbPolicy } from "@enclave/core";
import type { Config } from "./config.js";
import { verifyTcbApproval } from "./tcb-chain.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type TcbRow = typeof tcbPolicy.$inferSelect;
type Insert = typeof tcbPolicy.$inferInsert;
export type TcbState = ReturnType<typeof policyState>;
export type TcbTransaction = {
  list(): Promise<TcbRow[]>;
  insert(row: Insert): Promise<void>;
  update(version: number, patch: Partial<Insert>): Promise<void>;
};
export type TcbStore = {
  list(): Promise<TcbRow[]>;
  exclusive<T>(operation: (transaction: TcbTransaction) => Promise<T>): Promise<T>;
};
type Approval = typeof verifyTcbApproval;
const lockName = "enclave-software-tcb-lifecycle-v1";
const maximumVersion = 2_147_483_647;

export function createTcbStore(db: Database): TcbStore {
  return {
    list: () => db.select().from(tcbPolicy),
    exclusive: (operation) => db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockName}))`);
      return operation({
        list: () => tx.select().from(tcbPolicy),
        insert: async (row) => { await tx.insert(tcbPolicy).values(row); },
        update: async (version, patch) => { await tx.update(tcbPolicy).set(patch).where(eq(tcbPolicy.version, version)); },
      });
    }),
  };
}

function versionValid(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > maximumVersion) throw new ConflictError("Invalid software TCB version");
}
function mutationKey(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new ConflictError("Invalid TCB idempotency key");
  return value;
}
function policyOf(row: TcbRow): TcbPolicy {
  const policy = row.policyJson ? parseTcbPolicy(row.policyJson) : parseTcbPolicy(JSON.stringify({
    version: row.version, servingImageId: row.servingImageId, requireCpuTee: true, requireGpuCc: true,
  }));
  const record = tcbPolicyRecord(policy);
  if (row.version !== record.version || row.servingImageId !== record.servingImageId || row.measurement !== record.measurement
    || (row.policyHash !== null && row.policyHash !== record.policyHash)) throw new ConflictError("Stored software TCB policy is inconsistent");
  return policy;
}
function policyState(row: TcbRow) {
  if (!["pending", "active", "retired"].includes(row.status)) throw new ConflictError("Invalid software TCB state");
  return { ...tcbPolicyRecord(policyOf(row)), policy: policyOf(row), status: row.status as "pending" | "active" | "retired",
    binding: row.activationMode ?? "unapproved", scope: row.activationScope, activatedAt: row.activatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), trustMode: "development-software" as const };
}
function activeRow(rows: TcbRow[]): TcbRow {
  const active = rows.filter((row) => row.status === "active");
  if (active.length !== 1 || !["legacy", "onchain", "local-fixture"].includes(active[0]!.activationMode ?? "")) {
    throw new ConflictError("Exactly one initialized software TCB policy is required");
  }
  return active[0]!;
}

/** Persisted software policy control plane. It cannot update NEAR hardware policies. */
export class TcbLifecycle {
  private initialized: Promise<void> | undefined;
  constructor(private readonly store: TcbStore, private readonly config: Config, private readonly bootstrap: TcbPolicy,
    private readonly modelHash: `0x${string}`, private readonly approve: Approval = verifyTcbApproval) {}

  initialize(): Promise<void> {
    this.initialized ??= this.store.exclusive(async (tx) => {
      versionValid(this.bootstrap.version);
      const record = tcbPolicyRecord(this.bootstrap);
      const rows = await tx.list();
      const existing = rows.find((row) => row.version === record.version);
      if (existing && canonicalTcbPolicy(policyOf(existing)) !== canonicalTcbPolicy(this.bootstrap)) {
        throw new ConflictError("Configured TCB version already has a different immutable policy");
      }
      if (rows.some((row) => row.status === "active")) { activeRow(rows); return; }
      if (rows.some((row) => row.status !== "pending" || row.activationMode !== null || row.activatedAt !== null || row.activationKey !== null)) {
        throw new ConflictError("TCB activation history has no active policy; explicit recovery is required");
      }
      // Compatibility admission is explicitly legacy software state, never policy-approved hardware.
      const patch = { policyHash: record.policyHash, policyJson: canonicalTcbPolicy(this.bootstrap), status: "active",
        activationMode: "legacy", activationScope: null, activatedAt: new Date() };
      if (existing) await tx.update(record.version, patch);
      else await tx.insert({ ...record, ...patch });
    }).catch((error: unknown) => { this.initialized = undefined; throw error; });
    return this.initialized;
  }

  async current(): Promise<TcbState> {
    await this.initialize();
    return policyState(activeRow(await this.store.list()));
  }

  async list(): Promise<{ active: TcbState; history: TcbState[] }> {
    await this.initialize();
    const rows = await this.store.list();
    return { active: policyState(activeRow(rows)), history: rows.sort((a, b) => b.version - a.version).map(policyState) };
  }

  async propose(servingImageId: string, options: { version?: number; idempotencyKey?: string } = {}) {
    await this.initialize();
    return this.store.exclusive(async (tx) => {
      const rows = await tx.list();
      const current = activeRow(rows);
      const key = mutationKey(options.idempotencyKey ?? `proposal:${current.version}:${tcbPolicyRecord({
        ...policyOf(current), servingImageId, version: options.version ?? current.version,
      }).policyHash}`);
      const repeated = rows.find((row) => row.proposalKey === key);
      if (repeated) {
        if (repeated.servingImageId !== servingImageId || (options.version !== undefined && repeated.version !== options.version)) {
          throw new ConflictError("TCB idempotency key already has another proposal");
        }
        return { previous: policyState(current), recorded: policyState(repeated), servingUnchanged: true };
      }
      const version = options.version ?? Math.max(...rows.map((row) => row.version)) + 1;
      versionValid(version);
      const policy: TcbPolicy = { version, servingImageId, requireCpuTee: true, requireGpuCc: true };
      const record = tcbPolicyRecord(policy);
      const collision = rows.find((row) => row.version === version);
      if (collision) {
        if (canonicalTcbPolicy(policyOf(collision)) !== canonicalTcbPolicy(policy)) throw new ConflictError("TCB version already has another immutable policy");
        throw new ConflictError("TCB version was proposed under another idempotency key");
      }
      if (version <= current.version) throw new ConflictError("New TCB policy must advance the active version");
      await tx.insert({ ...record, policyJson: canonicalTcbPolicy(policy), status: "pending", proposalKey: key });
      const saved = (await tx.list()).find((row) => row.version === version)!;
      return { previous: policyState(current), recorded: policyState(saved), servingUnchanged: true };
    });
  }

  async activate(version: number, expectedActiveVersion: number, idempotencyKey?: string) {
    versionValid(version);
    versionValid(expectedActiveVersion);
    const key = mutationKey(idempotencyKey ?? `activation:${expectedActiveVersion}:${version}`);
    const requestHash = sha256Hex(JSON.stringify({ version, expectedActiveVersion }));
    await this.initialize();
    return this.store.exclusive(async (tx) => {
      const rows = await tx.list();
      const current = activeRow(rows);
      const target = rows.find((row) => row.version === version);
      const repeated = rows.find((row) => row.activationKey === key);
      if (repeated && (repeated.version !== version || repeated.activationRequestHash !== requestHash)) throw new ConflictError("TCB idempotency key already has another activation");
      if (!target) throw new ConflictError("Propose the TCB policy before activation");
      if (target.status === "active" && target.activationKey === key) return { previous: policyState(current), active: policyState(target), alreadyActive: true };
      if (current.version !== expectedActiveVersion) throw new ConflictError("Active TCB version changed; refresh before activation");
      if (target.status !== "pending" || version <= current.version) throw new ConflictError("Only a newer pending TCB policy can be activated");
      const state = policyState(target);
      const binding = this.config.ALLOW_LOCAL_BOOTSTRAP && this.config.ARC_CHAIN_ID === 31337
        ? { mode: "local-fixture" as const, scope: "local-fixture:31337" }
        : await this.approve(this.config, { modelHash: this.modelHash, codeHash: state.measurement, policyHash: state.policyHash, version });
      await tx.update(current.version, { status: "retired" });
      await tx.update(version, { status: "active", policyHash: state.policyHash, policyJson: canonicalTcbPolicy(state.policy),
        activationKey: key, activationRequestHash: requestHash, activationMode: binding.mode, activationScope: binding.scope, activatedAt: new Date() });
      return { previous: policyState(current), active: policyState((await tx.list()).find((row) => row.version === version)!), alreadyActive: false };
    });
  }
}

/** Hold only at publication/admission, never across remote inference. Activation serializes with this boundary. */
export async function assertCurrentTcb(tx: Tx, expectedHash: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${lockName}))`);
  const current = policyState(activeRow(await tx.select().from(tcbPolicy)));
  if (current.policyHash !== expectedHash) throw new ConflictError("TCB policy changed; open a new attested session");
}
