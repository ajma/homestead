import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Cap on retained text, in characters, dropping from the front once exceeded. A
 * `--follow` log stream (or a long-running job's output) never stops on its own — with
 * no ceiling, an idle tab left open overnight would grow this buffer without bound. This
 * keeps the newest ~200KB, which is far more than a screen will ever show, while giving
 * the buffer a fixed worst case instead of none.
 */
export const MAX_RETAINED_CHARS = 200_000;

/**
 * Event names that carry a chunk of streamed text. `logs.ts` names its event `line`;
 * `jobs.ts` names its `output`. Both send the same `{ text, stream }` shape (see
 * `LogLine` in `src/server/host/types.ts`) — the difference is only what produced the
 * text, which this hook has no reason to care about. Listening for both, rather than
 * hard-coding one, is what lets Task 10 reuse this hook for job output unmodified.
 */
const TEXT_EVENTS = ["line", "output"] as const;

const FALLBACK_ERROR_MESSAGE = "The stream ended unexpectedly.";

export type UseSseText = {
  text: string;
  done: boolean;
  error: string | null;
  reset: () => void;
};

function textFrom(raw: string): string {
  try {
    const payload = JSON.parse(raw) as unknown;
    if (typeof payload === "string") return payload;
    const text = (payload as { text?: unknown } | null)?.text;
    return typeof text === "string" ? text : "";
  } catch {
    // Not JSON — treat the raw frame itself as the text rather than dropping it.
    return raw;
  }
}

function messageFrom(raw: unknown): string {
  if (typeof raw !== "string") return FALLBACK_ERROR_MESSAGE;
  try {
    const payload = JSON.parse(raw) as { message?: unknown };
    return typeof payload.message === "string" ? payload.message : FALLBACK_ERROR_MESSAGE;
  } catch {
    return FALLBACK_ERROR_MESSAGE;
  }
}

/**
 * Reads a route-scoped SSE stream of text — a container's logs today, a job's output in
 * Task 10 — as one accumulated string.
 *
 * Opens nothing while `url` is `null`. Opens a new `EventSource` whenever `url` changes
 * and closes whatever was open before, including on unmount — the one obligation this
 * hook cannot skip. `src/server/routes/logs.ts` only aborts its upstream Docker stream
 * once the client actually disconnects; on an idle container the route never notices a
 * disconnect any other way; a hook that forgot to call `close()` here would leave that
 * Docker socket open for the life of the server process. The 1B-ii carry-forward is the
 * record of that defect surviving three reviews before an idle-container integration
 * test caught it.
 *
 * The accumulated text lives in a ref, not in state: a busy `docker compose up` can
 * emit hundreds of frames a second, and re-deriving a growing string with
 * `setState(prev => prev + chunk)` on every one of them is the kind of thing that drops
 * frames or wedges the tab. Appends land on the ref; a cheap integer counter in state is
 * what actually triggers the re-render, and the render reads the ref directly.
 *
 * A terminal `error` event finishes the stream exactly like `done` does. Both SSE routes
 * in this codebase send exactly one terminal event, and `error` is one of the two — a
 * client that tears down (stops spinning, enables a "reconnect" control) only on `done`
 * hangs forever on a stream that instead ends with `error`, which is also what a native
 * EventSource connection failure reports as, carrying no application data at all.
 */
export function useSseText(url: string | null): UseSseText {
  const bufferRef = useRef("");
  const [, forceRender] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    bufferRef.current = "";
    setDone(false);
    setError(null);
    forceRender((n) => n + 1);
  }, []);

  useEffect(() => {
    bufferRef.current = "";
    setDone(false);
    setError(null);
    forceRender((n) => n + 1);

    if (url === null) return;

    const source = new EventSource(url);

    const onText = (event: MessageEvent) => {
      const chunk = textFrom(event.data as string);
      const next = bufferRef.current + chunk;
      bufferRef.current =
        next.length > MAX_RETAINED_CHARS ? next.slice(next.length - MAX_RETAINED_CHARS) : next;
      forceRender((n) => n + 1);
    };

    // Both `done` and `error` are terminal: `logs.ts` and `jobs.ts` each send at most one
    // of them, immediately followed by ending the response. A native `EventSource` has no
    // way to know that — a server-ended response looks exactly like a dropped connection,
    // which the spec says to retry after ~3s. Calling `close()` here, not just in the
    // effect's cleanup, is what tells it there is nothing to retry. Without this, the
    // stream reconnects every ~3s forever: the pane re-appends the same tail, and the NAS
    // re-pays a project-name resolve, a `listContainers` and a `container.logs()` on every
    // cycle. `JobOutput` used to escape this by accident, because `handleJobDone` unmounts
    // it the moment `done` arrives — that is not a substitute for closing here, since the
    // same stream loops identically on `follow=true` whenever the server ends the response
    // for any other reason (a deploy recreating the container, most commonly).
    const onDone = () => {
      setDone(true);
      source.close();
    };

    const onError = (event: MessageEvent) => {
      setError(messageFrom(event.data));
      setDone(true);
      source.close();
    };

    for (const type of TEXT_EVENTS) source.addEventListener(type, onText);
    source.addEventListener("done", onDone);
    source.addEventListener("error", onError);

    return () => {
      for (const type of TEXT_EVENTS) source.removeEventListener(type, onText);
      source.removeEventListener("done", onDone);
      source.removeEventListener("error", onError);
      source.close();
    };
  }, [url]);

  return { text: bufferRef.current, done, error, reset };
}
