import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, getTableName } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { privateKeyToAccount } from "viem/accounts";
import { apiKeys, idempotencyKeys, models, payments, receipts, sessions, usage, schema, tcbPolicy } from "@enclave/db";
import * as core from "@enclave/core";
import { EnclaveGateway } from "./gateway.js";
import { loadConfig, type Config } from "./config.js";
import { createLogger } from "./logger.js";

// Hardware/network verification has its own negative and live tests. This suite uses
// signed provider fixtures to test the actual Postgres transaction and privacy boundary.
describe("private provider evidence through Postgres gateway", () => {
  const base = loadConfig();
  const isolatedSchema = `provider_evidence_${randomUUID().replaceAll("-", "")}`;
  const adminSql = postgres(base.DATABASE_URL, { max: 1 });
  const sql = postgres(base.DATABASE_URL, { max: 5, connection: { search_path: isolatedSchema } });
  const db = drizzle(sql, { schema });
  const log = createLogger("silent");
  const signer = privateKeyToAccount(`0x${"55".repeat(32)}`);
  const model = "test/Verified";
  const prompt = "Private inference prompt 🔐";
  const answer = "Private provider answer";
  let owner: string;
  let keyHash: `0x${string}`;
  let config: Config;
  let gateway: EnclaveGateway;
  let sessionId: string;
  let secret: Buffer;
  let modelId: string;
  const infer = vi.fn<core.NearInferenceAdapter>();

  async function signedResult(input: Buffer) {
    const requestBody = Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: input.toString("utf8") }], stream: false }));
    const responseBody = Buffer.from(JSON.stringify({ id: "completion-test", model, choices: [{ message: { content: answer } }] }));
    const requestHash = core.sha256Hex(requestBody);
    const responseHash = core.sha256Hex(responseBody);
    const signatureText = `${model}:${requestHash.slice(2)}:${responseHash.slice(2)}`;
    const now = Date.now();
    return { output: Buffer.from(answer), evidence: {
      schemaVersion: 1 as const, provider: "near" as const, signatureKind: "provider_tee" as const,
      endpoint: "https://test.completions.near.ai", model, completionId: "completion-test", requestHash, responseHash,
      outputHash: core.sha256Hex(answer), signatureText, signature: await signer.signMessage({ message: signatureText }),
      signingAddress: signer.address, attestationRef: core.sha256Hex("fixture hardware"),
      verifiedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), tlsBound: true as const,
    }, transcript: { requestBody, responseBody, attestationProof: '{"fixture":"hardware evidence"}' } };
  }

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
    owner = `provider-${randomUUID()}`; keyHash = core.sha256Hex(owner);
    config = { ...base, SERVING_IMAGE_ID: owner, INFERENCE_BACKEND: "near-verified", INFERENCE_MODEL: model,
      INFERENCE_BASE_URL: "https://test.completions.near.ai/v1", INFERENCE_ALLOW_REMOTE: true,
      INFERENCE_API_KEY: "fixture-secret", NEAR_VERIFIER_PYTHON: "fixture-python", NEAR_ATTESTATION_POLICY: "fixture-policy",
      MODEL_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000007", ALLOW_LOCAL_BOOTSTRAP: false };
    infer.mockReset().mockImplementation(signedResult);
    vi.spyOn(core, "createNearInference").mockReturnValue(infer);
    await db.insert(apiKeys).values({ keyHash, label: owner });
    gateway = await EnclaveGateway.boot(db, config, log, undefined);
    const quote = await gateway.quote();
    const [row] = await db.insert(models).values({ modelHash: core.sha256Hex(`model:${model}`), codeHash: quote.measurement, version: "fixture", provider: keyHash, approved: true }).returning();
    modelId = row!.id;
    sessionId = (await gateway.openSession(owner, quote)).sessionId;
    secret = gateway.sessionWrapKey(sessionId);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const table of [payments, receipts, usage, idempotencyKeys]) await db.delete(table).where(eq(table.keyHash, keyHash));
    await db.delete(sessions).where(eq(sessions.apiKeyHash, keyHash));
    await db.delete(models).where(eq(models.provider, keyHash));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, keyHash));
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (!/^provider_evidence_[a-f0-9]{32}$/.test(isolatedSchema)) throw new Error("Unexpected fixture schema");
    await adminSql`drop schema if exists ${adminSql(isolatedSchema)} cascade`;
    await adminSql.end({ timeout: 5 });
  });

  async function paidInput() {
    const input = { apiKey: owner, sessionId, blob: core.encryptAesGcm(secret, Buffer.from(prompt)), idempotencyKey: randomUUID() };
    let paymentId: string;
    try { await gateway.infer(input); throw new Error("Expected payment challenge"); }
    catch (error) { paymentId = (error as { details: { accepts: [{ extra: { paymentId: string } }] } }).details.accepts[0].extra.paymentId; }
    // Simulate a settled local legacy payment; actual chain settlement is covered separately.
    await db.update(payments).set({ status: "settled" }).where(eq(payments.id, paymentId));
    return { ...input, paymentId };
  }

  it("encrypts the transcript, binds evidence to the receipt and persists exact replay after restart", async () => {
    const input = await paidInput();
    const result = await gateway.infer(input);
    expect(core.decryptAesGcm(secret, result.output!).toString()).toBe(answer);
    const evidence = result.providerEvidence!;
    expect(await core.verifyProviderProof(evidence.proof, result.receipt, (await gateway.solvency("USDC")).signer, config.ARC_CHAIN_ID, config.ATTESTATION_VERIFIER_ADDRESS as `0x${string}`)).toBe(true);
    const decoded = JSON.parse(core.decryptAesGcm(secret, evidence.transcript).toString());
    const transcript = { requestBody: Buffer.from(decoded.requestBody, "base64"), responseBody: Buffer.from(decoded.responseBody, "base64") };
    expect(await core.verifyNearTranscript(evidence.proof.evidence, transcript)).toBe(true);
    expect(JSON.parse(transcript.requestBody.toString()).messages[0].content).toBe(prompt);
    expect(decoded.attestationProof).toBe('{"fixture":"hardware evidence"}');
    expect(() => core.decryptAesGcm(Buffer.alloc(32, 99), evidence.transcript)).toThrow();
    const [stored] = await db.select().from(receipts).where(eq(receipts.typedHash, result.typedHash));
    const [replay] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.keyHash, keyHash));
    expect(JSON.parse(stored!.providerProofJson!)).toEqual(evidence);
    const persisted = JSON.stringify({ stored, replay }, (_, value) => typeof value === "bigint" ? value.toString() : value);
    for (const value of [prompt, answer, "fixture-secret", decoded.attestationProof]) expect(persisted).not.toContain(value);
    const publicReceipt = await gateway.getPublicReceipt(result.typedHash);
    expect(publicReceipt).not.toHaveProperty("providerProofJson");
    expect(publicReceipt).not.toHaveProperty("providerEvidence");
    expect(publicReceipt).not.toHaveProperty("outputJson");
    gateway = await EnclaveGateway.boot(db, config, log, undefined);
    const repeated = await gateway.infer(input);
    expect(repeated).toEqual(result);
    expect(infer).toHaveBeenCalledOnce();
    expect((await db.select().from(usage).where(eq(usage.keyHash, keyHash)))[0]!.calls).toBe(1);
  });

  it("rolls back consumption and receipt creation when hardware verification fails", async () => {
    const input = await paidInput();
    infer.mockRejectedValueOnce(new core.AppError("INFERENCE_ATTESTATION_FAILED", "Hardware rejected", 503));
    await expect(gateway.infer(input)).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect((await db.select().from(payments).where(eq(payments.id, input.paymentId)))[0]!.status).toBe("settled");
    expect(await db.select().from(receipts).where(eq(receipts.keyHash, keyHash))).toHaveLength(0);
    expect(await db.select().from(usage).where(eq(usage.keyHash, keyHash))).toHaveLength(0);
    expect(await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.keyHash, keyHash))).toHaveLength(0);
  });

  it("discards an in-flight provider result when its serving model is revoked", async () => {
    const input = await paidInput();
    infer.mockImplementationOnce(async (bytes) => {
      await db.update(models).set({ approved: false }).where(eq(models.id, modelId));
      return signedResult(bytes);
    });
    await expect(gateway.infer(input)).rejects.toMatchObject({ code: "MODEL_NOT_APPROVED" });
    expect((await db.select().from(payments).where(eq(payments.id, input.paymentId)))[0]!.status).toBe("settled");
    expect(await db.select().from(receipts).where(eq(receipts.keyHash, keyHash))).toHaveLength(0);
  });
});
