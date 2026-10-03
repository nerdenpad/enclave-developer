import { http, type HttpTransportConfig } from "viem";
import type { Config } from "./config.js";

type BudgetConfig = Pick<Config, "ARC_RPC_URL" | "ARC_CHAIN_ID" | "ARC_RPC_MAX_RPS">;
type Pending = { input: Parameters<typeof fetch>[0]; init?: RequestInit; signal: AbortSignal;
  resolve: (response: Response) => void; reject: (reason: unknown) => void; cleanup: () => void; started: boolean };

function budget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) throw new RangeError("ARC_RPC_MAX_RPS must be an integer between 1 and 20");
  return value;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Serializes HTTP attempts, rather than clients or cached chain values. */
export function createRpcFetchPool(fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  options: { maxPending?: number; timeoutMs?: number; maxEndpoints?: number } = {}) {
  const maxPending = options.maxPending ?? 64, timeoutMs = options.timeoutMs ?? 20_000, maxEndpoints = options.maxEndpoints ?? 64;
  for (const [name, value, maximum] of [["maxPending", maxPending, 1024], ["timeoutMs", timeoutMs, 60_000], ["maxEndpoints", maxEndpoints, 256]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`Invalid RPC ${name}`);
  }
  const endpoints = new Map<string, { fetchFn: typeof fetch; lowerBudget: (rps: number) => void }>();
  return (config: BudgetConfig): typeof fetch => {
    const rps = budget(config.ARC_RPC_MAX_RPS ?? ([31337, 1337].includes(config.ARC_CHAIN_ID) ? 20 : 2));
    let key: string;
    try {
      const endpoint = new URL(config.ARC_RPC_URL);
      endpoint.hash = "";
      key = endpoint.href;
    } catch { throw new Error("Invalid RPC endpoint URL"); }
    const existing = endpoints.get(key);
    if (existing) { existing.lowerBudget(rps); return existing.fetchFn; }
    if (endpoints.size >= maxEndpoints) throw new Error("RPC endpoint budget capacity exceeded");
    let spacingMs = Math.ceil(1000 / rps), lastStartedAt = -Infinity, running = false, pendingCount = 0;
    const queue: Pending[] = [];
    async function drain() {
      if (running) return;
      running = true;
      try {
        while (queue.length) {
          const request = queue.shift()!;
          request.started = true;
          try {
            request.signal.throwIfAborted();
            while (lastStartedAt + spacingMs > performance.now()) await wait(lastStartedAt + spacingMs - performance.now(), request.signal);
            request.signal.throwIfAborted();
            lastStartedAt = performance.now();
            request.resolve(await fetcher(request.input, { ...request.init, signal: request.signal }));
          } catch (error) { request.reject(error); }
          finally { pendingCount--; request.cleanup(); }
        }
      } finally { running = false; }
    }
    const fetchFn: typeof fetch = (input, init) => {
      const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (requestSignal?.aborted) return Promise.reject(requestSignal.reason);
      if (pendingCount >= maxPending) return Promise.reject(new Error("RPC request queue capacity exceeded"));
      pendingCount++;
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new DOMException("RPC request deadline exceeded", "TimeoutError")), timeoutMs);
      const signal = requestSignal ? AbortSignal.any([requestSignal, deadline.signal]) : deadline.signal;
      return new Promise<Response>((resolve, reject) => {
        const request: Pending = { input, ...(init ? { init } : {}), signal, resolve, reject, started: false,
          cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); } };
        const aborted = () => {
          reject(signal.reason);
          if (!request.started) {
            const index = queue.indexOf(request);
            if (index >= 0) { queue.splice(index, 1); pendingCount--; request.cleanup(); }
          }
        };
        signal.addEventListener("abort", aborted, { once: true });
        queue.push(request);
        void drain();
      });
    };
    // Conflicting clients can tighten the shared budget; none can silently loosen it.
    endpoints.set(key, { fetchFn, lowerBudget: next => { spacingMs = Math.max(spacingMs, Math.ceil(1000 / next)); } });
    return fetchFn;
  };
}

export const apiRpcFetch = createRpcFetchPool();

export function apiRpcTransport(config: BudgetConfig, options: HttpTransportConfig = {}) {
  return http(config.ARC_RPC_URL, { ...options, batch: false, fetchFn: apiRpcFetch(config) });
}
