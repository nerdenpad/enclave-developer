import { config as loadDotenv } from "dotenv";
import { Queue, Worker } from "bullmq";
import pino from "pino";
import { z } from "zod";
import { withRelayKey } from "@enclave/core/relay-key";
import { isConfiguredAddress } from "@enclave/core";
import { createDb } from "@enclave/db";
import { anchorReceipt } from "./anchorer.js";
import { startChainIndexer } from "./indexer.js";
import { startAttestRefresher, startReceiptRecovery, startSignerRecovery, startUsageSettler } from "./jobs.js";
import { createShutdown } from "./lifecycle.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url) });
loadDotenv();

const env = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  LOG_LEVEL: z.string().default("info"),
  ATTESTATION_VERIFIER_ADDRESS: z.string().optional(),
  USAGE_METER_ADDRESS: z.string().optional(),
  FEE_VAULT_ADDRESS: z.string().optional(),
  MODEL_REGISTRY_ADDRESS: z.string().optional(),
  ARC_RPC_URL: z.string().default("http://127.0.0.1:8545"),
  ARC_CHAIN_ID: z.coerce.number().int().positive().default(31337),
  CHAIN_CONFIRMATIONS: z.coerce.number().int().min(0).max(1000).optional(),
  CHAIN_DEPLOYMENT_ID: z.string().min(1).optional(),
  DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/)
    .default("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
    .transform((value): `0x${string}` => `0x${value.slice(2)}`),
}).parse(withRelayKey(process.env));

const log = pino({ level: env.LOG_LEVEL });
const confirmations = env.CHAIN_CONFIRMATIONS ?? ([31337, 1337].includes(env.ARC_CHAIN_ID) ? 0 : 12);
const { db, sql } = createDb(env.DATABASE_URL);
const connection = { url: env.REDIS_URL };
const queue = new Queue("receipt-anchorer", { connection });
const worker = new Worker("receipt-anchorer", async (job) => {
  await anchorReceipt({
    db,
    verifier: env.ATTESTATION_VERIFIER_ADDRESS,
    rpcUrl: env.ARC_RPC_URL,
    chainId: env.ARC_CHAIN_ID,
    confirmations,
    privateKey: env.DEPLOYER_PRIVATE_KEY,
    log,
  }, job.data);
}, { connection });
worker.on("failed", (job, err) => {
  log.error({ err, jobId: job?.id }, "job_failed");
});
worker.on("error", (err) => { log.error({ err }, "worker_error"); });
queue.on("error", (err) => { log.error({ err }, "queue_error"); });

const tasks = [
  startChainIndexer({
    db,
    rpcUrl: env.ARC_RPC_URL,
    chainId: env.ARC_CHAIN_ID,
    verifier: env.ATTESTATION_VERIFIER_ADDRESS,
    meter: env.USAGE_METER_ADDRESS,
    feeVault: env.FEE_VAULT_ADDRESS,
    registry: env.MODEL_REGISTRY_ADDRESS,
    confirmations,
    ...(env.CHAIN_DEPLOYMENT_ID ? { deploymentId: env.CHAIN_DEPLOYMENT_ID } : {}),
    log,
  }),
  startAttestRefresher({ db, log }),
  startUsageSettler({ db, log }),
  startReceiptRecovery({ db, queue, log, chain: { rpcUrl: env.ARC_RPC_URL, chainId: env.ARC_CHAIN_ID, verifier: env.ATTESTATION_VERIFIER_ADDRESS, confirmations } }),
  startSignerRecovery({ db, rpcUrl: env.ARC_RPC_URL, chainId: env.ARC_CHAIN_ID, privateKey: env.DEPLOYER_PRIVATE_KEY, confirmations, log }),
];
const drain = createShutdown({ worker, tasks, sql });
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutdown_initiated");
  const timeout = setTimeout(() => process.exit(1), 30_000);
  try {
    await drain();
    await queue.close();
    clearTimeout(timeout);
    process.exit(0);
  } catch (err) {
    log.error({ err }, "shutdown_failed");
    clearTimeout(timeout);
    process.exit(1);
  }
}
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });
log.info({ onChain: isConfiguredAddress(env.ATTESTATION_VERIFIER_ADDRESS), meter: env.USAGE_METER_ADDRESS }, "worker_listen");
