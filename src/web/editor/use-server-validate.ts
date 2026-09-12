import { apiFetch } from "@web/api/client";
import { useEffect, useRef, useState } from "react";

/**
 * Long enough that a sentence of typing collapses into one request, short enough that the
 * banner still feels connected to what was just typed. `POST /compose/validate` is not
 * cheap — it writes a temp file into the app's directory and shells out to
 * `docker compose config` before deleting it again — so this debounce is protecting the
 * NAS from a subprocess per keystroke, not just smoothing out the network.
 */
const DEBOUNCE_MS = 600;

type ValidateResponse = { valid: true } | { valid: false; message: string };

/**
 * `apiFetch` only guarantees valid JSON, not this shape — nothing upstream checks a 200's
 * body against `ValidateResponse` before it reaches this hook. Without this guard,
 * `{ unexpected: "shape" }` makes `response.valid` `undefined`, which is falsy, which used
 * to run the same branch as a genuine `{ valid: false }` and overwrite whatever verdict was
 * already on screen with `undefined`. A malformed body is transport-adjacent noise — the
 * server did not render a verdict, which is exactly the "we don't know" case a thrown error
 * already means here — so it must be handled identically: leave `message` untouched.
 */
function isValidateResponse(value: unknown): value is ValidateResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.valid === true) return true;
  return record.valid === false && typeof record.message === "string";
}

/**
 * Lint layer two: a debounced round trip to `docker compose config`, for the semantic
 * questions layer one (`yaml-lint.ts`, schema-only and instant) cannot answer — an
 * undefined `depends_on` target, a `.env` variable nothing sets. Unlike layer one this
 * produces one unpositioned message for a banner, never a gutter marker: resolution
 * failures have no offset into the document to point at, only an opinion about the whole
 * file.
 *
 * Every keystroke restarts the debounce timer, but a round trip already in flight can
 * still land after a newer one was sent — the classic case being a slow validation of
 * two-edits-ago answering for text that has since been fixed (or broken). `seqRef` is
 * bumped once per request actually sent (not once per keystroke) and a response is only
 * applied if it is still carrying the latest sequence; anything else is discarded
 * unread, including into `checking`, since a newer request is already the one that gets
 * to decide when the check stops running.
 *
 * A transport failure (`ApiTimeoutError`, `ApiError`, or a bare rejected `fetch` for a
 * dropped connection) is deliberately handled by *not* touching `message` at all: it
 * means the server never rendered a verdict, which is different from — and must never be
 * rendered as — "your file is wrong". Leaving the last real answer in place also means a
 * flaky connection cannot flip a known-bad state into a false "looks fine", which would
 * be the more dangerous of the two directions to get wrong. A 200 whose body does not
 * actually match `ValidateResponse` (see `isValidateResponse`) is treated exactly the
 * same way, for the same reason: it is not a verdict either.
 *
 * This hook stays a dumb debounced fetcher — it has no opinion on *when* a round trip is
 * worth sending, only on how to sequence and apply the ones it's told to send. `enabled`
 * is the caller's answer to "worth it right now": `ComposeTab` turns it off while layer
 * one already knows the document is syntactically broken, and while the text hasn't been
 * touched since it loaded, since `docker compose config` will predictably fail or is
 * redundant either way and each attempt is a real subprocess on the NAS. Turning it off
 * only stops new debounce timers from starting — a request already dispatched keeps
 * running to completion.
 *
 * That last part has one deliberate exception, guarded by `enabledRef`: `message` is
 * updated only if the check is *still* enabled at the moment a response lands. Without
 * this, an edit followed by a revert to the exact loaded text within the debounce window
 * sends a request while `enabled` is true, then flips it false (nothing left to check);
 * if that request's answer arrives after the flip, applying it would set `message` right
 * next to a caption already telling the user no check is running — two true-sounding
 * statements that contradict each other. Discarding it instead means the last verdict
 * that was actually applied *while enabled* stays on screen, which is the one still
 * relevant to `enabled`'s own caption. This is narrower than `seqRef`'s guard: `seqRef`
 * discards a superseded request's answer even while checks are still running; this
 * discards any answer, superseded or not, once nothing is checking any more.
 *
 * `settledCount` is a plain monotonic counter, not a derived read of `checking` falling
 * back to `false` — a caller that wants to know "has a round trip for the current text
 * ever finished" cannot reliably watch `checking` toggle for that, because a request that
 * resolves inside the same tick it was dispatched in (routine when the mock or the real
 * server both answer near-instantly) never renders an intermediate `true`: React 18's
 * automatic batching coalesces `setChecking(true)` and the same callback's later
 * `setChecking(false)` into one committed render, so a "was it ever true" check watching
 * for a true-then-false transition can silently never fire. A counter has no such
 * transient state to miss — it only ever moves forward, and its new value is guaranteed
 * visible in whichever render eventually reflects it, batched or not.
 */
export function useServerValidate(
  appId: string,
  text: string,
  enabled = true,
): { checking: boolean; message: string | null; settledCount: number } {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [settledCount, setSettledCount] = useState(0);

  const seqRef = useRef(0);
  // Distinct from `seqRef`: this only ever goes false once, on unmount, so a response
  // that lands after that point cannot call `setState` on a component React has already
  // torn down — regardless of whether it would otherwise have been the latest sequence.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // Read directly in render, the same way `ComposeTab`'s own `dirtyRef` tracks `dirty` —
  // no effect needed, since all that matters is what `enabled` is *at the moment* a
  // response's callback runs, not reacting to it changing.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) return;

    const timer = setTimeout(() => {
      const seq = ++seqRef.current;
      setChecking(true);

      apiFetch<unknown>(`/api/apps/${appId}/compose/validate`, {
        method: "POST",
        body: JSON.stringify({ content: text }),
      }).then(
        (response) => {
          if (!mountedRef.current || seq !== seqRef.current) return;
          setChecking(false);
          setSettledCount((count) => count + 1);
          if (!enabledRef.current) return;
          if (!isValidateResponse(response)) return;
          setMessage(response.valid ? null : response.message);
        },
        () => {
          if (!mountedRef.current || seq !== seqRef.current) return;
          setChecking(false);
          setSettledCount((count) => count + 1);
          // Deliberately no `setMessage` here. See the function docstring: a transport
          // failure reports "we don't know", never "you're wrong" or "you're fine".
        },
      );
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [appId, text, enabled]);

  return { checking, message, settledCount };
}
