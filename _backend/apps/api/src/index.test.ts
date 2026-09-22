import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  config: { LOG_LEVEL: "silent", DATABASE_URL: "postgres://test-only/api", REDIS_URL: "redis://test-only:6379", API_HOST: "127.0.0.1", API_PORT: 8787,
    INFERENCE_TIMEOUT_MS: 30_000, PAYMENT_MODE: "mock", ARC_CHAIN_ID: 31337, AGENT_RUNTIME_ENABLED: false,
    AGENT_RUNTIME_POLL_MS: 1000, AGENT_RUNTIME_MAX_STEPS: 8, AGENT_RUNTIME_MAX_BUDGET_UNITS: 1_000_000, AGENT_RUNTIME_MAX_DURATION_MS: 900_000 },
  db: {}, sql: { end: vi.fn() }, queue: { on: vi.fn(), close: vi.fn() },
  queueFactory: vi.fn(), log: { info: vi.fn(), error: vi.fn() },
  boot: vi.fn(), gateway: { reconcilePayments: vi.fn() }, fetch: vi.fn(), app: vi.fn(), serve: vi.fn(), server: { close: vi.fn() },
  agentFactory: vi.fn(), storeFactory: vi.fn(), agent: { runNext: vi.fn() }, agentStore: {}, hostSecret: Buffer.alloc(32, 17),
}));
vi.mock("dotenv", () => ({ config: vi.fn() }));
vi.mock("./config.js", () => ({ loadConfig: () => runtime.config }));
vi.mock("./logger.js", () => ({ createLogger: () => runtime.log }));
vi.mock("@enclave/db", () => ({ createDb: () => ({ db: runtime.db, sql: runtime.sql }) }));
vi.mock("bullmq", () => ({ Queue: function (...args: unknown[]) { runtime.queueFactory(...args); return runtime.queue; } }));
vi.mock("./gateway.js", () => ({ EnclaveGateway: { boot: runtime.boot } }));
vi.mock("./app.js", () => ({ createApp: runtime.app }));
vi.mock("@hono/node-server", () => ({ serve: runtime.serve }));
vi.mock("./agent-runtime.js", () => ({
  AgentRuntime: function (options: unknown) { runtime.agentFactory(options); return runtime.agent; },
  PostgresAgentRunStore: function (db: unknown) { runtime.storeFactory(db); return runtime.agentStore; },
}));
vi.mock("./cvm-store.js", () => ({ loadOrCreateCvmKeys: async () => ({ stored: {} }), storedToBuffers: () => ({ wrappingKey: runtime.hostSecret }) }));

const handlers = new Map<string, () => void>();
let finishRequests: (err?: Error) => void;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  runtime.boot.mockResolvedValue(runtime.gateway);
  runtime.config.AGENT_RUNTIME_ENABLED = false;
  runtime.agent.runNext.mockResolvedValue(undefined);
  runtime.gateway.reconcilePayments.mockResolvedValue(0);
  runtime.app.mockReturnValue({ fetch: runtime.fetch });
  runtime.serve.mockImplementation((_options: unknown, listen: (info: { address: string; port: number }) => void) => {
    listen({ address: "127.0.0.1", port: 8787 });
    return runtime.server;
  });
  runtime.server.close.mockImplementation((done: (err?: Error) => void) => { finishRequests = done; });
  runtime.queue.close.mockResolvedValue(undefined);
  runtime.sql.end.mockResolvedValue(undefined);
  handlers.clear();
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "SIGTERM" || event === "SIGINT") handlers.set(event, listener);
    return process;
  });
  // REASON: observe shutdown's exit code without terminating Vitest.
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("API process lifecycle", () => {
  it("boots the gateway and HTTP server with the receipt queue and handles Redis errors", async () => {
    await import("./index.js");
    expect(runtime.queueFactory).toHaveBeenCalledWith("receipt-anchorer", { connection: { url: runtime.config.REDIS_URL } });
    expect(runtime.boot).toHaveBeenCalledWith(runtime.db, runtime.config, runtime.log, { receiptAnchorer: runtime.queue });
    expect(runtime.app).toHaveBeenCalledWith(runtime.gateway, runtime.log, runtime.agent);
    expect(runtime.agentFactory).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, store: runtime.agentStore,
      gateway: runtime.gateway, hostSecret: runtime.hostSecret, maxBudgetUnits: 1_000_000n, callTimeoutMs: 90_000, leaseMs: 180_000 }));
    expect(runtime.agent.runNext).not.toHaveBeenCalled();
    expect(runtime.serve).toHaveBeenCalledWith({ fetch: runtime.fetch, hostname: "127.0.0.1", port: 8787 }, expect.any(Function));
    expect(runtime.log.info).toHaveBeenCalledWith({ host: "127.0.0.1", port: 8787 }, "api_listen");
    expect(runtime.gateway.reconcilePayments).toHaveBeenCalledOnce();
    const err = new Error("redis disconnected");
    const [event, listener] = runtime.queue.on.mock.calls[0]!;
    expect(event).toBe("error");
    listener(err);
    expect(runtime.log.error).toHaveBeenCalledWith({ err }, "receipt_queue_error");
  });

  it("drains active HTTP requests before closing SQL or Redis and ignores repeated signals", async () => {
    await import("./index.js");
    handlers.get("SIGTERM")!();
    handlers.get("SIGINT")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.server.close).toHaveBeenCalledOnce();
    expect(runtime.queue.close).not.toHaveBeenCalled();
    expect(runtime.sql.end).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    finishRequests();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.queue.close).toHaveBeenCalledOnce();
    expect(runtime.sql.end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["http", "redis", "sql"] as const)("attempts remaining cleanup and logs a %s shutdown failure", async (resource) => {
    const error = new Error(`${resource} unavailable`);
    if (resource === "redis") runtime.queue.close.mockRejectedValue(error);
    if (resource === "sql") runtime.sql.end.mockRejectedValue(error);
    await import("./index.js");
    handlers.get("SIGINT")!();
    await vi.advanceTimersByTimeAsync(0);
    finishRequests(resource === "http" ? error : undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.queue.close).toHaveBeenCalledOnce();
    expect(runtime.sql.end).toHaveBeenCalledOnce();
    expect(runtime.log.error).toHaveBeenCalledWith({ err: expect.any(AggregateError) }, "shutdown_failed");
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forces exit after the deadline if a request never drains", async () => {
    await import("./index.js");
    handlers.get("SIGTERM")!();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(runtime.sql.end).not.toHaveBeenCalled();
  });
  it("stops admitting agent jobs immediately on shutdown and drains the current step before SQL closes", async () => {
    runtime.config.AGENT_RUNTIME_ENABLED = true;
    let finishJob!: () => void;
    runtime.agent.runNext.mockImplementationOnce(() => new Promise<void>((resolve) => { finishJob = resolve; }));
    await import("./index.js");
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.agent.runNext).toHaveBeenCalledOnce();
    handlers.get("SIGTERM")!();
    await vi.advanceTimersByTimeAsync(4000);
    expect(runtime.agent.runNext).toHaveBeenCalledOnce();
    finishRequests();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.sql.end).not.toHaveBeenCalled();
    finishJob();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.sql.end).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports agent tick errors without logging raw credentials and retries only another scheduled tick", async () => {
    runtime.config.AGENT_RUNTIME_ENABLED = true;
    runtime.agent.runNext.mockRejectedValueOnce(new Error("private-owner-credential"));
    await import("./index.js");
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.agent.runNext).toHaveBeenCalledTimes(2);
    expect(runtime.log.error).toHaveBeenCalledExactlyOnceWith("agent_runtime_tick_failed");
    expect(JSON.stringify(runtime.log.error.mock.calls)).not.toContain("private-owner-credential");
    handlers.get("SIGTERM")!();
    finishRequests();
    await vi.advanceTimersByTimeAsync(0);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
