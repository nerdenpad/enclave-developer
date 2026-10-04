export function assertWalletLoginActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Sign-in cancelled", "AbortError");
}

/** Stop waiting locally even if a wallet or transport ignores cancellation. */
export function awaitWalletLogin<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      complete();
    };
    const aborted = () => finish(() => reject(signal.reason ?? new DOMException("Sign-in cancelled", "AbortError")));
    if (signal.aborted) aborted(); else signal.addEventListener("abort", aborted, { once: true });
    // Both outcomes remain observed after cancellation; a late result cannot
    // advance the login and a late rejection cannot become unhandled.
    void promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
