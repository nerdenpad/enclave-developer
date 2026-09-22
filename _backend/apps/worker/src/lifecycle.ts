import type { PollingTask } from "./polling.js";

export function createShutdown(opts: {
  worker: { close: () => Promise<void> };
  tasks: PollingTask[];
  sql: { end: (opts: { timeout: number }) => Promise<void> };
}): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= (async () => {
      const outcomes = await Promise.allSettled([
        ...opts.tasks.map((task) => task.stop()),
        opts.worker.close(),
      ]);
      await opts.sql.end({ timeout: 5 });
      const failures = outcomes.filter((outcome) => outcome.status === "rejected");
      if (failures.length > 0) {
        throw new AggregateError(failures.map((outcome) => outcome.reason), "Worker shutdown failed");
      }
    })();
    return pending;
  };
}
