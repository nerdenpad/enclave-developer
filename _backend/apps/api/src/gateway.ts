import { QuoteBody, InferBody, SettleBody } from "./validation.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import {
  AppError,
  ConflictError,
  DevCvm,
  ForbiddenError,
  MandateBreachError,
  ModelNotApprovedError,
  NotFoundError,
  PaymentRequiredError,
  UnauthorizedError,
  ValidationError,
  assertAgentModel,
  decryptAesGcm,
  encryptAesGcm,
  createOpenAICompatibleInference,
  createNearInference,
  hashAgentPolicy,
  hashViewSecret,
  listingBpsValid,
  modelServingAllowed,
  paymentRequiredBody,
  publicPaymentView,
  publicReceiptView,
  receiptTypedHash,
  reserveMandate,
  sha256Hex,
  splitFee,
  tcbPolicyHash,
  usdcToUnits,
  viewSecretMatches,
  isAgentSdkTool,
  agentSdkManifest,
  type AesGcmBlob,
  type AgentPolicy,
  type AttestationQuote,
  type SignedReceipt,
  type ProviderProof,
  type TcbPolicy,
} from "@enclave/core";
import {
  type Database,
  TransactionRevertedError,
  agents,
  apiKeys,
  buybacks,
  chainEvents,
  idempotencyKeys,
  mandates,
  models,
  payments,
  receipts,
  sessions,
  usage,
  viewKeys,
} from "@enclave/db";
import type { Queue } from "bullmq";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { loadOrCreateCvmKeys, storedToBuffers } from "./cvm-store.js";
import { authorizationData, validateAuthorization } from "./authorization.js";
import { settlementScope, verifySettlementProof } from "./settlement-proof.js";
import { createNearAttestationVerifier } from "./near-provider.js";
import { TcbLifecycle, createTcbStore, assertCurrentTcb, type TcbState } from "./tcb-lifecycle.js";
import { createTcbRegistry, verifyTcbApproval } from "./tcb-chain.js";
import { createPaymentRequired, validateExactPayload, X402PaidError, type TransferAuthorization, type X402Payload, type X402PaymentRequired } from "./x402-v2.js";
import {
  createFacilitator,
  createX402Facilitator,
  verifyX402FundingProof,
  createEconomicOps,
  createRegistryApproval,
  createMarketplace,
  createMandator,
  createStaking,
  mandateConfigured,
  marketplaceConfigured,
  meterConfigured,
  stakingConfigured,
  type PaymentAuthorization,
} from "./chain.js";

export type Queues = {
  receiptAnchorer: Queue;
};

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type GatewayInferenceResult = {
  receipt: SignedReceipt; typedHash: `0x${string}`; outputHash: `0x${string}`; output?: AesGcmBlob;
  providerEvidence?: { proof: ProviderProof; transcript: AesGcmBlob };
};
type X402Stored = { kind: "x402-v2"; required: X402PaymentRequired; fromBlock: string; authorization?: TransferAuthorization; from?: `0x${string}`; fundingTx?: `0x${string}`; admission?: { blockNumber: string; blockHash: `0x${string}` } };
type X402InferInput = { apiKey: string; sessionId: string; blob: AesGcmBlob; agentId?: string | undefined; idempotencyKey?: string | undefined };
const workspaceQuery = z.object({ limit: z.number().int().min(1).max(100).default(50),
  receiptsBefore: z.string().uuid().optional(), paymentsBefore: z.string().uuid().optional(), agentsBefore: z.string().uuid().optional() }).strict();
export type WorkspaceQuery = z.input<typeof workspaceQuery>;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function isUniqueViolation(err: unknown): boolean {
  const record = err as { code?: string; cause?: { code?: string } };
  return record.code === "23505" || record.cause?.code === "23505";
}

function serializeReceipt(receipt: SignedReceipt) {
  return { ...receipt, ts: receipt.ts.toString() };
}

function parseAgentPolicy(json: string): AgentPolicy {
  const raw = JSON.parse(json) as { dailyLimitUnits: string; allowedModels: string[] };
  return { dailyLimitUnits: BigInt(raw.dailyLimitUnits), allowedModels: raw.allowedModels ?? [] };
}

function decryptRequest(secret: Buffer, blob: AesGcmBlob): Buffer {
  try { return decryptAesGcm(secret, blob); }
  catch { throw new ValidationError({ ciphertext: "Invalid encrypted request" }); }
}

function publicAgent(row: typeof agents.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    ownerKeyHash: row.ownerKeyHash,
    policyHash: row.policyHash,
    memoryHash: row.memoryHash,
    sealedMemory: JSON.parse(row.sealedMemory) as AesGcmBlob,
    createdAt: row.createdAt.toISOString(),
  };
}

export class EnclaveGateway {
  private tcbLifecycle: TcbLifecycle | undefined;
  constructor(
    private readonly db: Database,
    private cvm: DevCvm,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly queues: Queues | undefined,
  ) {}

  static async boot(db: Database, config: Config, log: Logger, queues: Queues | undefined): Promise<EnclaveGateway> {
    const { stored, vendor } = await loadOrCreateCvmKeys();
    const policy: TcbPolicy = {
      version: config.TCB_POLICY_VERSION,
      servingImageId: config.SERVING_IMAGE_ID,
      requireCpuTee: true,
      requireGpuCc: true,
    };
    const cvm = await DevCvm.create(
      {
        policy,
        modelId: config.INFERENCE_BACKEND === "echo" ? "echo" : config.INFERENCE_MODEL,
        ...(config.INFERENCE_BACKEND === "openai-compatible" ? { inference: createOpenAICompatibleInference({
          baseUrl: config.INFERENCE_BASE_URL, model: config.INFERENCE_MODEL, timeoutMs: config.INFERENCE_TIMEOUT_MS,
          allowRemote: config.INFERENCE_ALLOW_REMOTE,
          ...(config.INFERENCE_API_KEY !== undefined ? { apiKey: config.INFERENCE_API_KEY } : {}),
          ...(config.INFERENCE_HEALTH_PATH !== undefined ? { healthPath: config.INFERENCE_HEALTH_PATH } : {}),
        }) } : {}),
        ...(config.INFERENCE_BACKEND === "near-verified" ? { verifiedInference: createNearInference({
          baseUrl: config.INFERENCE_BASE_URL, model: config.INFERENCE_MODEL, apiKey: config.INFERENCE_API_KEY!,
          timeoutMs: config.INFERENCE_TIMEOUT_MS, maxTokens: config.NEAR_MAX_TOKENS,
          verifyAttestation: createNearAttestationVerifier({ pythonPath: config.NEAR_VERIFIER_PYTHON!, policyPath: config.NEAR_ATTESTATION_POLICY! }),
        }) } : {}),
        chainId: config.ARC_CHAIN_ID,
        verifyingContract: config.ATTESTATION_VERIFIER_ADDRESS as `0x${string}`,
      },
      vendor,
      storedToBuffers(stored),
    );
    log.info(
      { signer: cvm.enclaveAddress, vendor: vendor.address, mode: config.TEE_MODE },
      "cvm_ready",
    );
    const gateway = new EnclaveGateway(db, cvm, config, log, queues);
    await gateway.syncTcb();
    return gateway;
  }

  async policy(): Promise<TcbPolicy> {
    return { ...(await this.syncTcb()).state.policy };
  }

  private lifecycle(): TcbLifecycle {
    this.tcbLifecycle ??= new TcbLifecycle(createTcbStore(this.db), this.config, this.cvm.config.policy, this.cvm.modelHash);
    return this.tcbLifecycle;
  }

  private async syncTcb(): Promise<{ cvm: DevCvm; state: TcbState }> {
    const state = await this.lifecycle().current();
    if (state.binding === "onchain") {
      const approval = await verifyTcbApproval(this.config, { modelHash: this.cvm.modelHash, codeHash: state.measurement,
        policyHash: state.policyHash, version: state.version });
      if (approval.scope !== state.scope) throw new ConflictError("TCB activation belongs to another chain deployment");
    } else if (state.binding === "local-fixture" && (!this.config.ALLOW_LOCAL_BOOTSTRAP || this.config.ARC_CHAIN_ID !== 31337)) {
      throw new ConflictError("Local software TCB fixture is not enabled for this deployment");
    }
    if (state.version < this.cvm.config.policy.version) throw new ConflictError("Active TCB state moved backwards");
    if (tcbPolicyHash(this.cvm.config.policy) !== state.policyHash || (state.binding !== "legacy" && this.cvm.config.sessionKeyBinding !== "policy")) {
      this.cvm = this.cvm.withPolicy(state.policy);
    }
    return { cvm: this.cvm, state };
  }

  health() {
    return {
      ok: true as const,
      service: "enclave-gateway",
      teeMode: this.config.TEE_MODE,
      inferenceBackend: this.config.INFERENCE_BACKEND,
      chainId: this.config.ARC_CHAIN_ID,
      paymentMode: this.config.PAYMENT_MODE,
      servingModel: { id: this.cvm.config.modelId, name: this.cvm.config.modelId, modelHash: this.cvm.modelHash, codeHash: this.cvm.codeHash },
      receiptSigner: this.cvm.enclaveAddress,
      verifierAddress: this.config.ATTESTATION_VERIFIER_ADDRESS,
      agentRuntimeEnabled: this.config.AGENT_RUNTIME_ENABLED,
      inferencePriceUsdc: this.config.INFERENCE_PRICE_USDC,
    };
  }

  /** Owner-only projections. Cursor pivots remain in SQL to preserve timestamp microseconds. */
  async workspace(apiKey: string, query: WorkspaceQuery = {}) {
    const keyHash = await this.requireKey(apiKey), parsed = workspaceQuery.safeParse(query);
    if (!parsed.success) throw new ValidationError({ pagination: "Expected limit 1..100 and UUID cursors" });
    const { limit, receiptsBefore, paymentsBefore, agentsBefore } = parsed.data, day = todayKey();
    return this.db.transaction(async (tx) => {
      const [totals, receiptRows, paymentRows, agentRows] = await Promise.all([
        tx.select({ calls: usage.calls, usdcUnits: usage.usdcUnits }).from(usage).where(eq(usage.keyHash, keyHash)).limit(1),
        tx.select({ id: receipts.id, receiptVersion: receipts.receiptVersion, nonce: receipts.nonce, chainId: receipts.chainId,
          verifierAddress: receipts.verifierAddress, modelHash: receipts.modelHash, codeHash: receipts.codeHash, inHash: receipts.inHash,
          outHash: receipts.outHash, attRef: receipts.attRef, ts: receipts.ts, sig: receipts.sig, typedHash: receipts.typedHash,
          status: receipts.status, anchoredTx: receipts.anchoredTx, agentId: receipts.agentId, createdAt: receipts.createdAt,
        }).from(receipts).where(and(eq(receipts.keyHash, keyHash), receiptsBefore
          ? sql`(${receipts.createdAt}, ${receipts.id}) < (select ${receipts.createdAt}, ${receipts.id} from ${receipts} where ${receipts.id} = ${receiptsBefore}::uuid and ${receipts.keyHash} = ${keyHash})` : undefined))
          .orderBy(desc(receipts.createdAt), desc(receipts.id)).limit(limit + 1),
        tx.select({ id: payments.id, amountUnits: payments.amountUnits, status: payments.status, settleTx: payments.settleTx,
          receiptHash: payments.receiptHash, agentId: payments.agentId, listingId: payments.listingId, confidential: payments.confidential, createdAt: payments.createdAt,
        }).from(payments).where(and(eq(payments.keyHash, keyHash), paymentsBefore
          ? sql`(${payments.createdAt}, ${payments.id}) < (select ${payments.createdAt}, ${payments.id} from ${payments} where ${payments.id} = ${paymentsBefore}::uuid and ${payments.keyHash} = ${keyHash})` : undefined))
          .orderBy(desc(payments.createdAt), desc(payments.id)).limit(limit + 1),
        tx.select({ id: agents.id, name: agents.name, policyHash: agents.policyHash, memoryHash: agents.memoryHash, createdAt: agents.createdAt,
          policyJson: agents.policyJson, dailyLimitUnits: mandates.dailyLimitUnits, spentTodayUnits: mandates.spentTodayUnits, dayKey: mandates.dayKey, lane: mandates.lane })
          .from(agents).leftJoin(mandates, eq(mandates.agent, sql`${agents.id}::text`)).where(and(eq(agents.ownerKeyHash, keyHash), agentsBefore
            ? sql`(${agents.createdAt}, ${agents.id}) < (select ${agents.createdAt}, ${agents.id} from ${agents} where ${agents.id} = ${agentsBefore}::uuid and ${agents.ownerKeyHash} = ${keyHash})` : undefined))
          .orderBy(desc(agents.createdAt), desc(agents.id)).limit(limit + 1),
      ]);
      const next = (rows: Array<{ id: string }>) => rows.length > limit ? rows[limit - 1]!.id : null;
      return {
        usage: { calls: totals[0]?.calls ?? 0, usdcUnits: (totals[0]?.usdcUnits ?? 0n).toString() },
        receipts: receiptRows.slice(0, limit).map((row) => ({ ...row, ts: row.ts.toString(), createdAt: row.createdAt.toISOString() })),
        payments: paymentRows.slice(0, limit).map((row) => ({ ...row, amountUnits: row.amountUnits.toString(), createdAt: row.createdAt.toISOString() })),
        agents: agentRows.slice(0, limit).map(({ policyJson, dayKey, dailyLimitUnits, spentTodayUnits, ...row }) => {
          let allowedModels: string[] | null = null;
          try {
            const policy = z.object({ allowedModels: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).max(1000) }).safeParse(JSON.parse(policyJson));
            if (policy.success) allowedModels = policy.data.allowedModels;
          } catch { /* Unknown policy is represented explicitly, never as unrestricted. */ }
          return { ...row, createdAt: row.createdAt.toISOString(), dailyLimitUnits: dailyLimitUnits?.toString() ?? null,
            spentTodayUnits: spentTodayUnits === null ? null : (dayKey === day ? spentTodayUnits : 0n).toString(), allowedModels };
        }),
        page: { limit, receiptsNext: next(receiptRows), paymentsNext: next(paymentRows), agentsNext: next(agentRows) },
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async quote(): Promise<AttestationQuote> {
    const { cvm, state } = await this.syncTcb();
    return this.db.transaction(async (tx) => {
      await assertCurrentTcb(tx, state.policyHash);
      return cvm.quote();
    });
  }

  async openSession(apiKey: string, quote: AttestationQuote): Promise<{ sessionId: string; expiresAt: string }> {
    const keyHash = await this.requireKey(apiKey);
    const { cvm, state } = await this.syncTcb();
    await cvm.releaseKeys(quote, cvm.vendorAddress);
    const attRef = sha256Hex(quote.signature);
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    const row = await this.db.transaction(async (tx) => {
      await assertCurrentTcb(tx, state.policyHash);
      const [saved] = await tx
      .insert(sessions)
      .values({
        apiKeyHash: keyHash,
        attRef,
        quoteJson: JSON.stringify(quote),
        expiresAt,
      })
      .returning();
      return saved;
    });
    if (!row) {
      throw new AppError("SESSION_FAILED", "Could not open session", 500);
    }
    this.log.info({ sessionId: row.id, attRef }, "session_opened");
    return { sessionId: row.id, expiresAt: expiresAt.toISOString() };
  }

  async infer(input: {
    apiKey: string;
    sessionId: string;
    blob: AesGcmBlob;
    paymentId?: string | undefined;
    idempotencyKey?: string | undefined;
    agentId?: string | undefined;
  }): Promise<GatewayInferenceResult> {
    const keyHash = await this.requireKey(input.apiKey);
    const { cvm, state } = await this.syncTcb();
    const session = await this.requireSession(input.sessionId, keyHash, cvm);
    const price = usdcToUnits(this.config.INFERENCE_PRICE_USDC);
    await this.assertServingApproved(this.db, cvm, state);
    const agentRow = input.agentId ? await this.requireAgent(input.agentId, keyHash) : undefined;
    if (agentRow) {
      assertAgentModel(parseAgentPolicy(agentRow.policyJson), cvm.modelHash);
    }
    const secret = cvm.sessionSecret(session.id);
    let plaintext = decryptRequest(secret, input.blob);
    const requestHash = sha256Hex(JSON.stringify({ sessionId: session.id, input: sha256Hex(plaintext), agentId: agentRow?.id ?? null,
      memoryHash: agentRow?.memoryHash ?? null, policyHash: agentRow?.policyHash ?? null, modelHash: cvm.modelHash, codeHash: cvm.codeHash }));
    if (agentRow) {
      const memory = cvm.openMemory(JSON.parse(agentRow.sealedMemory) as AesGcmBlob);
      plaintext = Buffer.concat([memory, Buffer.from("\n"), plaintext]);
    }

    if (input.idempotencyKey) {
      const replay = await this.db.transaction(async (tx) => {
        await assertCurrentTcb(tx, state.policyHash);
        return this.loadIdempotent(tx, keyHash, input.idempotencyKey!, requestHash);
      });
      if (replay) {
        return replay;
      }
    }

    if (!input.paymentId) {
      const [serving] = await this.db.select().from(models).where(and(eq(models.modelHash, cvm.modelHash), eq(models.codeHash, cvm.codeHash))).limit(1);
      const intent = await this.openPayment(keyHash, price, input.idempotencyKey, requestHash, agentRow?.id, serving?.listingId ?? null);
      await this.db.transaction((tx) => assertCurrentTcb(tx, state.policyHash));
      throw new PaymentRequiredError("USDC payment required", this.paymentChallenge(intent.id));
    }

    const result = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${keyHash}:${input.idempotencyKey}`}))`);
        const replay = await this.loadIdempotent(tx, keyHash, input.idempotencyKey, requestHash);
        if (replay) {
          await assertCurrentTcb(tx, state.policyHash);
          return replay;
        }
      }

      await this.consumePayment(tx, keyHash, input.paymentId as string, price, requestHash);
      const { receipt, output: outputBytes, providerProof, providerTranscript } = await cvm.infer(plaintext, { attRef: session.attRef as `0x${string}` });
      // A model may be revoked while the remote inference is in progress.
      await assertCurrentTcb(tx, state.policyHash);
      await this.assertServingApproved(tx, cvm, state);
      const output = encryptAesGcm(secret, outputBytes);
      const providerEvidence = providerProof && providerTranscript ? {
        proof: providerProof,
        transcript: encryptAesGcm(secret, Buffer.from(JSON.stringify({
          requestBody: providerTranscript.requestBody.toString("base64"), responseBody: providerTranscript.responseBody.toString("base64"),
          ...(providerTranscript.attestationProof !== undefined ? { attestationProof: providerTranscript.attestationProof } : {}),
        }))),
      } : undefined;
      const typedHash = receiptTypedHash(
        receipt,
        this.config.ARC_CHAIN_ID,
        this.config.ATTESTATION_VERIFIER_ADDRESS as `0x${string}`,
      );
      await tx.insert(receipts).values({
        modelHash: receipt.modelHash,
        codeHash: receipt.codeHash,
        inHash: receipt.inHash,
        outHash: receipt.outHash,
        attRef: receipt.attRef,
        receiptVersion: receipt.receiptVersion,
        nonce: receipt.nonce,
        chainId: this.config.ARC_CHAIN_ID,
        verifierAddress: this.config.ATTESTATION_VERIFIER_ADDRESS,
        outputJson: JSON.stringify(output),
        providerProofJson: providerEvidence ? JSON.stringify(providerEvidence) : null,
        ts: receipt.ts,
        sig: receipt.sig,
        typedHash,
        status: "pending",
        keyHash,
        agentId: agentRow?.id ?? null,
      });

      await tx
        .update(payments)
        .set({ receiptHash: typedHash })
        .where(eq(payments.id, input.paymentId as string));

      await tx
        .insert(usage)
        .values({ keyHash, calls: 1, usdcUnits: price })
        .onConflictDoUpdate({
          target: usage.keyHash,
          set: {
            calls: sql`${usage.calls} + 1`,
            usdcUnits: sql`${usage.usdcUnits} + ${price}`,
            updatedAt: new Date(),
          },
        });

      if (input.idempotencyKey) {
        try {
          await tx.insert(idempotencyKeys).values({
            keyHash,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            typedHash,
            responseJson: JSON.stringify({
              typedHash,
              outputHash: receipt.outHash,
              output,
              ...(providerEvidence ? { providerEvidence } : {}),
              receipt: serializeReceipt(receipt),
            }),
          });
        } catch (err) {
          if (!isUniqueViolation(err)) {
            throw err;
          }
          const replay = await this.loadIdempotent(tx, keyHash, input.idempotencyKey, requestHash);
          if (replay) {
            return replay;
          }
          throw new ConflictError("Idempotency key already used");
        }
      }

      return { receipt, typedHash, outputHash: receipt.outHash, output, ...(providerEvidence ? { providerEvidence } : {}) };
    });

    if (this.queues) {
      await this.queues.receiptAnchorer.add(
        "anchor",
        { typedHash: result.typedHash },
        { jobId: result.typedHash, attempts: 5, backoff: { type: "exponential", delay: 1000 } },
      ).catch(() => {
        // The committed pending receipt is the durable outbox; the worker retries it.
        this.log.warn({ typedHash: result.typedHash }, "anchor_enqueue_deferred");
      });
    }

    this.log.info(
      { typedHash: result.typedHash, modelHash: result.receipt.modelHash, idempotencyKey: input.idempotencyKey },
      "inference_ok",
    );
    return result;
  }

  sessionWrapKey(sessionId: string): Buffer {
    return this.cvm.sessionSecret(sessionId);
  }

  async sessionWrapKeyForOwner(apiKey: string, sessionId: string): Promise<Buffer> {
    const keyHash = await this.requireKey(apiKey);
    const { cvm, state } = await this.syncTcb();
    const session = await this.requireSession(sessionId, keyHash, cvm);
    return this.db.transaction(async (tx) => {
      await assertCurrentTcb(tx, state.policyHash);
      return cvm.sessionSecret(session.id);
    });
  }

  async getReceipt(typedHash: string) {
    const [row] = await this.db.select().from(receipts).where(eq(receipts.typedHash, typedHash)).limit(1);
    if (!row) {
      throw new NotFoundError("receipt", typedHash);
    }
    return row;
  }

  async getPublicReceipt(typedHash: string) {
    const row = await this.getReceipt(typedHash);
    return publicReceiptView(row);
  }

  async getPublicPayment(paymentId: string) {
    const [row] = await this.db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (!row) {
      throw new NotFoundError("payment", paymentId);
    }
    return publicPaymentView(row);
  }

  agentSdkTools() {
    return agentSdkManifest();
  }

  async invokeAgentTool(apiKey: string, tool: string, input: Record<string, unknown>) {
    if (!isAgentSdkTool(tool)) {
      throw new ValidationError({ tool });
    }
    if (tool === "enclave_quote") {
      return this.quote();
    }
    if (tool === "enclave_session") {
      const parsed = QuoteBody.safeParse(input);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const session = await this.openSession(apiKey, parsed.data as AttestationQuote);
      return { ...session, wrapKey: (await this.sessionWrapKeyForOwner(apiKey, session.sessionId)).toString("base64") };
    }
    if (tool === "enclave_settle") {
      const parsed = SettleBody.safeParse(input);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      return this.settlePayment(apiKey, parsed.data.paymentId, parsed.data.confidential ?? false, parsed.data.authorization);
    }
    const parsed = InferBody.safeParse(input);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    const blob = { iv: parsed.data.iv, tag: parsed.data.tag, ciphertext: parsed.data.ciphertext };
    const result = await this.infer({
      apiKey,
      sessionId: parsed.data.sessionId,
      blob,
      paymentId: typeof input.paymentId === "string" ? input.paymentId : undefined,
      agentId: typeof input.agentId === "string" ? input.agentId : undefined,
    });
    return {
      receipt: { ...result.receipt, ts: result.receipt.ts.toString() },
      typedHash: result.typedHash,
      outputHash: result.outputHash,
      output: result.output,
      ...(result.providerEvidence ? { providerEvidence: result.providerEvidence } : {}),
    };
  }

  async listModels() {
    return this.db.select().from(models).where(and(eq(models.approved, true), eq(models.revoked, false)));
  }

  async solvency(asset: string) {
    const listed = await this.listModels();
    return {
      asset,
      models: listed.length,
      keysReleased: this.cvm.keysReleased(),
      signer: this.cvm.enclaveAddress,
    };
  }

  async listChainEvents(limit = 25) {
    return this.db
      .select()
      .from(chainEvents)
      .orderBy(desc(chainEvents.blockNumber), desc(chainEvents.logIndex))
      .limit(limit);
  }

  paymentChallenge(paymentId: string) {
    return paymentRequiredBody({
      network: `arc-${this.config.ARC_CHAIN_ID}`,
      amountUnits: usdcToUnits(this.config.INFERENCE_PRICE_USDC),
      payTo: this.config.FEE_VAULT_ADDRESS,
      asset: this.config.USDC_ADDRESS,
      paymentId,
    });
  }

  inferencePriceUsdc(): number {
    return this.config.INFERENCE_PRICE_USDC;
  }

  async settlePayment(
    apiKey: string,
    paymentId: string,
    confidential = false,
    authorization?: PaymentAuthorization,
  ): Promise<{ paymentId: string; tx: string; confidential: boolean }> {
    const keyHash = await this.requireKey(apiKey);
    return this.performSettlement(keyHash, paymentId, confidential, authorization);
  }

  /** Standard EOA x402 v2 transport; the existing encrypted inference/session contract is preserved. */
  async x402Infer(input: X402InferInput, resourceUrl: string, payload?: X402Payload): Promise<
    { kind: "required"; required: X402PaymentRequired } |
    { kind: "success"; result: GatewayInferenceResult; tx: `0x${string}`; payer: `0x${string}`; chainId: number } |
    { kind: "inference-error"; error: unknown; tx: `0x${string}`; payer: `0x${string}`; chainId: number }
  > {
    if (this.config.PAYMENT_MODE !== "authorized" || !meterConfigured(this.config)) throw new AppError("X402_UNAVAILABLE", "x402 v2 requires configured authorized USDC settlement", 503);
    await createX402Facilitator(this.config, this.db).assertSupported();
    if (!payload) {
      try {
        await this.infer({ ...input, idempotencyKey: input.idempotencyKey ? `x402-challenge:${input.idempotencyKey}` : undefined });
      } catch (error) {
        if (!(error instanceof PaymentRequiredError)) throw error;
        const paymentId = (error.payment as { accepts: Array<{ extra: { paymentId: string } }> }).accepts[0]!.extra.paymentId;
        return { kind: "required", required: await this.x402Challenge(input.apiKey, paymentId, resourceUrl) };
      }
      throw new ConflictError("x402 payment challenge is required");
    }
    // Validate ownership, current model/policy and ciphertext before sending any transaction.
    const keyHash = await this.requireKey(input.apiKey);
    const session = await this.requireSession(input.sessionId, keyHash);
    await this.assertServingApproved();
    const agent = input.agentId ? await this.requireAgent(input.agentId, keyHash) : undefined;
    if (agent) assertAgentModel(parseAgentPolicy(agent.policyJson), this.cvm.modelHash);
    const plaintext = decryptRequest(this.cvm.sessionSecret(session.id), input.blob);
    const requestHash = sha256Hex(JSON.stringify({ sessionId: session.id, input: sha256Hex(plaintext), agentId: agent?.id ?? null,
      memoryHash: agent?.memoryHash ?? null, policyHash: agent?.policyHash ?? null, modelHash: this.cvm.modelHash, codeHash: this.cvm.codeHash }));
    const paymentId = payload.accepted.extra.enclavePaymentId;
    let payment: { tx: `0x${string}`; payer: `0x${string}` };
    try { payment = await this.settleX402ForKey(keyHash, paymentId, payload, resourceUrl, requestHash); }
    catch (error) {
      if (error instanceof X402PaidError) return { kind: "inference-error", error, tx: error.tx, payer: error.payer, chainId: this.config.ARC_CHAIN_ID };
      throw error;
    }
    try {
      const result = await this.infer({ ...input, paymentId, idempotencyKey: `x402-complete:${paymentId}` });
      return { kind: "success", result, tx: payment.tx, payer: payment.payer, chainId: this.config.ARC_CHAIN_ID };
    } catch (error) {
      // Settlement remains valid when the independent inference transaction rolls back.
      return { kind: "inference-error", error, tx: payment.tx, payer: payment.payer, chainId: this.config.ARC_CHAIN_ID };
    }
  }

  async x402Challenge(apiKey: string, paymentId: string, resourceUrl: string): Promise<X402PaymentRequired> {
    const keyHash = await this.requireKey(apiKey);
    const scope = await settlementScope(this.config);
    const fromBlock = await createX402Facilitator(this.config, this.db).blockNumber();
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update").limit(1);
      if (!row || row.keyHash !== keyHash) throw new NotFoundError("payment", paymentId);
      if (row.status !== "open" || (row.settlementMode && row.settlementMode !== "x402")) throw new ConflictError("Payment is not an open x402 intent");
      if (row.authorizationJson) {
        const stored = JSON.parse(row.authorizationJson) as X402Stored;
        if (stored.kind !== "x402-v2" || stored.required.resource.url !== resourceUrl || row.chainScope !== scope) throw new ConflictError("x402 challenge cannot change");
        return stored.required;
      }
      const required = createPaymentRequired({ resourceUrl, paymentId, chainId: this.config.ARC_CHAIN_ID, amount: row.amountUnits,
        asset: this.config.USDC_ADDRESS, payTo: this.config.USAGE_METER_ADDRESS, domainName: this.config.USDC_EIP712_NAME, domainVersion: this.config.USDC_EIP712_VERSION });
      const stored: X402Stored = { kind: "x402-v2", required, fromBlock: fromBlock.toString() };
      await tx.update(payments).set({ settlementMode: "x402", chainScope: scope, authorizationJson: JSON.stringify(stored) }).where(eq(payments.id, paymentId));
      return required;
    });
  }

  private async settleX402ForKey(keyHash: string, paymentId: string, payload: X402Payload, resourceUrl: string, requestHash: string) {
    const scope = await settlementScope(this.config);
    const claim = await this.db.transaction(async (tx) => {
      // The same token authorization may never be attached to two database payment intents.
      const raw = payload.payload.authorization;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`x402:${scope}:${raw.from.toLowerCase()}:${raw.nonce.toLowerCase()}`}, 0))`);
      const [row] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update").limit(1);
      if (!row || row.keyHash !== keyHash) throw new NotFoundError("payment", paymentId);
      if (row.settlementMode !== "x402" || row.chainScope !== scope || row.requestHash !== requestHash || !row.authorizationJson) throw new ConflictError("x402 intent does not match this request or deployment");
      const stored = JSON.parse(row.authorizationJson) as X402Stored;
      if (stored.kind !== "x402-v2" || stored.required.resource.url !== resourceUrl) throw new ConflictError("x402 resource mismatch");
      const auth = await validateExactPayload(payload, stored.required, { allowExpired: stored.authorization !== undefined });
      if (stored.authorization && JSON.stringify(stored.authorization) !== JSON.stringify(auth)) throw new ConflictError("x402 authorization cannot change");
      const duplicate = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.chainScope, scope), eq(payments.settlementMode, "x402"),
        sql`lower(${payments.authorizationJson}::jsonb->'authorization'->>'from') = ${auth.from.toLowerCase()}`,
        sql`lower(${payments.authorizationJson}::jsonb->'authorization'->>'nonce') = ${auth.nonce.toLowerCase()}`,
      )).limit(1);
      if (duplicate[0] && duplicate[0].id !== paymentId) throw new ConflictError("x402 authorization is already bound to another payment");
      if (["settled", "consumed"].includes(row.status)) return { row, stored, auth, already: true as const };
      if (!["open", "settlement_unknown"].includes(row.status)) throw new AppError("SETTLEMENT_PENDING", "x402 settlement is pending reconciliation", 503);
      const admission = stored.authorization ? stored.admission : await createX402Facilitator(this.config, this.db).admission(auth);
      if (!admission) throw new ConflictError("x402 authorization has no durable admission proof");
      if (!stored.authorization) await this.assertMandateTx(tx, row.agentId ?? keyHash, row.amountUnits);
      const updatedStored: X402Stored = { ...stored, admission, authorization: auth, from: auth.from as `0x${string}` };
      const [updated] = await tx.update(payments).set({ status: "settling", settlingStartedAt: new Date(),
        authorizationJson: JSON.stringify(updatedStored), mandateDayKey: row.mandateDayKey ?? todayKey(), confidential: false,
      }).where(eq(payments.id, paymentId)).returning();
      return { row: updated!, stored: updatedStored, auth, already: false as const };
    });
    if (claim.already) {
      if (claim.stored.fundingTx) await verifyX402FundingProof(this.config, claim.auth, claim.stored.fundingTx);
      await verifySettlementProof(this.config, { paymentId, txHash: claim.row.settleTx ?? "", amount: claim.row.amountUnits, confidential: false, payer: claim.auth.from as `0x${string}` });
      return { tx: claim.row.settleTx as `0x${string}`, payer: claim.auth.from as `0x${string}` };
    }
    let proven: { tx: `0x${string}`; payer: `0x${string}` } | undefined;
    try {
      const settled = await createX402Facilitator(this.config, this.db).settle(paymentId, claim.auth, { listingId: claim.row.listingId, agentId: claim.row.agentId,
        admission: claim.stored.admission!, ...(claim.stored.fundingTx ? { fundingTx: claim.stored.fundingTx } : {}) });
      await verifySettlementProof(this.config, { paymentId, txHash: settled.tx, amount: claim.row.amountUnits, confidential: false, payer: claim.auth.from as `0x${string}` });
      proven = { tx: settled.tx, payer: claim.auth.from as `0x${string}` };
      await this.db.update(payments).set({ status: "settled", settleTx: settled.tx, settlingStartedAt: null,
        authorizationJson: JSON.stringify({ ...claim.stored, ...(settled.fundingTx ? { fundingTx: settled.fundingTx } : {}) }),
      }).where(and(eq(payments.id, paymentId), eq(payments.status, "settling"), eq(payments.settlingStartedAt, claim.row.settlingStartedAt!)));
      return { tx: settled.tx, payer: claim.auth.from as `0x${string}` };
    } catch (error) {
      // A reverted wrapper does not prove no debit: a third party may have submitted TransferWithAuthorization.
      // Keep the authorization and local reservation quarantined until canonical recovery is possible.
      try { await this.db.update(payments).set({ status: "settlement_unknown" }).where(and(eq(payments.id, paymentId), eq(payments.status, "settling"), eq(payments.settlingStartedAt, claim.row.settlingStartedAt!))); }
      catch { /* A stale settling row is also recovered by the durable reconciler. */ }
      if (proven) throw new X402PaidError(proven.tx, proven.payer);
      throw new AppError("SETTLEMENT_PENDING", "x402 settlement requires reconciliation", 503);
    }
  }

  async resumeX402Payment(paymentId: string): Promise<void> {
    const [row] = await this.db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (!row || row.settlementMode !== "x402" || !row.authorizationJson || !row.requestHash) throw new ConflictError("No durable x402 intent");
    const stored = JSON.parse(row.authorizationJson) as X402Stored;
    if (stored.kind !== "x402-v2" || !stored.authorization) throw new ConflictError("No durable x402 authorization");
    const { signature, ...authorization } = stored.authorization;
    await this.settleX402ForKey(row.keyHash, row.id, { x402Version: 2, resource: stored.required.resource, accepted: stored.required.accepts[0], payload: { signature, authorization } }, stored.required.resource.url, row.requestHash);
  }

  async paymentAuthorization(apiKey: string, paymentId: string, from: `0x${string}`) {
    const keyHash = await this.requireKey(apiKey);
    const [row] = await this.db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (!row || row.keyHash !== keyHash) throw new NotFoundError("payment", paymentId);
    if (row.status !== "open") throw new ConflictError(`Payment is ${row.status}`);
    const typedData = authorizationData(this.config, row.id, row.amountUnits, from, "0", String(Math.floor(Date.now() / 1000) + 1800));
    return { paymentId, mode: this.config.PAYMENT_MODE, listingId: row.listingId, agentId: row.agentId,
      mandateAddress: row.agentId ? this.config.AGENT_MANDATE_ADDRESS : null,
      typedData: { ...typedData, message: { ...typedData.message, value: typedData.message.value.toString(), validAfter: "0", validBefore: typedData.message.validBefore.toString() } } };
  }

  private async performSettlement(keyHash: string, paymentId: string, confidential = false, authorization?: PaymentAuthorization) {
    if (confidential && (this.config.PAYMENT_MODE !== "mock" || ![31337, 1337].includes(this.config.ARC_CHAIN_ID))) {
      throw new AppError("CONFIDENTIAL_UNAVAILABLE", "No real confidential transfer adapter is configured", 503);
    }
    const currentScope = meterConfigured(this.config) ? await settlementScope(this.config) : null;
    const claimed = await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update").limit(1);
      if (!row || row.keyHash !== keyHash) {
        throw new NotFoundError("payment", paymentId);
      }
      if (row.settlementMode === "x402") throw new ConflictError("x402 v2 payments must use their original protocol");
      if (row.status === "settled") {
        return {
          already: true as const,
          txHash: row.settleTx ?? "",
          row,
        };
      }
      if (row.status === "consumed") {
        throw new ConflictError("Payment already consumed");
      }
      if (row.status !== "open" && !(row.status === "settlement_unknown" && row.settlementMode)) {
        throw new ConflictError(`Payment is ${row.status}`);
      }
      if (row.status === "open") {
        if (this.config.PAYMENT_MODE === "authorized" && !authorization) throw new ValidationError({ authorization: "Signed USDC authorization required" });
        if (this.config.PAYMENT_MODE === "authorized" && authorization) await validateAuthorization(this.config, paymentId, row.amountUnits, authorization);
        if (confidential && row.agentId) throw new ValidationError({ confidential: "Mock confidential payments do not support agent mandates" });
        await this.assertMandateTx(tx, row.agentId ?? keyHash, row.amountUnits);
      } else {
        if (row.chainScope !== currentScope) throw new ConflictError("Payment settlement deployment has changed");
        if (confidential !== row.confidential) throw new ConflictError("Settlement mode cannot change during recovery");
        if (authorization && row.authorizationJson !== JSON.stringify(authorization)) throw new ConflictError("Payment authorization cannot change during recovery");
      }
      const [updated] = await tx.update(payments).set({ status: "settling", settlingStartedAt: new Date(),
        settlementMode: row.settlementMode ?? (meterConfigured(this.config) ? this.config.PAYMENT_MODE : "simulated"),
        authorizationJson: row.authorizationJson ?? (authorization ? JSON.stringify(authorization) : null),
        mandateDayKey: row.mandateDayKey ?? todayKey(), confidential,
        chainScope: currentScope,
      }).where(eq(payments.id, paymentId)).returning();
      return { already: false as const, txHash: "", row: updated! };
    });

    if (claimed.already) {
      return { paymentId, tx: claimed.txHash, confidential: claimed.row.confidential };
    }

    try {
      let settleTx = `sim:${paymentId}`;
      if (claimed.row.settlementMode !== "simulated") {
        // The deterministic open operation survives a DB/RPC failure. Actual spend
        // is performed inside UsageMeter's payment transaction, never in inference.
        if (claimed.row.agentId && claimed.row.settlementMode === "mock" && mandateConfigured(this.config)) {
          const agent = await this.requireAgent(claimed.row.agentId, keyHash);
          await createMandator(this.config, this.db).open(agent.id, parseAgentPolicy(agent.policyJson).dailyLimitUnits);
        }
        const facilitator = createFacilitator(this.config, this.db);
        settleTx = await facilitator.settle(paymentId, claimed.row.amountUnits, confidential, {
          listingId: claimed.row.listingId, agentId: claimed.row.agentId,
          mode: claimed.row.settlementMode as "mock" | "authorized",
          ...(claimed.row.authorizationJson ? { authorization: JSON.parse(claimed.row.authorizationJson) as PaymentAuthorization } : {}),
        });
        const auth = claimed.row.authorizationJson ? JSON.parse(claimed.row.authorizationJson) as PaymentAuthorization : undefined;
        await verifySettlementProof(this.config, { paymentId, txHash: settleTx, amount: claimed.row.amountUnits, confidential,
          ...(auth ? { payer: auth.from } : {}),
        });
      }
      await this.db.update(payments).set({ status: "settled", settleTx, confidential, settlingStartedAt: null }).where(and(
        eq(payments.id, paymentId), eq(payments.status, "settling"), eq(payments.settlingStartedAt, claimed.row.settlingStartedAt!),
      ));
      this.log.info({ paymentId, tx: settleTx, confidential }, "payment_settled");
      return { paymentId, tx: settleTx, confidential };
    } catch (err) {
      // A stale process must never resurrect a consumed payment or overwrite a
      // newer recovery attempt. Only a mined revert proves no transfer happened.
      await this.db.transaction(async (tx) => {
        const [failed] = await tx.update(payments).set({ status: err instanceof TransactionRevertedError ? "failed" : "settlement_unknown" }).where(and(
          eq(payments.id, paymentId), eq(payments.status, "settling"), eq(payments.settlingStartedAt, claimed.row.settlingStartedAt!),
        )).returning();
        if (failed && err instanceof TransactionRevertedError && failed.mandateDayKey) {
          await tx.update(mandates).set({ spentTodayUnits: sql`greatest(0, ${mandates.spentTodayUnits} - ${failed.amountUnits})`, updatedAt: new Date() })
            .where(and(eq(mandates.agent, failed.agentId ?? keyHash), eq(mandates.dayKey, failed.mandateDayKey)));
        }
      });
      throw err;
    }
  }

  /** Called on startup and periodically; only versioned durable intents are safe
   * to resume. Old uncertain payments remain quarantined for explicit review. */
  async reconcilePayments(): Promise<number> {
    await this.db.update(payments).set({ status: "settlement_unknown" }).where(and(eq(payments.status, "settling"), lt(payments.settlingStartedAt, new Date(Date.now() - 120_000))));
    let recovered = 0;
    let afterId: string | undefined;
    while (true) {
      const rows = await this.db.select().from(payments).where(and(eq(payments.status, "settlement_unknown"), inArray(payments.settlementMode, ["mock", "authorized", "simulated", "x402"]), afterId ? gt(payments.id, afterId) : undefined)).orderBy(payments.id).limit(100);
      for (const row of rows) {
        try {
          if (row.settlementMode === "x402") await this.resumeX402Payment(row.id);
          else await this.performSettlement(row.keyHash, row.id, row.confidential);
          recovered++;
        }
        catch (error) { this.log.warn({ paymentId: row.id, error: error instanceof AppError ? error.code : "RECONCILIATION_PENDING" }, "payment_reconciliation_pending"); }
      }
      if (rows.length < 100) break;
      afterId = rows[rows.length - 1]!.id;
    }
    return recovered;
  }

  async createAgent(input: {
    apiKey: string;
    name: string;
    dailyLimitUsdc: number;
    allowedModels?: string[] | undefined;
    sessionId?: string | undefined;
    memory?: AesGcmBlob | undefined;
  }) {
    const keyHash = await this.requireKey(input.apiKey);
    const { cvm, state } = await this.syncTcb();
    const policy: AgentPolicy = {
      dailyLimitUnits: usdcToUnits(input.dailyLimitUsdc),
      allowedModels: input.allowedModels ?? [],
    };
    let memoryPlain: Buffer = Buffer.alloc(0);
    if (input.memory) {
      if (!input.sessionId) {
        throw new ForbiddenError("sessionId required to seal memory");
      }
      const session = await this.requireSession(input.sessionId, keyHash, cvm);
      memoryPlain = decryptRequest(cvm.sessionSecret(session.id), input.memory);
    }
    const sealed = cvm.sealMemory(memoryPlain);
    const row = await this.db.transaction(async (tx) => {
      await assertCurrentTcb(tx, state.policyHash);
      const [row] = await tx
        .insert(agents)
        .values({
          ownerKeyHash: keyHash,
          name: input.name,
          policyJson: JSON.stringify({
            dailyLimitUnits: policy.dailyLimitUnits.toString(),
            allowedModels: policy.allowedModels,
          }),
          policyHash: hashAgentPolicy(policy),
          sealedMemory: JSON.stringify(sealed),
          memoryHash: sha256Hex(memoryPlain),
        })
        .returning();
      if (!row) {
        throw new AppError("AGENT_CREATE_FAILED", "Could not create agent", 500);
      }
      await tx.insert(mandates).values({
        agent: row.id,
        dailyLimitUnits: policy.dailyLimitUnits,
        spentTodayUnits: 0n,
        dayKey: todayKey(),
        lane: "agent",
      });
      return row;
    });
    this.log.info({ agentId: row.id, policyHash: row.policyHash }, "agent_created");
    return publicAgent(row);
  }

  async listAgents(apiKey: string) {
    const keyHash = await this.requireKey(apiKey);
    const rows = await this.db.select().from(agents).where(eq(agents.ownerKeyHash, keyHash));
    return rows.map(publicAgent);
  }

  async getAgent(apiKey: string, agentId: string) {
    const keyHash = await this.requireKey(apiKey);
    return publicAgent(await this.requireAgent(agentId, keyHash));
  }

  async putAgentMemory(input: { apiKey: string; agentId: string; sessionId: string; blob: AesGcmBlob }) {
    const keyHash = await this.requireKey(input.apiKey);
    await this.requireAgent(input.agentId, keyHash);
    const { cvm, state } = await this.syncTcb();
    const session = await this.requireSession(input.sessionId, keyHash, cvm);
    const plain = decryptRequest(cvm.sessionSecret(session.id), input.blob);
    const sealed = cvm.sealMemory(plain);
    const memoryHash = sha256Hex(plain);
    await this.db.transaction(async (tx) => {
      await assertCurrentTcb(tx, state.policyHash);
      await tx
      .update(agents)
      .set({ sealedMemory: JSON.stringify(sealed), memoryHash })
      .where(eq(agents.id, input.agentId));
    });
    return { id: input.agentId, memoryHash, sealedMemory: sealed };
  }

  async stakeEncl(apiKey: string, amount: bigint) {
    await this.requireAdmin(apiKey);
    if (!stakingConfigured(this.config)) {
      throw new AppError("CHAIN_NOT_CONFIGURED", "Staking addresses missing", 503);
    }
    const staking = createStaking(this.config, this.db);
    const tx = await staking.stake(amount);
    const staked = await staking.stakedOf();
    return { tx, staked: staked.toString(), staker: staking.address };
  }

  async unstakeEncl(apiKey: string, amount: bigint) {
    await this.requireAdmin(apiKey);
    if (!stakingConfigured(this.config)) {
      throw new AppError("CHAIN_NOT_CONFIGURED", "Staking addresses missing", 503);
    }
    const staking = createStaking(this.config, this.db);
    const tx = await staking.unstake(amount);
    const staked = await staking.stakedOf();
    return { tx, staked: staked.toString(), staker: staking.address };
  }

  async stakeStatus(apiKey: string) {
    await this.requireKey(apiKey);
    if (!stakingConfigured(this.config)) {
      return { configured: false, staked: "0" };
    }
    const staking = createStaking(this.config, this.db);
    const staked = await staking.stakedOf();
    return { configured: true, staked: staked.toString(), staker: staking.address };
  }

  async distributeFees(apiKey: string) {
    await this.requireAdmin(apiKey);
    const result = await createEconomicOps(this.config, this.db).distributeWithAccounting();
    if (result.reserved > 0n) {
      await this.db.insert(buybacks).values({
        amountUnits: result.reserved,
        distributeTx: result.tx,
        status: "reserved",
      });
    }
    this.log.info({ tx: result.tx, reserved: result.reserved.toString() }, "fees_distributed");
    return {
      tx: result.tx,
      split: {
        treasury: result.treasury.toString(),
        stakers: result.stakers.toString(),
        providers: result.providers.toString(),
        ecosystem: result.ecosystem.toString(),
      },
      buyback: result.reserved > 0n ? { amountUnits: result.reserved.toString(), tx: result.tx, status: "reserved" } : null,
    };
  }

  async stakingRewards(apiKey: string) {
    await this.requireKey(apiKey);
    if (!stakingConfigured(this.config)) throw new AppError("CHAIN_NOT_CONFIGURED", "Staking addresses missing", 503);
    const ops = createEconomicOps(this.config, this.db);
    return { staker: ops.address, pendingUnits: (await ops.pendingRewards()).toString() };
  }

  async claimStakingRewards(apiKey: string) {
    await this.requireAdmin(apiKey);
    if (!stakingConfigured(this.config)) throw new AppError("CHAIN_NOT_CONFIGURED", "Staking addresses missing", 503);
    const claimed = await createEconomicOps(this.config, this.db).claimRewards();
    return { tx: claimed.tx, staker: claimed.staker, amountUnits: claimed.amount.toString() };
  }

  async buybackStatus(apiKey: string) {
    await this.requireKey(apiKey);
    const status = await createEconomicOps(this.config, this.db).buybackStatus();
    return { ...status, reserved: status.reserved.toString(), availableForDistribution: status.availableForDistribution.toString() };
  }

  async configureBuyback(apiKey: string, input: { router: string; tokenOut: string; recipient: string }) {
    await this.requireAdmin(apiKey);
    const tx = await createEconomicOps(this.config, this.db).configureBuyback(input.router as `0x${string}`, input.tokenOut as `0x${string}`, input.recipient as `0x${string}`);
    return { tx, ...input };
  }

  async setBuybackReserve(apiKey: string, treasuryBps: number) {
    await this.requireAdmin(apiKey);
    const tx = await createEconomicOps(this.config, this.db).setBuybackReserve(treasuryBps);
    return { tx, treasuryBps };
  }

  async executeBuyback(apiKey: string, input: { amountUnits: bigint; minOut: bigint; deadline: bigint }) {
    await this.requireAdmin(apiKey);
    const executed = await createEconomicOps(this.config, this.db).executeBuyback(input.amountUnits, input.minOut, input.deadline);
    await this.db.insert(buybacks).values({ amountUnits: executed.amountIn, txHash: executed.tx, status: "executed" });
    return { tx: executed.tx, amountUnits: executed.amountIn.toString(), outputUnits: executed.amountOut.toString(), recipient: executed.recipient };
  }

  async listBuybacks(apiKey: string) {
    await this.requireKey(apiKey);
    const rows = await this.db.select().from(buybacks).orderBy(desc(buybacks.createdAt)).limit(50);
    return rows.map((row) => ({
      id: row.id,
      amountUnits: row.amountUnits.toString(),
      txHash: row.txHash,
      distributeTx: row.distributeTx,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async feeSplitPreview(apiKey: string, amountUnits: bigint) {
    await this.requireKey(apiKey);
    const parts = splitFee(amountUnits);
    return {
      amountUnits: amountUnits.toString(),
      treasury: parts.treasury.toString(),
      stakers: parts.stakers.toString(),
      providers: parts.providers.toString(),
      ecosystem: parts.ecosystem.toString(),
    };
  }

  async listMarketplace() {
    return this.db.select().from(models);
  }

  async listModel(input: {
    apiKey: string;
    modelHash: string;
    codeHash: string;
    version: string;
    bps: number;
    policyHash?: string | undefined;
    policyVersion?: number | undefined;
    idempotencyKey?: string | undefined;
  }) {
    const keyHash = await this.requireAdmin(input.apiKey);
    if (!listingBpsValid(input.bps)) {
      throw new AppError("INVALID_BPS", "listingBps must be 0..10000", 400);
    }
    let listingId: number | null = null;
    let tx = "";
    const policyBound = input.policyVersion !== undefined || input.policyHash !== undefined;
    if (policyBound) {
      if (!marketplaceConfigured(this.config)) throw new AppError("CHAIN_NOT_CONFIGURED", "TCB policy listing requires a configured registry", 503);
      if (input.idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) throw new ValidationError({ idempotencyKey: "Invalid listing idempotency key" });
      const policy = (await this.lifecycle().list()).history.find((row) => row.version === input.policyVersion);
      if (!policy || policy.policyHash !== input.policyHash || policy.measurement !== input.codeHash) {
        throw new ConflictError("Listing must match a stored TCB policy and its measurement");
      }
      const operationKey = `tcb-list:${sha256Hex(JSON.stringify({ keyHash, key: input.idempotencyKey ?? {
        modelHash: input.modelHash, codeHash: input.codeHash, version: input.version, bps: input.bps, policyHash: policy.policyHash,
      } }))}`;
      const listed = await createTcbRegistry(this.config, this.db).listWithPolicy({ modelHash: input.modelHash as `0x${string}`,
        codeHash: policy.measurement, policyHash: policy.policyHash, policyVersion: BigInt(policy.version) }, input.bps, operationKey);
      listingId = Number(listed.id);
      if (!Number.isSafeInteger(listingId) || listingId > 2_147_483_647) throw new ConflictError("Listing identifier exceeds supported database range");
      tx = listed.tx;
    } else if (marketplaceConfigured(this.config)) {
      const market = createMarketplace(this.config, this.db);
      const listed = await market.list(input.modelHash as `0x${string}`, input.codeHash as `0x${string}`, input.bps);
      listingId = Number(listed.id);
      tx = listed.tx;
    }
    const insert = this.db.insert(models).values({
        modelHash: input.modelHash,
        codeHash: input.codeHash,
        version: input.version,
        provider: keyHash,
        approved: false,
        revoked: false,
        listingBps: input.bps,
        listingId,
      });
    const [saved] = policyBound
      ? await insert.onConflictDoNothing({ target: [models.modelHash, models.codeHash] }).returning()
      : await insert.returning();
    const row = saved ?? (await this.db.select().from(models).where(and(eq(models.modelHash, input.modelHash), eq(models.codeHash, input.codeHash))).limit(1))[0];
    if (!row || row.version !== input.version || row.listingBps !== input.bps || row.listingId !== listingId) {
      throw new ConflictError("Listing already has different immutable database metadata");
    }
    return { ...row, tx };
  }

  async approveListing(apiKey: string, listingId: number) {
    await this.requireAdmin(apiKey);
    const state = await this.listingApprovalStatus(listingId);
    if (state.state === "revoked") throw new ConflictError("Revoked listings cannot be approved");
    if (state.state === "pending") throw new AppError("TIMELOCK_ACTIVE", "Listing approval is timelocked", 409, { availableAt: state.availableAt });
    const tx = state.state === "approved" ? null : await createRegistryApproval(this.config, this.db).approve(BigInt(listingId));
    await this.db.update(models).set({ approved: true, revoked: false }).where(eq(models.listingId, listingId));
    return { listingId, approved: true, tx };
  }

  async listingApprovalStatus(listingId: number) {
    if (!marketplaceConfigured(this.config)) throw new AppError("CHAIN_NOT_CONFIGURED", "Model registry address missing", 503);
    const status = await createRegistryApproval(this.config).status(BigInt(listingId));
    if (status.state === "missing") throw new NotFoundError("listing", String(listingId));
    return status;
  }

  async bootstrapApproveListing(apiKey: string, listingId: number) {
    await this.requireAdmin(apiKey);
    if (!this.config.ALLOW_LOCAL_BOOTSTRAP || this.config.ARC_CHAIN_ID !== 31337) throw new ForbiddenError("Local bootstrap is disabled");
    if (!marketplaceConfigured(this.config)) throw new AppError("CHAIN_NOT_CONFIGURED", "Model registry address missing", 503);
    const tx = await createMarketplace(this.config, this.db).bootstrapApprove(BigInt(listingId));
    await this.db.update(models).set({ approved: true, revoked: false }).where(eq(models.listingId, listingId));
    return { listingId, approved: true, tx, bootstrap: true };
  }

  async revokeListing(apiKey: string, listingId: number) {
    await this.requireAdmin(apiKey);
    if (marketplaceConfigured(this.config)) {
      const market = createMarketplace(this.config, this.db);
      await market.revoke(BigInt(listingId));
    }
    await this.db.update(models).set({ approved: false, revoked: true }).where(eq(models.listingId, listingId));
    return { listingId, revoked: true };
  }

  async revokeServingModel(apiKey: string) {
    await this.requireAdmin(apiKey);
    const [row] = await this.db
      .select()
      .from(models)
      .where(and(eq(models.modelHash, this.cvm.modelHash), eq(models.codeHash, this.cvm.codeHash)))
      .limit(1);
    if (marketplaceConfigured(this.config) && row?.listingId) {
      await createMarketplace(this.config, this.db).revoke(BigInt(row.listingId));
    }
    await this.db
      .update(models)
      .set({ approved: false, revoked: true })
      .where(and(eq(models.modelHash, this.cvm.modelHash), eq(models.codeHash, this.cvm.codeHash)));
    return { modelHash: this.cvm.modelHash, revoked: true };
  }

  async restoreServingModel(apiKey: string) {
    await this.requireAdmin(apiKey);
    if (!this.config.ALLOW_LOCAL_BOOTSTRAP || this.config.ARC_CHAIN_ID !== 31337) throw new ForbiddenError("Local bootstrap is disabled");
    const [row] = await this.db
      .select()
      .from(models)
      .where(and(eq(models.modelHash, this.cvm.modelHash), eq(models.codeHash, this.cvm.codeHash)))
      .limit(1);
    if (marketplaceConfigured(this.config) && row?.listingId) {
      await createMarketplace(this.config, this.db).bootstrapRestore(BigInt(row.listingId));
    }
    await this.db
      .update(models)
      .set({ approved: true, revoked: false })
      .where(and(eq(models.modelHash, this.cvm.modelHash), eq(models.codeHash, this.cvm.codeHash)));
    return { modelHash: this.cvm.modelHash, approved: true };
  }

  async issueViewKey(apiKey: string, label: string) {
    const keyHash = await this.requireKey(apiKey);
    const secret = `enclave_vk_${randomBytes(16).toString("hex")}`;
    const [row] = await this.db
      .insert(viewKeys)
      .values({ ownerKeyHash: keyHash, secretHash: hashViewSecret(secret), label })
      .returning();
    if (!row) {
      throw new AppError("VIEW_KEY_FAILED", "Could not issue view key", 500);
    }
    return { id: row.id, label: row.label, secret };
  }

  async exportWithViewKey(secret: string) {
    const digest = hashViewSecret(secret);
    const [vk] = await this.db.select().from(viewKeys).where(eq(viewKeys.secretHash, digest)).limit(1);
    if (!vk || !viewSecretMatches(secret, vk.secretHash)) {
      throw new ForbiddenError("Invalid view key");
    }
    const [receiptRows, paymentRows, usageRows] = await Promise.all([
      this.db.select().from(receipts).where(eq(receipts.keyHash, vk.ownerKeyHash)),
      this.db.select().from(payments).where(eq(payments.keyHash, vk.ownerKeyHash)),
      this.db.select().from(usage).where(eq(usage.keyHash, vk.ownerKeyHash)),
    ]);
    const usageRow = usageRows[0];
    return {
      auditor: { id: vk.id, label: vk.label },
      receipts: receiptRows.map((row) => ({
        typedHash: row.typedHash,
        modelHash: row.modelHash,
        codeHash: row.codeHash,
        inHash: row.inHash,
        outHash: row.outHash,
        attRef: row.attRef,
        receiptVersion: row.receiptVersion,
        nonce: row.nonce,
        chainId: row.chainId,
        verifierAddress: row.verifierAddress,
        status: row.status,
        ts: row.ts.toString(),
        agentId: row.agentId,
        sig: row.sig,
      })),
      payments: paymentRows.map((row) => ({
        id: row.id,
        amountUnits: row.amountUnits.toString(),
        status: row.status,
        settleTx: row.settleTx,
        receiptHash: row.receiptHash,
        confidential: row.confidential,
      })),
      usage: {
        calls: usageRow?.calls ?? 0,
        usdcUnits: (usageRow?.usdcUnits ?? 0n).toString(),
      },
    };
  }

  async listTcbPolicies() {
    await this.syncTcb();
    return this.lifecycle().list();
  }

  async rotateTcbPolicy(apiKey: string, servingImageId: string, options: { version?: number; idempotencyKey?: string } = {}) {
    await this.requireAdmin(apiKey);
    await this.syncTcb();
    return this.lifecycle().propose(servingImageId, options);
  }

  async activateTcbPolicy(apiKey: string, version: number, expectedActiveVersion: number, idempotencyKey?: string) {
    await this.requireAdmin(apiKey);
    const result = await this.lifecycle().activate(version, expectedActiveVersion, idempotencyKey);
    await this.syncTcb();
    this.log.info({ previous: result.previous.version, active: result.active.version, binding: result.active.binding }, "software_tcb_activated");
    return result;
  }

  private async assertServingApproved(db: Pick<Database, "select"> | Tx = this.db, cvm = this.cvm, state?: TcbState): Promise<void> {
    const active = state ?? (await this.syncTcb()).state;
    if (active.binding === "onchain") {
      const approval = await verifyTcbApproval(this.config, { modelHash: cvm.modelHash, codeHash: cvm.codeHash,
        policyHash: active.policyHash, version: active.version });
      if (approval.scope !== active.scope) throw new ConflictError("TCB activation belongs to another chain deployment");
    } else if (active.binding === "local-fixture" && (!this.config.ALLOW_LOCAL_BOOTSTRAP || this.config.ARC_CHAIN_ID !== 31337)) {
      throw new ConflictError("Local software TCB fixture is not enabled for this deployment");
    }
    if (marketplaceConfigured(this.config)) {
      const onChain = await createMarketplace(this.config, this.db).isApproved(
        cvm.modelHash,
        cvm.codeHash,
      );
      if (!onChain) {
        throw new ModelNotApprovedError();
      }
    }
    const [row] = await db
      .select()
      .from(models)
      .where(and(eq(models.modelHash, cvm.modelHash), eq(models.codeHash, cvm.codeHash)))
      .limit(1);
    if (!modelServingAllowed(row)) {
      throw new ModelNotApprovedError();
    }
  }

  private async requireAgent(agentId: string, keyHash: string) {
    const [row] = await this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!row || row.ownerKeyHash !== keyHash) {
      throw new NotFoundError("agent", agentId);
    }
    return row;
  }

  private async openPayment(keyHash: string, amount: bigint, intentKey: string | undefined, requestHash: string, agentId: string | undefined, listingId: number | null) {
    if (intentKey) {
      const [existing] = await this.db
        .select()
        .from(payments)
        .where(and(eq(payments.keyHash, keyHash), eq(payments.intentKey, intentKey)))
        .limit(1);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ConflictError("Idempotency key already bound to a different request");
        return existing;
      }
    }
    try {
      const [row] = await this.db
        .insert(payments)
        .values({ keyHash, amountUnits: amount, status: "open", intentKey: intentKey ?? null, requestHash, agentId: agentId ?? null, listingId })
        .returning();
      if (!row) {
        throw new AppError("PAYMENT_INTENT_FAILED", "Could not open payment", 500);
      }
      return row;
    } catch (err) {
      if (intentKey && isUniqueViolation(err)) {
        const [existing] = await this.db
          .select()
          .from(payments)
          .where(and(eq(payments.keyHash, keyHash), eq(payments.intentKey, intentKey)))
          .limit(1);
        if (existing) {
          if (existing.requestHash !== requestHash) throw new ConflictError("Idempotency key already bound to a different request");
          return existing;
        }
      }
      throw err;
    }
  }

  private async loadIdempotent(
    db: Pick<Database, "select"> | Tx,
    keyHash: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<GatewayInferenceResult | undefined> {
    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.keyHash, keyHash), eq(idempotencyKeys.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (!row) {
      return undefined;
    }
    if (row.requestHash !== requestHash) throw new ConflictError("Idempotency key already bound to a different request");
    const parsed = JSON.parse(row.responseJson) as GatewayInferenceResult;
    parsed.receipt.ts = BigInt(parsed.receipt.ts);
    return parsed;
  }

  private async consumePayment(tx: Tx, keyHash: string, paymentId: string, amount: bigint, requestHash: string): Promise<void> {
    const [row] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update").limit(1);
    if (!row || row.keyHash !== keyHash) {
      throw new NotFoundError("payment", paymentId);
    }
    if (row.requestHash && row.requestHash !== requestHash) throw new ConflictError("Payment is bound to a different request");
    if (row.status !== "settled") {
      throw new PaymentRequiredError("USDC payment required", this.paymentChallenge(paymentId));
    }
    if (row.amountUnits < amount) {
      throw new PaymentRequiredError("USDC payment required", this.paymentChallenge(paymentId));
    }
    if (row.settlementMode && row.settlementMode !== "simulated") {
      if (row.chainScope !== await settlementScope(this.config)) throw new ConflictError("Payment settlement deployment has changed");
      if (row.settlementMode === "x402" && row.authorizationJson) {
        const stored = JSON.parse(row.authorizationJson) as X402Stored;
        if (!stored.authorization) throw new ConflictError("Missing x402 authorization");
        if (stored.fundingTx) await verifyX402FundingProof(this.config, stored.authorization, stored.fundingTx);
      }
      const auth = row.authorizationJson ? JSON.parse(row.authorizationJson) as PaymentAuthorization : undefined;
      await verifySettlementProof(this.config, { paymentId, txHash: row.settleTx ?? "", amount: row.amountUnits, confidential: row.confidential,
        ...(auth ? { payer: auth.from } : {}),
      });
    }
    const updated = await tx
      .update(payments)
      .set({ status: "consumed" })
      .where(and(eq(payments.id, paymentId), eq(payments.status, "settled")))
      .returning();
    if (updated.length === 0) {
      throw new ConflictError("Payment already consumed");
    }
  }

  private async requireKey(apiKey: string): Promise<string> {
    const keyHash = sha256Hex(apiKey);
    const [row] = await this.db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
    if (!row) {
      throw new UnauthorizedError("Unknown API key");
    }
    return keyHash;
  }

  private async requireAdmin(apiKey: string): Promise<string> {
    const keyHash = await this.requireKey(apiKey);
    const [row] = await this.db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
    if (row?.role !== "admin") throw new ForbiddenError("Administrator role required");
    return keyHash;
  }

  private async requireSession(sessionId: string, keyHash: string, suppliedCvm?: DevCvm) {
    const cvm = suppliedCvm ?? (await this.syncTcb()).cvm;
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!row || row.apiKeyHash !== keyHash) {
      throw new UnauthorizedError("Invalid session");
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError("Session expired");
    }
    // Revalidate the stored signed quote at the original session admission time.
    // The server-owned session expiry controls its lifetime across process restarts.
    if (row.quoteJson) {
      const quote = JSON.parse(row.quoteJson) as AttestationQuote;
      if (sha256Hex(quote.signature) !== row.attRef) throw new UnauthorizedError("Session attestation mismatch");
      await cvm.releaseKeys(quote, cvm.vendorAddress, row.createdAt.getTime());
    } else throw new UnauthorizedError("Session has no durable attestation; open a new session");
    return row;
  }

  private async assertMandateTx(tx: Tx, agent: string, amount: bigint): Promise<void> {
    const day = todayKey();
    const [row] = await tx.select().from(mandates).where(eq(mandates.agent, agent)).for("update").limit(1);
    if (!row) {
      return;
    }
    const next = reserveMandate(row, day, amount);
    const updated = await tx
      .update(mandates)
      .set({ dayKey: next.dayKey, spentTodayUnits: next.spentTodayUnits, updatedAt: new Date() })
      .where(eq(mandates.agent, agent))
      .returning();
    if (updated.length === 0) {
      throw new MandateBreachError();
    }
  }
}
