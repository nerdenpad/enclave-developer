import { afterEach, describe, expect, it, vi } from "vitest";
import { startPolling } from "./polling.js";
import { createShutdown } from "./lifecycle.js";

afterEach(() => { vi.useRealTimers(); });

describe("worker lifecycle", () => {
  it("never overlaps executions and drains the running task when stopped", async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const polling = startPolling(task, 10);
    expect(task).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(50);
    expect(task).toHaveBeenCalledOnce();
    const stopped = vi.fn();
    const stop = polling.stop().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    complete();
    await stop;
    await vi.advanceTimersByTimeAsync(50);
    expect(task).toHaveBeenCalledOnce();
    await polling.stop();
  });
  it("continues polling after a failed invocation", async () => {
    vi.useFakeTimers();
    const task = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const polling = startPolling(task, 10);
    await vi.advanceTimersByTimeAsync(20);
    expect(task).toHaveBeenCalledTimes(3);
    await polling.stop();
  });
  it.each([0, -1, Infinity, NaN])("rejects invalid polling interval %s", (interval) => {
    expect(() => startPolling(vi.fn(), interval)).toThrow("interval");
  });
  it("stops polling immediately and waits for queue and database jobs before closing SQL", async () => {
    let finishJob!: () => void;
    const inflight = new Promise<void>((resolve) => { finishJob = resolve; });
    const worker = { close: vi.fn().mockResolvedValue(undefined) };
    const task = { stop: vi.fn().mockReturnValue(inflight) };
    const sql = { end: vi.fn().mockResolvedValue(undefined) };
    const shutdown = createShutdown({ worker, tasks: [task], sql });
    const first = shutdown();
    expect(shutdown()).toBe(first);
    expect(task.stop).toHaveBeenCalledOnce();
    expect(sql.end).not.toHaveBeenCalled();
    finishJob();
    await first;
    expect(worker.close).toHaveBeenCalledOnce();
    expect(sql.end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
  });
  it("still closes SQL if a resource fails to drain and reports the failure", async () => {
    const sql = { end: vi.fn().mockResolvedValue(undefined) };
    const shutdown = createShutdown({ worker: { close: vi.fn().mockRejectedValue(new Error("redis failed")) }, tasks: [], sql });
    await expect(shutdown()).rejects.toThrow("Worker shutdown failed");
    expect(sql.end).toHaveBeenCalledOnce();
  });
});
