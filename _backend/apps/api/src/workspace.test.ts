import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { agents, apiKeys, payments, receipts, usage, type Database } from "@enclave/db";
import { sha256Hex, type DevCvm } from "@enclave/core";
import { EnclaveGateway } from "./gateway.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createApp } from "./app.js";

const secret = "workspace-secret-canary", keyHash = sha256Hex(secret), hash = sha256Hex("model:echo");
const address = `0x${"12".repeat(20)}`;
const config = loadConfig({ DATABASE_URL: "postgres://unused", INFERENCE_API_KEY: "provider-secret-canary" });
const cvm = { config: { modelId: "echo" }, modelHash: hash, codeHash: sha256Hex("code"), enclaveAddress: address } as unknown as DevCvm;
const date = new Date("2026-09-21T00:00:00.000Z");
type Row = Record<string, unknown>;

function fixture(empty = false) {
  const rows = new Map<unknown, Row[]>([
    [usage, empty ? [] : [{ calls: 5, usdcUnits: 9007199254740993n }]],
    [receipts, empty ? [] : [1, 2, 3].map((i) => ({ id: randomUUID(), receiptVersion: 2, nonce: hash, chainId: 31337, verifierAddress: address,
      modelHash: hash, codeHash: hash, inHash: hash, outHash: hash, attRef: hash, ts: 99n, sig: "0xab", typedHash: sha256Hex(String(i)),
      status: "anchored", anchoredTx: hash, agentId: null, createdAt: date, outputJson: "PRIVATE OUTPUT", providerProofJson: "PRIVATE PROOF", keyHash }))],
    [payments, empty ? [] : [{ id: randomUUID(), amountUnits: 100000n, status: "consumed", settleTx: hash, receiptHash: hash,
      agentId: null, listingId: 1, confidential: false, createdAt: date, authorizationJson: "PRIVATE AUTH", requestHash: "PRIVATE REQUEST", keyHash }]],
    [agents, empty ? [] : [{ id: randomUUID(), name: "Planner", policyHash: hash, memoryHash: hash, createdAt: date,
      sealedMemory: "PRIVATE MEMORY", policyJson: JSON.stringify({ dailyLimitUnits: "1000000", allowedModels: [hash] }), ownerKeyHash: keyHash,
      dailyLimitUnits: 1000000n, spentTodayUnits: 123456n, dayKey: new Date().toISOString().slice(0, 10), lane: "agent" }]],
  ]);
  const queries: Array<{ table: unknown; fields: string[]; condition: SQL; limit: number }> = [];
  const select = vi.fn((fields?: Row) => {
    let table: unknown, condition: SQL;
    const query = {
      from: (value: unknown) => { table = value; return query; },
      leftJoin: (..._values: unknown[]) => query,
      where: (value: SQL) => { condition = value; return query; },
      orderBy: (..._values: unknown[]) => query,
      limit: async (limit: number) => {
        const compiled = new PgDialect().sqlToQuery(condition);
        if (table === apiKeys) return compiled.params.includes(keyHash) ? [{ keyHash }] : [];
        queries.push({ table, fields: Object.keys(fields!), condition, limit });
        return (rows.get(table) ?? []).slice(0, limit).map((row) => Object.fromEntries(Object.keys(fields!).map((field) => [field, row[field]])));
      },
    };
    return query;
  });
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ select }));
  const gateway = new EnclaveGateway({ select, transaction } as unknown as Database, cvm, config, createLogger("silent"), undefined);
  return { gateway, app: createApp(gateway, createLogger("silent")), queries, transaction, rows };
}

describe("private browser workspace", () => {
  it("returns only explicit owner projections with lossless units and receipt verification fields", async () => {
    const f = fixture(), result = await f.gateway.workspace(secret, { limit: 2 });
    expect(result.usage).toEqual({ calls: 5, usdcUnits: "9007199254740993" });
    expect(result.receipts).toHaveLength(2);
    expect(result.receipts[0]).toMatchObject({ receiptVersion: 2, nonce: hash, chainId: 31337, verifierAddress: address, sig: "0xab", ts: "99", anchoredTx: hash });
    expect(result.page).toEqual({ limit: 2, receiptsNext: result.receipts[1]!.id, paymentsNext: null, agentsNext: null });
    expect(result.payments[0]?.amountUnits).toBe("100000");
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|keyHash|ownerKeyHash|sealedMemory|outputJson|providerProofJson|authorizationJson|requestHash|policyJson|secret-canary/);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "repeatable read", accessMode: "read only" });
    for (const query of f.queries) expect(new PgDialect().sqlToQuery(query.condition).params).toContain(keyHash);
    expect(f.queries.filter((q) => q.table !== usage).every((q) => q.limit === 3)).toBe(true);
  });
  it("returns zero aggregate and empty pages without synthetic demo records", async () => {
    const result = await fixture(true).gateway.workspace(secret);
    expect(result).toEqual({ usage: { calls: 0, usdcUnits: "0" }, receipts: [], payments: [], agents: [],
      page: { limit: 50, receiptsNext: null, paymentsNext: null, agentsNext: null } });
  });
  it("reports only persisted mandate limits and current UTC day's reserved spending", async () => {
    const f = fixture();
    expect((await f.gateway.workspace(secret)).agents[0]).toMatchObject({ dailyLimitUnits: "1000000", spentTodayUnits: "123456", lane: "agent", allowedModels: [hash] });
    f.rows.get(agents)![0]!.dayKey = "2000-01-01";
    expect((await f.gateway.workspace(secret)).agents[0]?.spentTodayUnits).toBe("0");
    expect(f.rows.get(agents)![0]!.spentTodayUnits).toBe(123456n);
  });
  it("represents absent mandates and invalid policy as unknown without inventing unlimited values", async () => {
    const f = fixture(); Object.assign(f.rows.get(agents)![0]!, { dailyLimitUnits: null, spentTodayUnits: null, dayKey: null, lane: null, policyJson: "PRIVATE invalid JSON" });
    expect((await f.gateway.workspace(secret)).agents[0]).toMatchObject({ dailyLimitUnits: null, spentTodayUnits: null, lane: null, allowedModels: null });
    f.rows.get(agents)![0]!.policyJson = JSON.stringify({ allowedModels: [] });
    expect((await f.gateway.workspace(secret)).agents[0]?.allowedModels).toEqual([]);
  });
  it("uses owner-bound UUID pivots for every independent cursor", async () => {
    const f = fixture(), cursor = randomUUID();
    await f.gateway.workspace(secret, { receiptsBefore: cursor, paymentsBefore: cursor, agentsBefore: cursor });
    for (const query of f.queries.filter((q) => q.table !== usage)) {
      const compiled = new PgDialect().sqlToQuery(query.condition);
      expect(compiled.params).toEqual([keyHash, cursor, keyHash]);
      expect(compiled.sql).toContain("::uuid");
    }
  });
  it.each(["", "wrong-owner"])("rejects unrecognized credentials before reading workspace data %#", async (key) => {
    const f = fixture(); const response = await f.app.request("/v1/workspace", { headers: { "x-api-key": key } });
    expect(response.status).toBe(401); expect(f.transaction).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(secret);
  });
  it.each(["limit=0", "limit=101", "limit=1.5", "limit=abc", "receiptsBefore=bad", "paymentsBefore=bad", "agentsBefore=bad", "extra=bad"])("rejects invalid pagination %s", async (query) => {
    const f = fixture(); const result = await f.app.request(`/v1/workspace?${query}`, { headers: { "x-api-key": secret } });
    expect(result.status).toBe(400); expect(f.transaction).not.toHaveBeenCalled();
  });
  it("routes owner access without cache and accepts the exact 100 row cap", async () => {
    const f = fixture(); const result = await f.app.request("/v1/workspace?limit=100", { headers: { "x-api-key": secret } });
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store");
    expect((await result.json() as { page: { limit: number } }).page.limit).toBe(100);
    await expect(f.gateway.workspace(secret, { limit: 101 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("reports real serving identity and software/payment mode without credentials", async () => {
    const f = fixture(), result = await f.app.request("/health");
    expect(await result.json()).toMatchObject({ ok: true, chainId: 31337, teeMode: "dev", paymentMode: "mock", inferenceBackend: "echo",
      servingModel: { id: "echo", name: "echo", modelHash: hash, codeHash: cvm.codeHash }, receiptSigner: address,
      verifierAddress: config.ATTESTATION_VERIFIER_ADDRESS, agentRuntimeEnabled: false, inferencePriceUsdc: 0.1,
      deployment: { stage: "development", productionReady: false, gatewayKeyCustody: "software" },
      limits: { inferenceTimeoutMs: config.INFERENCE_TIMEOUT_MS, maxOutputTokens: null }, settlementToken: config.USDC_ADDRESS });
    expect(JSON.stringify(f.gateway.health())).not.toMatch(/secret-canary|PRIVATE|DATABASE|postgres/);
  });
  it("reports the configured NEAR identity without making a provider request or implying gateway hardware", () => {
    const nearCvm = { ...cvm, config: { modelId: "zai-org/GLM-5.3-Flash" }, modelHash: sha256Hex("model:zai-org/GLM-5.3-Flash") } as DevCvm;
    const nearConfig = { ...config, INFERENCE_BACKEND: "near-verified" as const, INFERENCE_MODEL: nearCvm.config.modelId };
    const gateway = new EnclaveGateway({} as Database, nearCvm, nearConfig, createLogger("silent"), undefined);
    expect(gateway.health()).toMatchObject({ inferenceBackend: "near-verified", teeMode: "dev", servingModel: { id: nearConfig.INFERENCE_MODEL,
      name: nearConfig.INFERENCE_MODEL, modelHash: nearCvm.modelHash, codeHash: cvm.codeHash }, receiptSigner: cvm.enclaveAddress,
      deployment: { productionReady: false, gatewayKeyCustody: "software" },
      limits: { maxOutputTokens: config.NEAR_MAX_TOKENS, inferenceTimeoutMs: config.INFERENCE_TIMEOUT_MS } });
  });
});
