import { and, asc, eq, inArray } from "drizzle-orm";
import { chainEvents, models, type Database } from "@enclave/db";
import { z } from "zod";

export type RegistrySyncEvent =
  | { type: "Listed"; listingId: number; modelHash: string; codeHash: string; provider: string }
  | { type: "Approved"; listingId: number }
  | { type: "Revoked"; listingId: number };

const registryEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Listed"), listingId: z.number().int().positive().max(2_147_483_647), modelHash: z.string(), codeHash: z.string(), provider: z.string() }),
  z.object({ type: z.literal("Approved"), listingId: z.number().int().positive().max(2_147_483_647) }),
  z.object({ type: z.literal("Revoked"), listingId: z.number().int().positive().max(2_147_483_647) }),
]);

export function registryEventFromPayload(payload: string): RegistrySyncEvent {
  return z.object({ registryEvent: registryEventSchema }).parse(JSON.parse(payload)).registryEvent;
}

export async function applyRegistrySync(db: Pick<Database, "insert" | "update">, event: RegistrySyncEvent, scope = "legacy"): Promise<void> {
  // PostgreSQL listing_id is an int4; reject unsupported ids instead of truncating uint256.
  if (!Number.isInteger(event.listingId) || event.listingId < 1 || event.listingId > 2_147_483_647) {
    throw new RangeError("Registry listing id is outside the supported database range");
  }
  if (event.type === "Listed") {
    await db
      .insert(models)
      .values({
        modelHash: event.modelHash,
        codeHash: event.codeHash,
        version: "chain",
        provider: event.provider,
        approved: false,
        revoked: false,
        listingId: event.listingId,
        chainScope: scope,
      })
      .onConflictDoUpdate({
        target: [models.modelHash, models.codeHash],
        // Version, provider, listing fees and timestamps belong to the local model catalog.
        set: { listingId: event.listingId, chainScope: scope, approved: false, revoked: false },
      });
    return;
  }
  if (event.type === "Approved") {
    await db
      .update(models)
      .set({ approved: true, revoked: false })
      .where(and(eq(models.chainScope, scope), eq(models.listingId, event.listingId)));
    return;
  }
  await db
    .update(models)
    .set({ approved: false, revoked: true })
    .where(and(eq(models.chainScope, scope), eq(models.listingId, event.listingId)));
}

export async function quarantineRegistryScope(db: Pick<Database, "update">, scope: string): Promise<void> {
  await db.update(models).set({ approved: false, revoked: true }).where(eq(models.chainScope, scope));
}

/** Rebuild only chain-owned flags; orphaned listings remain disabled without deleting metadata. */
export async function rebuildRegistryPolicy(db: Pick<Database, "select" | "insert" | "update">, scope: string): Promise<void> {
  await db.update(models).set({ approved: false, revoked: true, listingId: null }).where(eq(models.chainScope, scope));
  const events = await db.select({ payload: chainEvents.payload }).from(chainEvents)
    .where(and(eq(chainEvents.scope, scope), inArray(chainEvents.source, ["ModelRegistry.Listed", "ModelRegistry.Approved", "ModelRegistry.Revoked"])))
    .orderBy(asc(chainEvents.blockNumber), asc(chainEvents.logIndex));
  for (const event of events) await applyRegistrySync(db, registryEventFromPayload(event.payload), scope);
}
