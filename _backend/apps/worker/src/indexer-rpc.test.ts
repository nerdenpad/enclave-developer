import { afterEach, describe, expect, it, vi } from "vitest";
import { createIndexerRpcFetch } from "./indexer.js";

afterEach(() => { vi.useRealTimers(); });
const response = () => new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', { status: 200 });

describe("indexer RPC request budget", () => {
  it("spaces fast concurrent attempts at the configured maximum request rate", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const starts: number[] = [];
    const fetcher = vi.fn(async () => { starts.push(Date.now()); return response(); });
    const paced = createIndexerRpcFetch(5, fetcher);
    const requests = Array.from({ length: 5 }, () => paced("http://rpc.test"));
    await vi.advanceTimersByTimeAsync(799);
    expect(fetcher).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(requests);
    expect(starts).toEqual([0, 200, 400, 600, 800]);
  });
  it("does not overlap fetches when a request lasts longer than a rate interval", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let finish!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockImplementation(async () => response());
    const paced = createIndexerRpcFetch(5, fetcher);
    const first = paced("http://rpc.test"), second = paced("http://rpc.test");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledOnce();
    finish(response());
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("counts failed attempts against the budget and permits a later request", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("RPC unavailable")).mockImplementation(async () => response());
    const paced = createIndexerRpcFetch(5, fetcher);
    await expect(paced("http://rpc.test")).rejects.toThrow("RPC unavailable");
    const next = paced("http://rpc.test");
    await vi.advanceTimersByTimeAsync(199);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await next;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects a cancelled queued request promptly and never dispatches it", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let finish!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const paced = createIndexerRpcFetch(5, fetcher);
    const first = paced("http://rpc.test");
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const cancelled = paced("http://rpc.test", { signal: controller.signal });
    const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejected;
    finish(response()); await first;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("cancels a pacing timer on shutdown and passes lifetime cancellation to fetch", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const lifetime = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => response());
    const paced = createIndexerRpcFetch(5, fetcher, lifetime.signal);
    await paced("http://rpc.test");
    const waiting = paced("http://rpc.test");
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    const activeSignal = fetcher.mock.calls[0]![1]!.signal!;
    lifetime.abort(); await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    expect(activeSignal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await expect(paced("http://rpc.test")).rejects.toMatchObject({ name: "AbortError" });
  });
  it.each([0, 21, 1.5, Infinity, NaN])("rejects invalid RPC budgets before scheduling: %s", value => {
    expect(() => createIndexerRpcFetch(value, vi.fn())).toThrow("rpcMaxRps");
  });
});
