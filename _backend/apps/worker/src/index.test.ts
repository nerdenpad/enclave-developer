import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  worker: { on: vi.fn(), close: vi.fn() },
  queue: { on: vi.fn(), close: vi.fn() },
  workerFactory: vi.fn(), queueFactory: vi.fn(),
  db: {}, sql: {},
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  anchor: vi.fn(), indexer: vi.fn(), refresher: vi.fn(), settler: vi.fn(), recovery: vi.fn(), signerRecovery: vi.fn(),
  drain: vi.fn(), shutdown: vi.fn(),
}));
vi.mock("dotenv", () => ({ config: vi.fn() }));
vi.mock("pino", () => ({ default: () => runtime.log }));
vi.mock("@enclave/db", () => ({ createDb: () => ({ db: runtime.db, sql: runtime.sql }) }));
vi.mock("bullmq", () => ({
  Worker: function (...args: unknown[]) { runtime.workerFactory(...args); return runtime.worker; },
  Queue: function (...args: unknown[]) { runtime.queueFactory(...args); return runtime.queue; },
}));
vi.mock("./anchorer.js", () => ({ anchorReceipt: runtime.anchor }));
vi.mock("./indexer.js", () => ({ startChainIndexer: runtime.indexer }));
vi.mock("./jobs.js", () => ({ startAttestRefresher: runtime.refresher, startUsageSettler: runtime.settler, startReceiptRecovery: runtime.recovery, startSignerRecovery: runtime.signerRecovery }));
vi.mock("./lifecycle.js", () => ({ createShutdown: (...args: unknown[]) => { runtime.shutdown(...args); return runtime.drain; } }));
const handlers = new Map<string, () => void>();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("DATABASE_URL", "postgres://test-only/worker");
  vi.stubEnv("REDIS_URL", "redis://test-only:6379");
  vi.stubEnv("LOG_LEVEL", "silent");
  vi.stubEnv("ARC_RPC_URL", "http://rpc.test");
  vi.stubEnv("ARC_CHAIN_ID", "5042002");
  vi.stubEnv("CHAIN_CONFIRMATIONS", undefined);
  vi.stubEnv("CHAIN_DEPLOYMENT_ID", undefined);
  vi.stubEnv("ATTESTATION_VERIFIER_ADDRESS", "0x5FbDB2315678afecb367f032d93F642f64180aa3");
  vi.stubEnv("DEPLOYER_PRIVATE_KEY", `0x${"12".repeat(32)}`);
  runtime.drain.mockResolvedValue(undefined);
  runtime.queue.close.mockResolvedValue(undefined);
  const task = { stop: vi.fn().mockResolvedValue(undefined) };
  for (const start of [runtime.indexer, runtime.refresher, runtime.settler, runtime.recovery, runtime.signerRecovery]) start.mockReturnValue(task);
  handlers.clear();
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "SIGTERM" || event === "SIGINT") handlers.set(event, listener);
    return process;
  });
  // REASON: observing exit must not terminate the test process.
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("worker startup and process signals", () => {
  it("wires the processor, configured chain, maintenance jobs and Redis errors", async () => {
    await import("./index.js");
    expect(runtime.workerFactory).toHaveBeenCalledWith("receipt-anchorer", expect.any(Function), { connection: { url: "redis://test-only:6379" } });
    const processor: (job: { data: unknown }) => Promise<void> = runtime.workerFactory.mock.calls[0]![1];
    await processor({ data: { typedHash: "test" } });
    expect(runtime.anchor).toHaveBeenCalledWith(expect.objectContaining({ db: runtime.db, chainId: 5042002, rpcUrl: "http://rpc.test", confirmations: 12 }), { typedHash: "test" });
    expect(runtime.indexer).toHaveBeenCalledWith(expect.objectContaining({ chainId: 5042002, confirmations: 12 }));
    expect(runtime.signerRecovery).toHaveBeenCalledWith(expect.objectContaining({ db: runtime.db, chainId: 5042002, confirmations: 12 }));
    expect(runtime.recovery).toHaveBeenCalledWith({ db: runtime.db, queue: runtime.queue, log: runtime.log, chain: { rpcUrl: "http://rpc.test", chainId: 5042002, verifier: "0x5FbDB2315678afecb367f032d93F642f64180aa3", confirmations: 12 } });
    expect(runtime.shutdown).toHaveBeenCalledWith(expect.objectContaining({ tasks: expect.arrayContaining([expect.objectContaining({ stop: expect.any(Function) })]) }));
    const error = new Error("redis disconnected");
    for (const [event, listener] of runtime.worker.on.mock.calls) {
      if (event === "failed") listener({ id: "job-1" }, error);
      if (event === "error") listener(error);
    }
    runtime.queue.on.mock.calls[0]![1](error);
    expect(runtime.log.error).toHaveBeenCalledWith({ err: error, jobId: "job-1" }, "job_failed");
    expect(runtime.log.error).toHaveBeenCalledWith({ err: error }, "worker_error");
    expect(runtime.log.error).toHaveBeenCalledWith({ err: error }, "queue_error");
  });
  it("drains once even when both termination signals arrive", async () => {
    await import("./index.js");
    handlers.get("SIGTERM")!();
    handlers.get("SIGINT")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.drain).toHaveBeenCalledOnce();
    expect(runtime.queue.close).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("logs shutdown errors and exits unsuccessfully", async () => {
    const err = new Error("could not drain");
    runtime.drain.mockRejectedValue(err);
    await import("./index.js");
    handlers.get("SIGINT")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.log.error).toHaveBeenCalledWith({ err }, "shutdown_failed");
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("forces termination if draining does not finish within 30 seconds", async () => {
    runtime.drain.mockReturnValue(new Promise<void>(() => undefined));
    await import("./index.js");
    handlers.get("SIGTERM")!();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
  it("fails startup on an invalid private key before opening Redis", async () => {
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", "malformed");
    await expect(import("./index.js")).rejects.toThrow();
    expect(runtime.workerFactory).not.toHaveBeenCalled();
  });
  it("applies operator finality and deployment identity to background jobs", async () => {
    vi.stubEnv("CHAIN_CONFIRMATIONS", "5");
    vi.stubEnv("CHAIN_DEPLOYMENT_ID", "deployment-v2");
    await import("./index.js");
    expect(runtime.indexer).toHaveBeenCalledWith(expect.objectContaining({ confirmations: 5, deploymentId: "deployment-v2" }));
    expect(runtime.signerRecovery).toHaveBeenCalledWith(expect.objectContaining({ confirmations: 5 }));
  });
  it("uses zero confirmation delay on a local development chain", async () => {
    vi.stubEnv("ARC_CHAIN_ID", "31337");
    await import("./index.js");
    expect(runtime.indexer).toHaveBeenCalledWith(expect.objectContaining({ confirmations: 0 }));
    expect(runtime.signerRecovery).toHaveBeenCalledWith(expect.objectContaining({ confirmations: 0 }));
  });
});
