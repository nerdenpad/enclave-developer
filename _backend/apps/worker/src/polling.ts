export type PollingTask = { stop: () => Promise<void> };

/** One invocation at a time; stopping drains the current invocation before DB shutdown. */
export function startPolling(task: () => Promise<void>, intervalMs: number): PollingTask {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("Polling interval must be positive");
  }
  let stopped = false;
  let active: Promise<void> | undefined;
  const tick = () => {
    if (stopped || active) return;
    active = task().finally(() => { active = undefined; });
    // Task boundaries log failures; still consume rejections if a logger itself fails.
    void active.catch(() => undefined);
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
