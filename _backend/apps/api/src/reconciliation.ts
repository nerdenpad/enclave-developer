/** Non-overlapping recovery, drained before closing the database. */
export function startReconciliation(reconcile: () => Promise<unknown>, report: (err: unknown) => void, intervalMs = 15_000) {
  let active: Promise<void> | undefined;
  let stopped = false;
  function tick() {
    if (active || stopped) return;
    active = Promise.resolve().then(reconcile).then(() => undefined).catch(report).finally(() => { active = undefined; });
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return { async stop() { stopped = true; clearInterval(timer); await active; } };
}
