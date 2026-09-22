import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, getTableName } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { agents, apiKeys, buybacks, idempotencyKeys, mandates, models, payments, receipts, sessions, usage, viewKeys, TransactionRevertedError, schema, tcbPolicy } from "@enclave/db";
import { ConflictError, decryptAesGcm, encryptAesGcm, sha256Hex } from "@enclave/core";
import { keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EnclaveGateway } from "./gateway.js";
import { loadConfig, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { authorizationData } from "./authorization.js";
import * as chain from "./chain.js";
import * as proof from "./settlement-proof.js";

describe("Postgres gateway payment and trust boundaries", () => {
  const base = loadConfig();
  const isolatedSchema = `gateway_boundaries_${randomUUID().replaceAll("-", "")}`;
  const adminSql = postgres(base.DATABASE_URL, { max: 1 });
  const sql = postgres(base.DATABASE_URL, { max: 5, connection: { search_path: isolatedSchema } });
  const db = drizzle(sql, { schema });
  const log = createLogger("silent");
  const txHash = `0x${"ab".repeat(32)}` as Hex;
  const payer = privateKeyToAccount(`0x${"11".repeat(32)}`);
  let config: Config;
  let gateway: EnclaveGateway;
  let owner: string;
  let other: string;
  let keyHash: Hex;
  let otherHash: Hex;
  let sessionId: string;
  let wrapKey: Buffer;
  let modelId: string;
  const settle = vi.fn<ReturnType<typeof chain.createFacilitator>["settle"]>();

  async function boot(overrides: Partial<Config> = {}) { return EnclaveGateway.boot(db, { ...config, ...overrides }, log, undefined); }
  async function payment(overrides: Partial<typeof payments.$inferInsert> = {}) {
    const [row] = await db.insert(payments).values({ keyHash, amountUnits: 100_000n, ...overrides }).returning();
    return row!;
  }
  const inference = (paymentId?: string) => ({ apiKey: owner, sessionId, blob: encryptAesGcm(wrapKey, Buffer.from("boundary request")), ...(paymentId ? { paymentId } : {}) });
  const rowOf = async (id: string) => (await db.select().from(payments).where(eq(payments.id, id)))[0]!;
  const reserved = async () => (await db.select().from(mandates).where(eq(mandates.agent, keyHash)))[0]!.spentTodayUnits;

  beforeAll(async () => {
    expect(process.env.ENCLAVE_INTEGRATION).toBe("1");
    await adminSql`create schema ${adminSql(isolatedSchema)}`;
    for (const table of Object.values(schema)) {
      const name = getTableName(table);
      await adminSql`create table ${adminSql(isolatedSchema)}.${adminSql(name)} (like public.${adminSql(name)} including all)`;
    }
  });
  beforeEach(async () => {
    await db.delete(tcbPolicy);
    owner = `boundary-owner-${randomUUID()}`; other = `boundary-other-${randomUUID()}`;
    keyHash = sha256Hex(owner); otherHash = sha256Hex(other);
    config = { ...base, SERVING_IMAGE_ID: `boundary-${randomUUID()}`, PAYMENT_MODE: "mock", INFERENCE_BACKEND: "echo",
      USDC_ADDRESS: "0x0000000000000000000000000000000000000200", USAGE_METER_ADDRESS: "0x0000000000000000000000000000000000000100",
      MODEL_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000007", AGENT_MANDATE_ADDRESS: "0x0000000000000000000000000000000000000008",
      ENCL_TOKEN_ADDRESS: "0x0000000000000000000000000000000000000005", INSURANCE_STAKING_ADDRESS: "0x0000000000000000000000000000000000000006", ALLOW_LOCAL_BOOTSTRAP: false };
    await db.insert(apiKeys).values([{ keyHash, label: "boundary-owner", role: "admin" }, { keyHash: otherHash, label: "boundary-other" }]);
    await db.insert(mandates).values({ agent: keyHash, dailyLimitUnits: 10_000_000n, dayKey: new Date().toISOString().slice(0, 10) });
    gateway = await boot();
    const quote = await gateway.quote();
    const [model] = await db.insert(models).values({ modelHash: sha256Hex("model:echo"), codeHash: quote.measurement, version: "boundary", provider: keyHash, approved: true }).returning();
    modelId = model!.id;
    sessionId = (await gateway.openSession(owner, quote)).sessionId;
    wrapKey = gateway.sessionWrapKey(sessionId);
    settle.mockReset().mockResolvedValue(txHash);
    vi.spyOn(chain, "createFacilitator").mockReturnValue({ payer: payer.address, settle });
    vi.spyOn(proof, "settlementScope").mockResolvedValue("boundary-scope");
    vi.spyOn(proof, "verifySettlementProof").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const ownedAgents = await db.select().from(agents).where(inArray(agents.ownerKeyHash, [keyHash, otherHash]));
    await db.delete(mandates).where(inArray(mandates.agent, [keyHash, otherHash, ...ownedAgents.map((agent) => agent.id)]));
    await db.delete(agents).where(inArray(agents.ownerKeyHash, [keyHash, otherHash]));
    await db.delete(payments).where(inArray(payments.keyHash, [keyHash, otherHash]));
    await db.delete(receipts).where(inArray(receipts.keyHash, [keyHash, otherHash]));
    await db.delete(usage).where(inArray(usage.keyHash, [keyHash, otherHash]));
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.keyHash, [keyHash, otherHash]));
    await db.delete(viewKeys).where(inArray(viewKeys.ownerKeyHash, [keyHash, otherHash]));
    await db.delete(sessions).where(inArray(sessions.apiKeyHash, [keyHash, otherHash]));
    await db.delete(models).where(inArray(models.provider, [keyHash, otherHash]));
    await db.delete(apiKeys).where(inArray(apiKeys.keyHash, [keyHash, otherHash]));
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (!/^gateway_boundaries_[a-f0-9]{32}$/.test(isolatedSchema)) throw new Error("Unexpected fixture schema");
    await adminSql`drop schema if exists ${adminSql(isolatedSchema)} cascade`;
    await adminSql.end({ timeout: 5 });
  });

  it("requires payer authorization before reserving a mandate or submitting a transaction", async () => {
    const authorized = await boot({ PAYMENT_MODE: "authorized" });
    const row = await payment();
    await expect(authorized.settlePayment(owner, row.id)).rejects.toMatchObject({ statusCode: 400 });
    expect((await rowOf(row.id)).status).toBe("open");
    expect(await reserved()).toBe(0n);
    expect(settle).not.toHaveBeenCalled();
  });

  it("rejects expired signed authorization without charging or quarantining the payment", async () => {
    const authorized = await boot({ PAYMENT_MODE: "authorized" });
    const row = await payment();
    const now = Math.floor(Date.now() / 1000);
    const data = authorizationData(config, row.id, row.amountUnits, payer.address, String(now - 100), String(now - 1));
    const auth = { from: payer.address, validAfter: String(now - 100), validBefore: String(now - 1), signature: await payer.signTypedData(data) };
    await expect(authorized.settlePayment(owner, row.id, false, auth)).rejects.toMatchObject({ statusCode: 400 });
    expect((await rowOf(row.id)).status).toBe("open");
    expect(await reserved()).toBe(0n);
    expect(settle).not.toHaveBeenCalled();
  });

  it.each([{ PAYMENT_MODE: "authorized" as const }, { ARC_CHAIN_ID: 5042002 }])("fails closed for unsupported confidential settlement %#", async (overrides) => {
    const restricted = await boot(overrides);
    const row = await payment();
    await expect(restricted.settlePayment(owner, row.id, true)).rejects.toMatchObject({ statusCode: 503, code: "CONFIDENTIAL_UNAVAILABLE" });
    expect((await rowOf(row.id)).status).toBe("open");
    expect(settle).not.toHaveBeenCalled();
  });

  it("does not bypass an agent mandate through a mock confidential payment", async () => {
    const row = await payment({ agentId: randomUUID() });
    await expect(gateway.settlePayment(owner, row.id, true)).rejects.toMatchObject({ statusCode: 400 });
    expect((await rowOf(row.id)).status).toBe("open");
    expect(settle).not.toHaveBeenCalled();
  });

  it.each(["deployment", "confidential", "authorization"] as const)("rejects a recovery attempt that changes its %s", async (field) => {
    const auth = { from: payer.address, validAfter: "0", validBefore: "9999999999", signature: `0x${"11".repeat(65)}` as Hex };
    const row = await payment({ status: "settlement_unknown", settlementMode: "mock", chainScope: field === "deployment" ? "old-scope" : "boundary-scope", authorizationJson: JSON.stringify(auth) });
    await expect(gateway.settlePayment(owner, row.id, field === "confidential", field === "authorization" ? { ...auth, validBefore: "9999999998" } : undefined)).rejects.toMatchObject({ statusCode: 409 });
    expect(await rowOf(row.id)).toEqual(row);
    expect(settle).not.toHaveBeenCalled();
  });

  it("resumes the identical durable authorization without changing its economic context", async () => {
    const auth = { from: payer.address, validAfter: "0", validBefore: "9999999999", signature: `0x${"11".repeat(65)}` as Hex };
    const row = await payment({ status: "settlement_unknown", settlementMode: "authorized", chainScope: "boundary-scope", authorizationJson: JSON.stringify(auth) });
    await expect(gateway.settlePayment(owner, row.id, false, auth)).resolves.toMatchObject({ paymentId: row.id, tx: txHash });
    expect(settle).toHaveBeenCalledExactlyOnceWith(row.id, row.amountUnits, false, { listingId: null, agentId: null, mode: "authorized", authorization: auth });
    expect(proof.verifySettlementProof).toHaveBeenCalledWith(config, expect.objectContaining({ payer: payer.address, paymentId: row.id }));
  });

  it("quarantines historical uncertain payments without durable settlement metadata", async () => {
    const row = await payment({ status: "settlement_unknown" });
    const internal = gateway as unknown as { performSettlement(owner: string, id: string): Promise<unknown> };
    const recover = vi.spyOn(internal, "performSettlement").mockRejectedValue(new Error("Other fixture remains pending"));
    await gateway.reconcilePayments();
    expect(recover.mock.calls.some(([, id]) => id === row.id)).toBe(false);
    expect(await rowOf(row.id)).toEqual(row);
  });

  it("releases an active reservation exactly once after a proved mined revert", async () => {
    const row = await payment();
    settle.mockRejectedValueOnce(new TransactionRevertedError(txHash));
    await expect(gateway.settlePayment(owner, row.id)).rejects.toBeInstanceOf(TransactionRevertedError);
    expect((await rowOf(row.id)).status).toBe("failed");
    expect(await reserved()).toBe(0n);
    await expect(gateway.settlePayment(owner, row.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await reserved()).toBe(0n);
    expect(settle).toHaveBeenCalledOnce();
  });

  it("presents exact JSON-serializable typed authorization only to the payment owner", async () => {
    const authorized = await boot({ PAYMENT_MODE: "authorized" });
    const row = await payment({ agentId: randomUUID(), listingId: 77 });
    const result = await authorized.paymentAuthorization(owner, row.id, payer.address);
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({ paymentId: row.id, mode: "authorized", listingId: 77, agentId: row.agentId, mandateAddress: config.AGENT_MANDATE_ADDRESS,
      typedData: { domain: { chainId: config.ARC_CHAIN_ID, verifyingContract: config.USDC_ADDRESS }, primaryType: "ReceiveWithAuthorization",
        message: { from: payer.address, to: config.USAGE_METER_ADDRESS, value: "100000", validAfter: "0", nonce: keccak256(stringToHex(row.id)) } } });
    expect(BigInt(result.typedData.message.validBefore)).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
    await expect(authorized.paymentAuthorization(other, row.id, payer.address)).rejects.toMatchObject({ statusCode: 404 });
    await expect(authorized.paymentAuthorization(owner, randomUUID(), payer.address)).rejects.toMatchObject({ statusCode: 404 });
    await expect(authorized.paymentAuthorization("unknown", row.id, payer.address)).rejects.toMatchObject({ statusCode: 401 });
    await db.update(payments).set({ status: "settled" }).where(eq(payments.id, row.id));
    await expect(authorized.paymentAuthorization(owner, row.id, payer.address)).rejects.toMatchObject({ statusCode: 409 });
    const ordinary = await payment();
    expect((await authorized.paymentAuthorization(owner, ordinary.id, payer.address)).mandateAddress).toBeNull();
  });

  it("redacts payment economics and authorization from the public response", async () => {
    const row = await payment({ status: "settled", confidential: true, authorizationJson: "private signature", settleTx: txHash });
    expect(await gateway.getPublicPayment(row.id)).toEqual({ id: row.id, status: "settled", confidential: true });
    await expect(gateway.getPublicPayment(randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    await expect(gateway.getPublicReceipt(sha256Hex("missing receipt"))).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not consume a settled payment below the current inference price", async () => {
    const row = await payment({ status: "settled", amountUnits: 99_999n });
    await expect(gateway.infer(inference(row.id))).rejects.toMatchObject({ statusCode: 402 });
    expect((await rowOf(row.id)).status).toBe("settled");
  });

  it("checks the original deployment again before consuming a settled payment", async () => {
    const row = await payment({ status: "settled", settlementMode: "mock", chainScope: "replaced-chain", settleTx: txHash });
    await expect(gateway.infer(inference(row.id))).rejects.toMatchObject({ statusCode: 409 });
    expect((await rowOf(row.id)).status).toBe("settled");
    expect(proof.verifySettlementProof).not.toHaveBeenCalled();
  });

  it("rolls back consumption if a stored settled payment has no verifiable transaction", async () => {
    const row = await payment({ status: "settled", settlementMode: "mock", chainScope: "boundary-scope" });
    vi.mocked(proof.verifySettlementProof).mockRejectedValueOnce(new ConflictError("Payment transaction hash missing"));
    await expect(gateway.infer(inference(row.id))).rejects.toMatchObject({ statusCode: 409 });
    expect(proof.verifySettlementProof).toHaveBeenCalledWith(config, expect.objectContaining({ paymentId: row.id, txHash: "" }));
    expect((await rowOf(row.id)).status).toBe("settled");
  });

  it("requires stored session provenance to agree with its signed attestation", async () => {
    await db.update(sessions).set({ attRef: sha256Hex("substituted quote") }).where(eq(sessions.id, sessionId));
    await expect(gateway.infer(inference())).rejects.toMatchObject({ statusCode: 401 });
    expect(await db.select().from(payments).where(eq(payments.keyHash, keyHash))).toHaveLength(0);
  });

  it("requires fresh attestation for a legacy session without durable quote provenance", async () => {
    await db.update(sessions).set({ quoteJson: null }).where(eq(sessions.id, sessionId));
    await expect(gateway.infer(inference())).rejects.toMatchObject({
      statusCode: 401,
      message: "Session has no durable attestation; open a new session"
    });
    expect(await db.select().from(payments).where(eq(payments.keyHash, keyHash))).toHaveLength(0);
  });

  it.each(["missing", "revoked"])("rejects serving a %s local model before opening a payment", async (state) => {
    if (state === "missing") await db.delete(models).where(eq(models.id, modelId));
    else await db.update(models).set({ revoked: true }).where(eq(models.id, modelId));
    await expect(gateway.infer(inference())).rejects.toMatchObject({ statusCode: 403 });
    expect(await db.select().from(payments).where(eq(payments.keyHash, keyHash))).toHaveLength(0);
  });

  it("requires a session before accepting encrypted agent memory", async () => {
    await expect(gateway.createAgent({ apiKey: owner, name: "memory", dailyLimitUsdc: 1, memory: encryptAesGcm(wrapKey, Buffer.from("secret")) })).rejects.toMatchObject({ statusCode: 403 });
    expect(await gateway.listAgents(owner)).toHaveLength(0);
    await expect(gateway.getAgent(owner, randomUUID())).rejects.toMatchObject({ statusCode: 404 });
  });

  it("preserves legacy unrestricted agent policy and encrypts its SDK inference result", async () => {
    const agent = await gateway.createAgent({ apiKey: owner, name: "legacy", dailyLimitUsdc: 1 });
    await db.update(agents).set({ policyJson: JSON.stringify({ dailyLimitUnits: "1000000" }) }).where(eq(agents.id, agent.id));
    const blob = encryptAesGcm(wrapKey, Buffer.from("sdk request"));
    const input = { sessionId, agentId: agent.id, ...blob };
    await expect(gateway.invokeAgentTool(owner, "enclave_infer", input)).rejects.toMatchObject({ statusCode: 402 });
    const [row] = await db.select().from(payments).where(eq(payments.keyHash, keyHash));
    await gateway.invokeAgentTool(owner, "enclave_settle", { paymentId: row!.id });
    const result = await gateway.invokeAgentTool(owner, "enclave_infer", { ...input, paymentId: row!.id }) as { receipt: { inHash: Hex; outHash: Hex; ts: string }; output: Parameters<typeof decryptAesGcm>[1] };
    expect(result.receipt.inHash).toBe(sha256Hex("\nsdk request"));
    expect(typeof result.receipt.ts).toBe("string");
    expect(sha256Hex(decryptAesGcm(wrapKey, result.output))).toBe(result.receipt.outHash);
  });

  it("fails closed for unconfigured staking while reporting read-only status accurately", async () => {
    expect(await gateway.stakeStatus(owner)).toEqual({ configured: false, staked: "0" });
    for (const action of [() => gateway.stakeEncl(owner, 1n), () => gateway.unstakeEncl(owner, 1n), () => gateway.stakingRewards(owner), () => gateway.claimStakingRewards(owner)]) {
      await expect(action()).rejects.toMatchObject({ statusCode: 503, code: "CHAIN_NOT_CONFIGURED" });
    }
  });

  it("enforces registry configuration and explicit local bootstrap permission", async () => {
    await expect(gateway.listingApprovalStatus(1)).rejects.toMatchObject({ statusCode: 503 });
    await expect(gateway.bootstrapApproveListing(owner, 1)).rejects.toMatchObject({ statusCode: 403 });
    await expect(gateway.restoreServingModel(owner)).rejects.toMatchObject({ statusCode: 403 });
    const local = await boot({ ALLOW_LOCAL_BOOTSTRAP: true });
    await expect(local.bootstrapApproveListing(owner, 1)).rejects.toMatchObject({ statusCode: 503 });
  });

  it("allows local registry administration without inventing a chain listing", async () => {
    const modelHash = sha256Hex(randomUUID()); const codeHash = sha256Hex(randomUUID());
    await expect(gateway.listModel({ apiKey: owner, modelHash, codeHash, version: "v1", bps: 10001 })).rejects.toMatchObject({ statusCode: 400 });
    const listed = await gateway.listModel({ apiKey: owner, modelHash, codeHash, version: "v1", bps: 1000 });
    expect(listed).toMatchObject({ listingId: null, tx: "", approved: false });
    await gateway.revokeServingModel(owner);
    expect((await db.select().from(models).where(eq(models.id, modelId)))[0]?.revoked).toBe(true);
    await (await boot({ ALLOW_LOCAL_BOOTSTRAP: true })).restoreServingModel(owner);
    expect((await db.select().from(models).where(eq(models.id, modelId)))[0]).toMatchObject({ approved: true, revoked: false });
    await expect(gateway.revokeListing(owner, 987654)).resolves.toEqual({ listingId: 987654, revoked: true });
  });

  it("does not create a buyback reservation when distribution reserves zero", async () => {
    const economic = { distributeWithAccounting: vi.fn().mockResolvedValue({ tx: txHash, reserved: 0n, treasury: 4n, stakers: 3n, providers: 2n, ecosystem: 1n }) };
    vi.spyOn(chain, "createEconomicOps").mockReturnValue(economic as unknown as ReturnType<typeof chain.createEconomicOps>);
    const before = await db.select().from(buybacks).where(eq(buybacks.distributeTx, txHash));
    expect(await gateway.distributeFees(owner)).toEqual({ tx: txHash, split: { treasury: "4", stakers: "3", providers: "2", ecosystem: "1" }, buyback: null });
    expect(await db.select().from(buybacks).where(eq(buybacks.distributeTx, txHash))).toEqual(before);
  });
});
