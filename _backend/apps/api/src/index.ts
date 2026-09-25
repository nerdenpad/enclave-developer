import { config as loadDotenv } from "dotenv";
import { WalletLogin, PostgresWalletLoginStore } from "./wallet-auth.js";
import { serve } from "@hono/node-server";
import { Queue } from "bullmq";
import { createDb } from "@enclave/db";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createApp } from "./app.js";
import { EnclaveGateway } from "./gateway.js";
import { startReconciliation } from "./reconciliation.js";
import { AgentRuntime, PostgresAgentRunStore } from "./agent-runtime.js";
import { loadOrCreateCvmKeys, storedToBuffers } from "./cvm-store.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url) });
loadDotenv();

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const { db, sql } = createDb(config.DATABASE_URL);

const receiptAnchorer = new Queue("receipt-anchorer", { connection: { url: config.REDIS_URL } });
receiptAnchorer.on("error", (err) => { log.error({ err }, "receipt_queue_error"); });
const gateway = await EnclaveGateway.boot(db, config, log, { receiptAnchorer });
const reconciliation = startReconciliation(() => gateway.reconcilePayments(), (err) => log.error({ err }, "payment_reconciliation_failed"));
const { stored } = await loadOrCreateCvmKeys();
const agentCallTimeout = config.INFERENCE_TIMEOUT_MS + 60_000;
const agentRuntime = new AgentRuntime({
  store: new PostgresAgentRunStore(db), gateway,
  hostSecret: storedToBuffers(stored).wrappingKey,
  enabled: config.AGENT_RUNTIME_ENABLED, paymentMode: config.PAYMENT_MODE, chainId: config.ARC_CHAIN_ID,
  maxSteps: config.AGENT_RUNTIME_MAX_STEPS, maxBudgetUnits: BigInt(config.AGENT_RUNTIME_MAX_BUDGET_UNITS),
  maxDurationMs: config.AGENT_RUNTIME_MAX_DURATION_MS, callTimeoutMs: agentCallTimeout,
  leaseMs: 2 * agentCallTimeout,
});
const agentRunner = config.AGENT_RUNTIME_ENABLED
  ? startReconciliation(() => agentRuntime.runNext(), () => log.error("agent_runtime_tick_failed"), config.AGENT_RUNTIME_POLL_MS)
  : undefined;
const walletLogin = config.WALLET_AUTH_ORIGIN ? new WalletLogin(config.WALLET_AUTH_ORIGIN, new PostgresWalletLoginStore(sql)) : undefined;
const app = createApp(gateway, log, agentRuntime, walletLogin);

const server = serve({ fetch: app.fetch, hostname: config.API_HOST, port: config.API_PORT }, (info) => {
  log.info({ host: info.address, port: info.port }, "api_listen");
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutdown_initiated");
  const timeout = setTimeout(() => process.exit(1), 30_000);
  try {
    const failures: unknown[] = [];
    // Stop admitting new jobs immediately, while the existing HTTP/agent work drains.
    const agentStopped = agentRunner?.stop().catch(() => { failures.push(new Error("Agent runtime shutdown failed")); });
    // The callback fires after active HTTP requests finish using SQL and the queue.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => { if (err) reject(err); else resolve(); });
    }).catch((err: unknown) => { failures.push(err); });
    await reconciliation.stop().catch((err: unknown) => { failures.push(err); });
    await agentStopped;
    const closed = await Promise.allSettled([
      Promise.resolve().then(() => receiptAnchorer.close()),
      Promise.resolve().then(() => sql.end({ timeout: 5 })),
    ]);
    for (const outcome of closed) {
      if (outcome.status === "rejected") failures.push(outcome.reason);
    }
    if (failures.length > 0) throw new AggregateError(failures, "API shutdown failed");
    clearTimeout(timeout);
    process.exit(0);
  } catch (err) {
    log.error({ err }, "shutdown_failed");
    clearTimeout(timeout);
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
