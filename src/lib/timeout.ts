/**
 * Bound a promise that talks to something outside this process.
 *
 * Every external dependency (Google's tokeninfo, Apple's JWKS, FCM) is a
 * network call that can hang rather than fail. Without a cap, a stalled
 * dependency holds a request — and its database connection — until the
 * server-wide request timeout fires, which on a small instance is how one slow
 * third party turns into an outage.
 *
 * The underlying promise is not cancelled (most SDKs offer no way to); this
 * stops us *waiting* on it, which is what matters for availability.
 */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    // Don't let a pending guard keep the process alive during shutdown.
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}
