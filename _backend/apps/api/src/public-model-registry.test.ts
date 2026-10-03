import { beforeEach, describe, expect, it, vi } from "vitest";
import { indexerScope, sha256Hex, type DevCvm } from "@enclave/core";
import { models, type Database } from "@enclave/db";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createPublicClient, http } from "viem";
import { loadConfig, type Config } from "./config.js";
import { EnclaveGateway } from "./gateway.js";
import { createLogger } from "./logger.js";
import { modelRegistryScope } from "./model-registry-scope.js";

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBlock: vi.fn() }));
vi.mock("viem", async (importOriginal) => ({ ...await importOriginal<typeof import("viem")>(),
  createPublicClient: vi.fn(() => rpc), http: vi.fn(() => ({ name: "mock-registry-transport" })),
}));

const genesisHash = sha256Hex("Arc genesis");
const config = loadConfig({ DATABASE_URL: "postgres://unit.invalid/registry", NODE_ENV: "test",
  DEPLOYER_PRIVATE_KEY: `0x${"12".repeat(32)}`, // Deterministic unit fixture; no signing or network operation uses it.
  ARC_CHAIN_ID: "5042", ARC_RPC_URL: "https://rpc.unit.invalid", CHAIN_DEPLOYMENT_ID: "arc-deployment-v2",
  ATTESTATION_VERIFIER_ADDRESS: `0x${"21".repeat(20)}`, USAGE_METER_ADDRESS: `0x${"22".repeat(20)}`,
  FEE_VAULT_ADDRESS: `0x${"23".repeat(20)}`, MODEL_REGISTRY_ADDRESS: `0x${"24".repeat(20)}` });
const identity = { chainId: config.ARC_CHAIN_ID, genesisHash, deploymentId: config.CHAIN_DEPLOYMENT_ID,
  verifier: config.ATTESTATION_VERIFIER_ADDRESS, meter: config.USAGE_METER_ADDRESS,
  feeVault: config.FEE_VAULT_ADDRESS, registry: config.MODEL_REGISTRY_ADDRESS };
const currentScope = indexerScope(identity);
function row(name: string, chainScope: string | null, approved = true, revoked = false) {
  return { modelHash: sha256Hex(name), codeHash: sha256Hex("serving policy"), version: name,
    approved, revoked, listingId: 1, createdAt: new Date("2026-09-30T00:00:00Z"), chainScope };
}
const current = row("current Arc", currentScope);
const pending = row("current Arc pending", currentScope, false);
const revoked = row("current Arc revoked", currentScope, false, true);
const fixtures = [current, pending, revoked,
  row("historical Anvil", indexerScope({ ...identity, chainId: 31337 })),
  row("other Arc registry", indexerScope({ ...identity, registry: `0x${"25".repeat(20)}` })),
  row("other Arc verifier", indexerScope({ ...identity, verifier: `0x${"25".repeat(20)}` })),
  row("other Arc meter", indexerScope({ ...identity, meter: `0x${"25".repeat(20)}` })),
  row("other Arc fee vault", indexerScope({ ...identity, feeVault: `0x${"25".repeat(20)}` })),
  row("prior Arc deployment", indexerScope({ ...identity, deploymentId: "arc-deployment-v1" })),
  row("reset genesis", indexerScope({ ...identity, genesisHash: sha256Hex("reset chain") })),
  row("legacy unscoped approval", null)];

function fixtureGateway(runtimeConfig: Config = config) {
  const dialect = new PgDialect();
  const project = (rows: typeof fixtures) => rows.map(({ chainScope: _scope, ...publicRow }) => publicRow);
  const orderBy = vi.fn(async () => project(fixtures));
  const where = vi.fn((condition: SQL) => {
    const query = dialect.sqlToQuery(condition);
    expect(query.sql).toBe('"models"."chain_scope" = $1');
    const scope = query.params[0];
    return { orderBy: vi.fn(async () => project(fixtures.filter(item => item.chainScope === scope))) };
  });
  const from = vi.fn(() => ({ where, orderBy }));
  const database = { select: vi.fn((_columns: unknown) => ({ from })) };
  // REASON: this unit exercises only the public registry query; unrelated database/CVM APIs are not accessed.
  const gateway = new EnclaveGateway(database as unknown as Database, {} as DevCvm, runtimeConfig, createLogger("silent"), undefined);
  return { gateway, database, from, where, orderBy };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.getChainId.mockReset().mockResolvedValue(config.ARC_CHAIN_ID);
  rpc.getBlock.mockReset().mockResolvedValue({ number: 0n, hash: genesisHash });
});

describe("public registry deployment isolation", () => {
  it("returns only rows indexed for the configured chain, genesis, contracts and deployment", async () => {
    expect(config.CHAIN_DEPLOYMENT_ID).toBe("arc-deployment-v2");
    const { gateway, database, from, where, orderBy } = fixtureGateway();
    expect(await gateway.publicModelRegistry()).toEqual([current, pending, revoked].map(({ chainScope: _scope, ...publicRow }) => publicRow));
    expect(where).toHaveBeenCalledOnce();
    expect(orderBy).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledExactlyOnceWith(models);
    expect(Object.keys(database.select.mock.calls[0]![0] ?? {})).toEqual([
      "modelHash", "codeHash", "version", "approved", "revoked", "listingId", "createdAt"]);
    expect(rpc.getBlock).toHaveBeenCalledExactlyOnceWith({ blockNumber: 0n });
  });

  it("uses the same indexer identity when deployment id is omitted", async () => {
    const withoutDeployment = { ...config, CHAIN_DEPLOYMENT_ID: undefined };
    expect(await modelRegistryScope(withoutDeployment)).toBe(indexerScope({ ...identity, deploymentId: undefined }));
    expect(http).toHaveBeenCalledWith(config.ARC_RPC_URL, { timeout: 15_000, retryCount: 1, batch: false, fetchFn: expect.any(Function) });
    expect(createPublicClient).toHaveBeenCalledWith(expect.objectContaining({ cacheTime: 0,
      chain: expect.objectContaining({ id: config.ARC_CHAIN_ID }) }));
  });

  it("rejects an RPC for another chain before querying any registry rows", async () => {
    rpc.getChainId.mockResolvedValue(31337);
    const { gateway, database } = fixtureGateway();
    await expect(gateway.publicModelRegistry()).rejects.toThrow("Registry RPC chain mismatch");
    expect(database.select).not.toHaveBeenCalled();
    expect(rpc.getBlock).not.toHaveBeenCalled();
  });

  it.each([{ number: 0n, hash: null }, { number: 1n, hash: genesisHash }, { number: 0n, hash: "0x00" }])(
    "rejects a missing or noncanonical genesis before reading rows %#", async (genesis) => {
      rpc.getBlock.mockResolvedValue(genesis);
      const { gateway, database } = fixtureGateway();
      await expect(gateway.publicModelRegistry()).rejects.toThrow("Registry canonical genesis is unavailable");
      expect(database.select).not.toHaveBeenCalled();
    });

  it("does not fall back to historical approvals while RPC identity is unavailable", async () => {
    rpc.getBlock.mockRejectedValue(new Error("RPC unavailable"));
    const { gateway, database } = fixtureGateway();
    await expect(gateway.publicModelRegistry()).rejects.toThrow("RPC unavailable");
    expect(database.select).not.toHaveBeenCalled();
  });
});
