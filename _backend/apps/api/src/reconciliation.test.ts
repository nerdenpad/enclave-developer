import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startReconciliation } from "./reconciliation.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("payment reconciliation lifecycle", () => {
  it("runs on startup, repeats periodically and stops scheduling after shutdown", async () => {
    const recover = vi.fn().mockResolvedValue(1);
    const report = vi.fn();
    const task = startReconciliation(recover, report, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(recover).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(recover).toHaveBeenCalledTimes(3);
    await task.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(report).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overlap a slow reconciliation and drains it before shutdown resolves", async () => {
    let finish!: () => void;
    const recover = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const task = startReconciliation(recover, vi.fn(), 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(recover).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = task.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a failure once and recovers on the next interval", async () => {
    const failure = new Error("temporary RPC failure");
    const recover = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(1);
    const report = vi.fn();
    const task = startReconciliation(recover, report, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    await vi.advanceTimersByTimeAsync(1000);
    expect(recover).toHaveBeenCalledTimes(2);
    await task.stop();
  });
});
