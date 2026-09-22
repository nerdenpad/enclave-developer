import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, apiKeys, mandates, payments, receipts, schema, usage, type Database } from "@enclave/db";
import { sha256Hex, type DevCvm } from "@enclave/core";
import { EnclaveGateway } from "./gateway.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createApp } from "./app.js";

describe.skipIf(process.env.ENCLAVE_INTEGRATION !== "1")("workspace isolation on real PostgreSQL", () => {
  let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof postgres>, gateway: EnclaveGateway;
  let namespace: string, db: Database;
  const key = randomUUID(), foreignKey = randomUUID(), owner = sha256Hex(key), foreignOwner = sha256Hex(foreignKey);
  const hashes = [sha256Hex("first"), sha256Hex("second"), sha256Hex("third")];
  const ours: string[] = [], foreign = randomUUID();
  beforeAll(async () => {
    const cfg = loadConfig(); admin = postgres(cfg.DATABASE_URL, { max: 1 });
    namespace = `enclave_workspace_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA "${namespace}"`);
    for (const table of ["api_keys", "receipts", "payments", "agents", "usage", "mandates"]) await admin.unsafe(`CREATE TABLE "${namespace}".${table} (LIKE public.${table} INCLUDING ALL)`);
    connection = postgres(cfg.DATABASE_URL, { max: 3, connection: { search_path: namespace } });
    db = drizzle(connection, { schema });
    gateway = new EnclaveGateway(db, {} as DevCvm, cfg, createLogger("silent"), undefined);
    await db.insert(apiKeys).values([{ keyHash: owner, label: "ours" }, { keyHash: foreignOwner, label: "foreign" }]);
    await db.insert(usage).values([{ keyHash: owner, calls: 3, usdcUnits: 300000n }, { keyHash: foreignOwner, calls: 999, usdcUnits: 999n }]);
    for (let index = 0; index < 4; index++) {
      const id = index === 3 ? foreign : randomUUID(), keyHash = index === 3 ? foreignOwner : owner;
      if (index < 3) ours.push(id);
      await db.insert(receipts).values({ id, keyHash, modelHash: hashes[0]!, codeHash: hashes[0]!, inHash: hashes[0]!, outHash: hashes[0]!, attRef: hashes[0]!, ts: 1n,
        sig: "0xab", typedHash: sha256Hex(id), receiptVersion: 2, nonce: hashes[0]!, chainId: 31337,
        verifierAddress: `0x${"12".repeat(20)}`, outputJson: "SECRET OUTPUT", providerProofJson: "SECRET PROOF" });
      await db.insert(payments).values({ id, keyHash, amountUnits: 100000n, status: "consumed", receiptHash: sha256Hex(id), authorizationJson: "SECRET AUTH" });
      await db.insert(agents).values({ id, ownerKeyHash: keyHash, name: index === 3 ? "FOREIGN" : `Agent ${index}`,
        policyJson: JSON.stringify({ dailyLimitUnits: "900000", allowedModels: [hashes[0]] }), policyHash: hashes[0]!, memoryHash: hashes[0]!, sealedMemory: "SECRET MEMORY" });
      if (index !== 2) await db.insert(mandates).values({ agent: id, dailyLimitUnits: 900000n, spentTodayUnits: 100000n,
        dayKey: index === 1 ? "2000-01-01" : new Date().toISOString().slice(0, 10), lane: "agent" });
      // Cursor fidelity must not round PostgreSQL timestamps through a JavaScript Date.
      const timestamp = `2030-01-01 00:00:00.00000${index + 1}+00`;
      for (const table of ["receipts", "payments", "agents"]) await connection.unsafe(`UPDATE ${table} SET created_at = $1::timestamptz WHERE id = $2::uuid`, [timestamp, id]);
    }
  });
  afterAll(async () => {
    await connection?.end({ timeout: 5 });
    if (namespace && /^enclave_workspace_[0-9a-f]{32}$/.test(namespace)) await admin.unsafe(`DROP SCHEMA "${namespace}" CASCADE`);
    await admin?.end({ timeout: 5 });
  });
  it("isolates owner aggregates and explicit receipt/payment/agent projections", async () => {
    const result = await gateway.workspace(key);
    expect(result.usage).toEqual({ calls: 3, usdcUnits: "300000" });
    expect(result.receipts).toHaveLength(3); expect(result.payments).toHaveLength(3); expect(result.agents).toHaveLength(3);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|FOREIGN|keyHash|ownerKeyHash|outputJson|providerProofJson|authorizationJson|sealedMemory/);
    expect(result.receipts[0]).toMatchObject({ receiptVersion: 2, nonce: hashes[0], chainId: 31337, sig: "0xab" });
    const other = await gateway.workspace(foreignKey);
    expect(other.usage.calls).toBe(999); expect(other.receipts.map((r) => r.id)).toEqual([foreign]);
  });
  it("paginates all collections without duplicates or loss at sub-millisecond timestamps", async () => {
    const first = await gateway.workspace(key, { limit: 1 });
    const second = await gateway.workspace(key, { limit: 1, receiptsBefore: first.page.receiptsNext!, paymentsBefore: first.page.paymentsNext!, agentsBefore: first.page.agentsNext! });
    const third = await gateway.workspace(key, { limit: 1, receiptsBefore: second.page.receiptsNext!, paymentsBefore: second.page.paymentsNext!, agentsBefore: second.page.agentsNext! });
    for (const field of ["receipts", "payments", "agents"] as const) expect([first[field][0]!.id, second[field][0]!.id, third[field][0]!.id]).toEqual([...ours].reverse());
    expect(third.page).toEqual({ limit: 1, receiptsNext: null, paymentsNext: null, agentsNext: null });
  });
  it("preserves missing mandates and rolls old day spending into the effective daily view", async () => {
    const result = await gateway.workspace(key), byId = new Map(result.agents.map((agent) => [agent.id, agent]));
    expect(byId.get(ours[0]!)).toMatchObject({ dailyLimitUnits: "900000", spentTodayUnits: "100000", lane: "agent", allowedModels: [hashes[0]] });
    expect(byId.get(ours[1]!)).toMatchObject({ dailyLimitUnits: "900000", spentTodayUnits: "0", lane: "agent" });
    expect(byId.get(ours[2]!)).toMatchObject({ dailyLimitUnits: null, spentTodayUnits: null, lane: null });
  });
  it("foreign or unknown cursor cannot pivot into another owner's records", async () => {
    for (const cursor of [foreign, randomUUID()]) {
      const result = await gateway.workspace(key, { receiptsBefore: cursor, paymentsBefore: cursor, agentsBefore: cursor });
      expect(result.receipts).toEqual([]); expect(result.payments).toEqual([]); expect(result.agents).toEqual([]); expect(result.usage.calls).toBe(3);
    }
  });
  it("returns HTTP 401 without authentication and rejects excessive page sizes", async () => {
    const app = createApp(gateway, createLogger("silent"));
    expect((await app.request("/v1/workspace")).status).toBe(401);
    expect((await app.request("/v1/workspace?limit=101", { headers: { "x-api-key": key } })).status).toBe(400);
  });
});
