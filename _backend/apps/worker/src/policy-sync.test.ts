import { describe, expect, it } from "vitest";
import { models } from "@enclave/db";
import { applyRegistrySync } from "./policy-sync.js";
import { sqlQuery, testDb } from "./test-db.js";

describe("registry policy synchronization", () => {
  it("creates an unapproved listing and resets a cached approval on conflict", async () => {
    const mock = testDb();
    await applyRegistrySync(mock.db, { type: "Listed", listingId: 7, modelHash: "model", codeHash: "code", provider: "provider" });
    expect(mock.insert).toHaveBeenCalledWith(models);
    expect(mock.values).toHaveBeenCalledWith({ modelHash: "model", codeHash: "code", version: "chain", provider: "provider", approved: false, revoked: false, listingId: 7, chainScope: "legacy" });
    expect(mock.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({ set: { listingId: 7, chainScope: "legacy", approved: false, revoked: false } }));
  });
  it.each([
    ["Approved", { approved: true, revoked: false }],
    ["Revoked", { approved: false, revoked: true }],
  ] as const)("applies %s only to the requested listing", async (type, expected) => {
    const mock = testDb();
    await applyRegistrySync(mock.db, { type, listingId: 17 });
    expect(mock.update).toHaveBeenCalledWith(models);
    expect(mock.set).toHaveBeenCalledWith(expected);
    const query = sqlQuery(mock.writeWhere.mock.calls[0]![0]);
    expect(query.sql).toContain('"models"."listing_id" = $2');
    expect(query.params).toEqual(["legacy", 17]);
  });
  it.each([0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1, NaN])("rejects unsupported listing id %s", async (listingId) => {
    const mock = testDb();
    await expect(applyRegistrySync(mock.db, { type: "Approved", listingId })).rejects.toThrow("listing id");
    expect(mock.update).not.toHaveBeenCalled();
  });
  it("propagates persistence failures so the indexer can roll back", async () => {
    const mock = testDb();
    mock.execute.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(applyRegistrySync(mock.db, { type: "Revoked", listingId: 1 })).rejects.toThrow("database unavailable");
  });
});
