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
 * be the more dangerous of the two directions to get wrong.
 */
export function useServerValidate(
  appId: string,
  text: string,
): { checking: boolean; message: string | null } {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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

  useEffect(() => {
    const timer = setTimeout(() => {
      const seq = ++seqRef.current;
      setChecking(true);

      apiFetch<ValidateResponse>(`/api/apps/${appId}/compose/validate`, {
        method: "POST",
        body: JSON.stringify({ content: text }),
      }).then(
        (response) => {
          if (!mountedRef.current || seq !== seqRef.current) return;
          setChecking(false);
          setMessage(response.valid ? null : response.message);
        },
        () => {
          if (!mountedRef.current || seq !== seqRef.current) return;
          setChecking(false);
          // Deliberately no `setMessage` here. See the function docstring: a transport
          // failure reports "we don't know", never "you're wrong" or "you're fine".
        },
      );
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [appId, text]);

  return { checking, message };
}
