import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, http, parseAbi } from "viem";
import { confirmDurableTransaction, recoverSignerTransactions, sendDurableTransaction, type Database } from "@enclave/db";
import { createRpcFetchPool } from "./rpc-transport.js";

afterEach(() => vi.useRealTimers());
const config = (overrides = {}) => ({ ARC_RPC_URL: "https://rpc.test/", ARC_CHAIN_ID: 5042, ARC_RPC_MAX_RPS: 2, ...overrides });
const response = () => new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', { headers: { "Content-Type": "application/json" } });

describe("shared API RPC budget", () => {
  it("paces every attempt from distinct viem clients, including a retry, without caching their results", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => {
      starts.push(Date.now());
      if (starts.length === 1) throw new Error("temporary RPC failure");
      return response();
    });
    const pool = createRpcFetchPool(fetcher);
    const first = createPublicClient({ transport: http(config().ARC_RPC_URL, { fetchFn: pool(config()), retryCount: 1, retryDelay: 0 }), cacheTime: 0 });
    const second = createPublicClient({ transport: http(config().ARC_RPC_URL, { fetchFn: pool(config()), retryCount: 1, retryDelay: 0 }), cacheTime: 0 });
    const reads = Promise.all([first.getChainId(), second.getChainId()]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await reads).toEqual([1, 1]);
    expect(starts).toEqual([0, 500, 1000]);
    const fresh = second.getChainId();
    await vi.advanceTimersByTimeAsync(500); await fresh;
    expect(starts).toEqual([0, 500, 1000, 1500]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares canonical URL spellings and tightens an already waiting client's budget", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const starts: number[] = [];
    const pool = createRpcFetchPool(async () => { starts.push(Date.now()); return response(); });
    const fast = pool(config({ ARC_RPC_URL: "https://RPC.test:443#first", ARC_RPC_MAX_RPS: 20 }));
    await fast("https://rpc.test");
    const next = fast("https://rpc.test");
    await vi.advanceTimersByTimeAsync(25);
    expect(pool(config({ ARC_RPC_URL: "https://rpc.test/#second" }))).toBe(fast);
    await vi.advanceTimersByTimeAsync(474);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1); await next;
    expect(starts).toEqual([0, 500]);
    expect(pool(config({ ARC_RPC_MAX_RPS: 20 }))).toBe(fast);
    const third = fast("https://rpc.test");
    await vi.advanceTimersByTimeAsync(500); await third;
    expect(starts).toEqual([0, 500, 1000]);
  });

  it("shares API reads with every durable signer entry point and preserves rejection of the wrong chain", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const starts: number[] = [];
    const methods: string[] = [];
    const pool = createRpcFetchPool(async (_input, init) => {
      starts.push(Date.now()); methods.push(JSON.parse(init!.body as string).method);
      return response();
    });
    const fetchFn = pool(config());
    const transaction = vi.fn(), update = vi.fn();
    const opts = { db: { transaction, update } as unknown as Database, rpcUrl: config().ARC_RPC_URL,
      chainId: 5042, privateKey: `0x${"12".repeat(32)}` as const, fetchFn };
    const publicRpc = createPublicClient({ transport: http(opts.rpcUrl, { fetchFn }), cacheTime: 0 });
    const operations = Promise.allSettled([
      publicRpc.getChainId(), recoverSignerTransactions(opts), confirmDurableTransaction(opts, `0x${"ab".repeat(32)}`),
      sendDurableTransaction(opts, "wrong-chain", { address: "0x0000000000000000000000000000000000000100",
        abi: parseAbi(["function mint(address to,uint256 amount)"]), functionName: "mint", args: ["0x0000000000000000000000000000000000000100", 1n] }),
    ]);
    await vi.advanceTimersByTimeAsync(1500);
    const [read, ...signers] = await operations;
    expect(read).toMatchObject({ status: "fulfilled", value: 1 });
    for (const signer of signers) expect(signer).toMatchObject({ status: "rejected", reason: { message: "RPC chain ID does not match configured signer" } });
    expect(starts).toEqual([0, 500, 1000, 1500]);
    expect(methods).toEqual(Array(4).fill("eth_chainId"));
    expect(transaction).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never overlaps slow attempts on one URL, while separate endpoints remain independent", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let finish!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockImplementation(async () => response());
    const pool = createRpcFetchPool(fetcher);
    const shared = pool(config());
    const first = shared("https://rpc.test"), queued = shared("https://rpc.test");
    await pool(config({ ARC_RPC_URL: "https://other-rpc.test" }))("https://other-rpc.test");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    finish(response()); await Promise.all([first, queued]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects queue overflow and removes cancelled queued work before any dispatch", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let finish!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockImplementation(async () => response());
    const shared = createRpcFetchPool(fetcher, { maxPending: 2 })(config());
    const first = shared("https://rpc.test");
    const abort = new AbortController();
    const cancelled = shared("https://rpc.test", { signal: abort.signal });
    const rejection = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(shared("https://rpc.test")).rejects.toThrow("queue capacity exceeded");
    abort.abort(); await rejection;
    const later = shared("https://rpc.test");
    finish(response()); await first;
    await vi.advanceTimersByTimeAsync(500); await later;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the lifetime of active and queued requests and permits recovery after timeout", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    })).mockImplementation(async () => response());
    const shared = createRpcFetchPool(fetcher, { timeoutMs: 100 })(config());
    const first = shared("https://rpc.test"), queued = shared("https://rpc.test");
    const results = Promise.allSettled([first, queued]);
    await vi.advanceTimersByTimeAsync(100);
    for (const result of await results) expect(result).toMatchObject({ status: "rejected", reason: { name: "TimeoutError" } });
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(400);
    await shared("https://rpc.test");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes active cancellation to fetch and does not reserve a slot for an already cancelled request", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    })).mockImplementation(async () => response());
    const shared = createRpcFetchPool(fetcher, { maxPending: 1 })(config());
    const controller = new AbortController();
    const active = shared("https://rpc.test", { signal: controller.signal });
    const rejected = expect(active).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejected;
    await expect(shared("https://rpc.test", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(500);
    await shared("https://rpc.test");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 21, 1.5, NaN, Infinity])("rejects an invalid budget before dispatch: %s", ARC_RPC_MAX_RPS => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => createRpcFetchPool(fetcher)(config({ ARC_RPC_MAX_RPS }))).toThrow("ARC_RPC_MAX_RPS");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
