import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, lte } from "drizzle-orm";
import { agentRuns, agentActions, apiKeys, idempotencyKeys, payments, sessions, type Database } from "@enclave/db";
import { ConflictError, NotFoundError } from "@enclave/core";

export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentActionRow = typeof agentActions.$inferSelect;
export type AgentRunChange = { patch: Partial<AgentRunRow>; action: AgentActionRow };
export type RunFence = { owner?: string; token?: string; version?: number; now: Date; currentTime?: () => Date };
export interface AgentRunStore {
  hasOwner(owner: string): Promise<boolean>;
  insert(run: AgentRunRow, action: AgentActionRow): Promise<AgentRunRow>;
  get(owner: string, id: string): Promise<AgentRunRow>;
  list(owner: string, after: string | undefined, limit: number): Promise<AgentRunRow[]>;
  actions(id: string): Promise<AgentActionRow[]>;
  claim(now: Date, leaseMs: number): Promise<AgentRunRow | undefined>;
  expired(now: Date): Promise<AgentRunRow[]>;
  heartbeat(id: string, token: string, now: Date, leaseMs: number, currentTime?: () => Date): Promise<boolean>;
  change(id: string, fence: RunFence, mutate: (row: AgentRunRow) => AgentRunChange): Promise<AgentRunRow>;
  inference(owner: string, key: string): Promise<{ responseJson: string; typedHash: string } | undefined>;
  payment(owner: string, id: string): Promise<{ status: string; settleTx: string | null; amountUnits: bigint } | undefined>;
  ownedSession(owner: string, id: string, now: Date): Promise<boolean>;
}

export function assertRunFence(row: AgentRunRow | undefined, id: string, fence: RunFence): asserts row is AgentRunRow {
  const now = fence.currentTime?.() ?? fence.now;
  if (!row || (fence.owner && row.ownerKeyHash !== fence.owner)) throw new NotFoundError("agent run", id);
  if ((fence.version !== undefined && fence.version !== row.version) || (fence.token &&
    (row.status !== "running" || row.leaseToken !== fence.token || !row.leaseUntil || row.leaseUntil <= now))) {
    throw new ConflictError("Agent run lease or version changed");
  }
}

/** PostgreSQL row locks plus fencing tokens prevent independent runners from publishing stale results. */
export class PostgresAgentRunStore implements AgentRunStore {
  constructor(private readonly db: Database) {}
  async hasOwner(owner: string) { return (await this.db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.keyHash, owner)).limit(1)).length === 1; }
  async insert(run: AgentRunRow, action: AgentActionRow) {
    return this.db.transaction(async (tx) => {
      const [created] = await tx.insert(agentRuns).values(run).onConflictDoNothing({ target: [agentRuns.ownerKeyHash, agentRuns.idempotencyKey] }).returning();
      if (created) { await tx.insert(agentActions).values(action); return created; }
      const [prior] = await tx.select().from(agentRuns).where(and(eq(agentRuns.ownerKeyHash, run.ownerKeyHash), eq(agentRuns.idempotencyKey, run.idempotencyKey))).limit(1);
      if (!prior) throw new ConflictError("Agent run creation raced with deletion");
      return prior;
    });
  }
  async get(owner: string, id: string) {
    const [row] = await this.db.select().from(agentRuns).where(and(eq(agentRuns.id, id), eq(agentRuns.ownerKeyHash, owner))).limit(1);
    assertRunFence(row, id, { owner, now: new Date() }); return row;
  }
  list(owner: string, after: string | undefined, limit: number) {
    return this.db.select().from(agentRuns).where(and(eq(agentRuns.ownerKeyHash, owner), after ? gt(agentRuns.id, after) : undefined)).orderBy(asc(agentRuns.id)).limit(limit);
  }
  actions(id: string) { return this.db.select().from(agentActions).where(eq(agentActions.runId, id)).orderBy(asc(agentActions.sequence)); }
  async claim(now: Date, leaseMs: number) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(agentRuns).where(eq(agentRuns.status, "queued")).orderBy(asc(agentRuns.createdAt), asc(agentRuns.id)).limit(1).for("update", { skipLocked: true });
      if (!row) return undefined;
      const [claimed] = await tx.update(agentRuns).set({ status: "running", leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + leaseMs), version: row.version + 1, updatedAt: now })
        .where(and(eq(agentRuns.id, row.id), eq(agentRuns.version, row.version), eq(agentRuns.status, "queued"))).returning();
      return claimed;
    });
  }
  expired(now: Date) { return this.db.select().from(agentRuns).where(and(eq(agentRuns.status, "running"), lte(agentRuns.leaseUntil, now))).orderBy(asc(agentRuns.leaseUntil)).limit(100); }
  async heartbeat(id: string, token: string, now: Date, leaseMs: number, currentTime?: () => Date) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1).for("update");
      const admittedAt = currentTime?.() ?? now;
      if (!row || row.status !== "running" || row.leaseToken !== token || !row.leaseUntil || row.leaseUntil <= admittedAt) return false;
      await tx.update(agentRuns).set({ leaseUntil: new Date(admittedAt.getTime() + leaseMs) }).where(eq(agentRuns.id, id));
      return true;
    });
  }
  async change(id: string, fence: RunFence, mutate: (row: AgentRunRow) => AgentRunChange) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1).for("update");
      assertRunFence(row, id, fence);
      const change = mutate(row);
      const [updated] = await tx.update(agentRuns).set({ ...change.patch, version: row.version + 1, updatedAt: fence.currentTime?.() ?? fence.now,
        ledgerSequence: change.action.sequence, ledgerHead: change.action.actionHash })
        .where(and(eq(agentRuns.id, id), eq(agentRuns.version, row.version))).returning();
      if (!updated) throw new ConflictError("Agent run changed");
      await tx.insert(agentActions).values(change.action);
      return updated;
    });
  }
  async inference(owner: string, key: string) {
    const [row] = await this.db.select({ responseJson: idempotencyKeys.responseJson, typedHash: idempotencyKeys.typedHash }).from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.keyHash, owner), eq(idempotencyKeys.idempotencyKey, key))).limit(1); return row;
  }
  async payment(owner: string, id: string) {
    const [row] = await this.db.select({ status: payments.status, settleTx: payments.settleTx, amountUnits: payments.amountUnits }).from(payments)
      .where(and(eq(payments.keyHash, owner), eq(payments.id, id))).limit(1); return row;
  }
  async ownedSession(owner: string, id: string, now: Date) {
    return (await this.db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.apiKeyHash, owner), eq(sessions.id, id), gt(sessions.expiresAt, now))).limit(1)).length === 1;
  }
}
