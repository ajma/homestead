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
 * `transportError` is what lets a caller tell a real "we don't know" apart from silence:
 * it goes true whenever a round trip settles without producing a verdict at all (a
 * rejected `fetch`, or a 200 that doesn't match `ValidateResponse`), and false again as
 * soon as a later round trip starts or produces a real verdict. `message` deliberately
 * does not carry this — see the docstring above on why it must never be touched by a
 * transport failure — so without this field a caller has no way to know the red or green
 * banner it is showing is left over from a request that never got an answer at all
 * (a dropped connection, or a 429 from a rate limiter) rather than the current text's
 * real verdict. The final review's own words for what happens without it: "a verdict the
 * user cannot date is worse than no verdict."
 *
 * `inFlightRef` is a separate gate from `seqRef`, on the opposite side of the same
 * problem: `seqRef` decides which *response* wins once several have been sent; this
 * decides whether a debounce tick gets to send one at all. Without it, a debounce that
 * keeps re-arming every `DEBOUNCE_MS` against a server slower than that (measured:
 * `docker compose config` on a loaded NAS taking 2.5s) starts a new spawn — a temp file
 * written into the app's own directory, a subprocess, then a delete — every time it
 * fires, with nothing capping how many run at once; ten seconds of realistic typing
 * measured 14 requests with 4 concurrent spawns. A tick that finds one already running
 * does not queue or coalesce anything of its own; it just declines to start a second
 * one. What makes that safe rather than lossy: the in-flight request's own settle
 * handler re-checks `textRef.current` (the freshest text, not the one it was dispatched
 * for) once it lands, and immediately starts exactly one more check if they differ —
 * "validate once more when it returns if the content has changed since," not "start a
 * fresh debounce window and wait `DEBOUNCE_MS` again." A user who keeps typing during a
 * slow round trip still gets an answer for what's actually on screen once the outstanding
 * one finishes, without a second spawn racing the first.
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
): {
  checking: boolean;
  message: string | null;
  settledCount: number;
  transportError: boolean;
} {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [settledCount, setSettledCount] = useState(0);
  const [transportError, setTransportError] = useState(false);

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

  // Always the freshest values, read by `attemptCheck` — which a settle handler can
  // invoke well after the render (and the effect) that originally scheduled it, when a
  // dependency-array closure over `appId`/`text` would be stale.
  const appIdRef = useRef(appId);
  appIdRef.current = appId;
  const textRef = useRef(text);
  textRef.current = text;

  // See the function docstring. Set for the duration of exactly one round trip; a
  // debounce tick that finds this `true` declines to send a second request rather than
  // queuing anything.
  const inFlightRef = useRef(false);

  // A stable identity both the debounce timer below and a settle handler can call. It
  // takes its own arguments (rather than reading `appIdRef`/`textRef` for the values to
  // dispatch *with*) so the effect below still visibly uses `appId`/`text` — the two
  // reasons it has to re-run at all, since restarting the debounce timer on every
  // keystroke is the entire point. The refs are only for the one caller that genuinely
  // cannot use a closure: the follow-up check a settle handler fires for text that has
  // moved on since *this* call was scheduled.
  const attemptCheckRef = useRef<(dispatchFor: string, forApp: string) => void>(() => {});
  attemptCheckRef.current = (dispatchFor, forApp) => {
    if (inFlightRef.current) return;

    const seq = ++seqRef.current;
    inFlightRef.current = true;
    setChecking(true);
    // A fresh attempt gets a clean slate: whatever failed before is no longer the most
    // recent thing that happened, and "checking" is already the right thing to show
    // while this one is in flight.
    setTransportError(false);

    function settled() {
      inFlightRef.current = false;
      // The one thing a debounce tick that arrived while this was running could not do
      // for itself: if the text has since moved on, this is the "validate once more"
      // half of the fix, firing immediately rather than waiting out another full
      // `DEBOUNCE_MS` for a tick that never comes if the user has stopped typing.
      if (mountedRef.current && enabledRef.current && textRef.current !== dispatchFor) {
        attemptCheckRef.current(textRef.current, appIdRef.current);
      }
    }

    apiFetch<unknown>(`/api/apps/${forApp}/compose/validate`, {
      method: "POST",
      body: JSON.stringify({ content: dispatchFor }),
    }).then(
      (response) => {
        if (mountedRef.current && seq === seqRef.current) {
          setChecking(false);
          setSettledCount((count) => count + 1);
          if (enabledRef.current) {
            if (!isValidateResponse(response)) {
              setTransportError(true);
            } else {
              setMessage(response.valid ? null : response.message);
            }
          }
        }
        settled();
      },
      () => {
        if (mountedRef.current && seq === seqRef.current) {
          setChecking(false);
          setSettledCount((count) => count + 1);
          // Deliberately no `setMessage` here. See the function docstring: a transport
          // failure reports "we don't know", never "you're wrong" or "you're fine".
          if (enabledRef.current) setTransportError(true);
        }
        settled();
      },
    );
  };

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => attemptCheckRef.current(text, appId), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [appId, text, enabled]);

  return { checking, message, settledCount, transportError };
}
