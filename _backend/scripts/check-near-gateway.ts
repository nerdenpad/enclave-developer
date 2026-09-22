/** Opt-in paid test, launched only inside the disposable integration environment. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "dotenv";
import { eq } from "drizzle-orm";
import { createPublicClient, http, type Hex } from "viem";
import { foundry } from "viem/chains";
import { apiKeys, createDb, receipts } from "@enclave/db";
import { encryptAesGcm, decryptAesGcm, sha256Hex, verifyProviderProof, verifyNearTranscript } from "@enclave/core";
import { EnclaveGateway } from "../apps/api/src/gateway.js";
import { loadConfig } from "../apps/api/src/config.js";
import { createLogger } from "../apps/api/src/logger.js";
import { anchorReceipt, hasVerifiedReceipt } from "../apps/worker/src/anchorer.js";

const start = Date.now();
let connection: ReturnType<typeof createDb> | undefined;
try {
  assert.equal(process.env.ENCLAVE_INTEGRATION, "1");
  assert.equal(process.env.ARC_CHAIN_ID, "31337");
  assert.match(process.env.ENCLAVE_CVM_PATH ?? "", /[\\/]work[\\/]integration-[^\\/]+[\\/]cvm\.json$/);
  const profile = parse(await readFile(".env.near"));
  const env = { ...process.env };
  for (const [name, value] of Object.entries(profile)) if (name.startsWith("INFERENCE_") || name.startsWith("NEAR_")) env[name] = value;
  const config = loadConfig({ ...env, NODE_ENV: "test", PAYMENT_MODE: "mock", NEAR_MAX_TOKENS: "32" });
  assert.equal(config.INFERENCE_BACKEND, "near-verified");
  const client = createPublicClient({ chain: foundry, transport: http(config.ARC_RPC_URL) });
  assert.equal(await client.getChainId(), 31337);
  connection = createDb(config.DATABASE_URL);
  const { db } = connection;
  const owner = `near-live-${randomUUID()}`;
  const keyHash = sha256Hex(owner);
  await db.insert(apiKeys).values({ keyHash, role: "admin", label: "NEAR live disposable test" });
  const log = createLogger("silent");
  const gateway = await EnclaveGateway.boot(db, config, log, undefined);
  const quote = await gateway.quote();
  const listing = await gateway.listModel({ apiKey: owner, modelHash: sha256Hex(`model:${config.INFERENCE_MODEL}`), codeHash: quote.measurement, version: "near-live-development", bps: 0 });
  assert.ok(listing.listingId);
  await gateway.bootstrapApproveListing(owner, listing.listingId);
  const { sessionId } = await gateway.openSession(owner, quote);
  const secret = gateway.sessionWrapKey(sessionId);
  const input = { apiKey: owner, sessionId, idempotencyKey: randomUUID(), blob: encryptAesGcm(secret, Buffer.from("Reply with the single word READY.")) };
  let paymentId: string | undefined;
  try { await gateway.infer(input); } catch (error) { paymentId = (error as { details: { accepts: [{ extra: { paymentId: string } }] } }).details.accepts[0].extra.paymentId; }
  assert.ok(paymentId);
  const payment = await gateway.settlePayment(owner, paymentId);
  const result = await gateway.infer({ ...input, paymentId });
  const proof = result.providerEvidence!.proof;
  const output = decryptAesGcm(secret, result.output!);
  assert.equal(sha256Hex(output), result.receipt.outHash);
  assert.ok(await verifyProviderProof(proof, result.receipt, (await gateway.solvency("USDC")).signer, 31337, config.ATTESTATION_VERIFIER_ADDRESS as Hex));
  const decoded = JSON.parse(decryptAesGcm(secret, result.providerEvidence!.transcript).toString());
  assert.ok(await verifyNearTranscript(proof.evidence, { requestBody: Buffer.from(decoded.requestBody, "base64"), responseBody: Buffer.from(decoded.responseBody, "base64") }));
  const restarted = await EnclaveGateway.boot(db, config, log, undefined);
  assert.deepEqual(await restarted.infer({ ...input, paymentId }), result);
  const view = await gateway.issueViewKey(owner, "live acceptance");
  const exported = await gateway.exportWithViewKey(view.secret);
  assert.ok(exported.receipts.some((row) => row.typedHash === result.typedHash));
  await anchorReceipt({ db, log, verifier: config.ATTESTATION_VERIFIER_ADDRESS, rpcUrl: config.ARC_RPC_URL, chainId: 31337, privateKey: config.DEPLOYER_PRIVATE_KEY }, { typedHash: result.typedHash });
  const [stored] = await db.select().from(receipts).where(eq(receipts.typedHash, result.typedHash));
  assert.equal(stored!.status, "anchored");
  assert.ok(hasVerifiedReceipt(await client.getTransactionReceipt({ hash: stored!.anchoredTx as Hex }), config.ATTESTATION_VERIFIER_ADDRESS, result.typedHash));
  const metadata = { ok: true, checkedAt: new Date().toISOString(), model: config.INFERENCE_MODEL, requests: 1, maxTokens: 32,
    elapsedMs: Date.now() - start, outputBytes: output.length, cpuStatus: JSON.parse(decoded.attestationProof).verdict.cpuStatus,
    gpuCount: JSON.parse(decoded.attestationProof).verdict.gpuCount, policyVersion: JSON.parse(decoded.attestationProof).verdict.policyVersion,
    providerSignatureVerified: true, receiptBindingVerified: true, encryptedRoundTripVerified: true, restartReplayVerified: true,
    auditorExportVerified: true, settlementTx: payment.tx, receiptHash: result.typedHash, anchorTx: stored!.anchoredTx,
    chain: "disposable Anvil 31337", localGatewayTeeMode: "dev", hardwareProvider: "NEAR managed GPU" };
  await writeFile("work/near-gateway-live.json", `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(JSON.stringify(metadata));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : "CHECK_FAILED";
  console.error(JSON.stringify({ nearGatewayLive: false, code, elapsedMs: Date.now() - start, automaticRetry: false }));
  process.exitCode = 1;
} finally { await connection?.sql.end({ timeout: 5 }); }
