export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API request failed with ${status}`);
    this.name = "ApiError";
  }
}

/**
 * Thrown when a request is abandoned by `apiFetch`'s own timeout rather than by the
 * caller's signal, a non-2xx response, or a network failure. Kept distinguishable from
 * `ApiError` (which always carries a real HTTP response) so a caller can render "the
 * server did not respond" instead of a generic failure — most usefully in
 * `ConfirmDialog`, which now stays open and un-dismissable while `onConfirm` is pending
 * and needs something concrete to show if that promise never settles on its own.
 */
export class ApiTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`API request timed out after ${timeoutMs}ms`);
    this.name = "ApiTimeoutError";
  }
}

/**
 * Every request in the web app goes through `apiFetch`, and before this there was no
 * timeout anywhere in it — a request that never settles hung whatever awaited it
 * forever. That was survivable until `ConfirmDialog` started disabling its own dismissal
 * paths while a request is pending: combined with an unbounded `apiFetch`, a hung
 * request left a confirmation dialog with no way out short of reloading the page.
 *
 * 30s is generous for a NAS on a LAN — `POST /api/apps/:id/actions/:kind` (the slowest
 * common case, a lifecycle action) returns as soon as the job is queued, not when
 * `docker compose up` finishes — and short enough that a person has not yet given up.
 * A caller with a genuinely longer operation passes `timeoutMs` to override it; see
 * `ImageUpdates.tsx` for the one that needs to.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export async function apiFetch<T = unknown>(
  url: string,
  init?: RequestInit,
  options?: { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // A plain `AbortController` driven by `setTimeout`, not `AbortSignal.timeout()`: the
  // latter is implemented as a platform timer that fake timers in tests cannot advance,
  // which would make a test that "waits out" the timeout hang for real instead of
  // asserting anything.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Composed with, never overriding, a caller-supplied signal: `AbortSignal.any` aborts
  // as soon as either one does. A caller that needs to cancel its own request
  // (navigating away, an unmounted component) must keep that ability regardless of this
  // timeout.
  const signal = init?.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: "include",
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      signal,
    });
  } catch (error) {
    // `timedOut` is set only by this function's own timer, so it is true only when the
    // timeout — not the caller's own signal, and not an unrelated network failure — is
    // what ended the request.
    if (timedOut) throw new ApiTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 204) return null as T;

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}
