const RETRYABLE_CODES = new Set(["SQLITE_BUSY", "TRANSACTION_ACTIVE"]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 25;

function isRetryable(error: unknown): boolean {
  // By `code`, not by matching the message — the two errors this exists for are raised
  // under different messages on different backends (see scheduler.ts's `serialise`
  // comment for the measured table), and matching text is how a rewritten error message
  // silently stops being caught.
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    RETRYABLE_CODES.has(String((error as { code: unknown }).code))
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `work` a few times when libSQL rejects it with `SQLITE_BUSY` or
 * `TRANSACTION_ACTIVE` — measured when a route and the scheduler open a transaction at
 * the same moment on the one shared client. `PRAGMA busy_timeout` does not help here:
 * measured still `SQLITE_BUSY` after 106ms, because libSQL raises it immediately for an
 * overlapping transaction rather than queuing.
 *
 * Deliberately bounded (3 attempts, ~25ms growing) rather than an application-wide
 * single-writer gate every query funnels through — that would be a large change to every
 * route on the last commit before a merge, and after fixing the scheduler's own silent
 * failure path a lost write here is reported and retried on the next tick regardless.
 * This closes the narrow, measured gap at the two places a route and the scheduler
 * actually open a transaction against each other: `persistResult` and probe adoption.
 */
export async function retryOnBusy<T>(work: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await work();
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
      await delay(BASE_DELAY_MS * attempt);
    }
  }
}
