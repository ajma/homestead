import { useEffect, useRef, useState } from "react";

/**
 * `idle` — no url, or no `EventSource` in this environment.
 * `connecting` — opening, or dropped and the browser is retrying by itself.
 * `open` — connected.
 * `closed` — the server said it was finished and we hung up.
 * `error` — the browser has given up and will not reconnect.
 *
 * `connecting` and `error` are separate because the difference is the whole
 * message. A Wi-Fi handoff is a blink the user should barely notice; a session
 * that expired mid-operation ends the stream for good, and telling that user
 * "retrying" is a promise nothing is going to keep.
 */
export type EventStreamState =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

export type EventStream<T> = { items: T[]; state: EventStreamState };

/**
 * `EventSource.CLOSED`, read as a literal.
 *
 * Not off the constructor: a stub installed by a caller need not carry the
 * statics, and the value is fixed by the spec.
 */
const CLOSED = 2;

/**
 * How long after `open` a frame may still be part of the server's replay.
 *
 * A replay is written synchronously as the subscription is accepted, so it
 * shares the connection's first read; a second is three orders of magnitude
 * more room than that needs. Past it, what arrives is live output and is
 * appended. See {@link useEventStream} for why the arm must expire at all.
 */
export const REPLAY_WINDOW_MS = 1_000;

/** The server's terminal frame, whatever else `T` carries. */
function isEnd(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { end?: unknown }).end === true
  );
}

/**
 * Reads one `text/event-stream` endpoint into an array of parsed frames.
 *
 * **Reconnects, and the replay behind them.** `EventSource` reconnects by
 * itself, and Plan 2's operation registry replays its entire buffer to every
 * new subscriber. Appending on reconnect therefore duplicates the whole log —
 * a phone changing networks mid-`pull` would show every line twice. So a
 * reopen is treated as "the server is about to tell me everything again", and
 * the frames it sends replace what came before rather than adding to it.
 *
 * **But the replay is not guaranteed.** It only happens while the operation is
 * still in the registry's `live` map. Once it has finished and been evicted —
 * or the server has restarted — `subscribe` finds no entry and ends the stream
 * immediately, with zero chunks. A reset performed eagerly on `open` blanks
 * the panel at exactly that moment, so the person who reconnected to read why
 * their stack failed is left with an empty log and a terminal status.
 *
 * The reset is therefore *armed* on open and *applied* by the first frame that
 * actually has something to put in its place. A reconnect that produces
 * nothing changes nothing.
 *
 * **And the arm expires.** Whether a reconnect replays at all is the server's
 * business, and it is about to differ per endpoint: a log stream has no buffer
 * to replay and can sit silent for minutes before its first line. An arm held
 * open until "the next frame with content, whenever that is" would let that
 * line delete everything before it — an invariant borrowed from one endpoint
 * that no other endpoint owes us. So the arm is bounded by
 * {@link REPLAY_WINDOW_MS} as well as consumed by content: replace what
 * arrives with the connection, append what arrives after it.
 */
export function useEventStream<T>(
  url: string | null,
  opts: { onEnd?: (payload: T) => void } = {},
): EventStream<T> {
  const [items, setItems] = useState<T[]>([]);
  const [state, setState] = useState<EventStreamState>("idle");

  // Through a ref so a caller may pass an inline closure: putting `onEnd` in
  // the dependency list would tear down and reopen the stream — and re-trigger
  // the server's whole replay — on every render of the component above.
  const onEndRef = useRef(opts.onEnd);
  onEndRef.current = opts.onEnd;

  useEffect(() => {
    if (url === null) {
      setState("idle");
      return;
    }
    // Looked up at open time, not imported: jsdom has no `EventSource`, and a
    // hook that assumes one takes the page down with a ReferenceError.
    const Source = globalThis.EventSource;
    if (!Source) {
      setState("idle");
      return;
    }

    // A different url is a different stream; its predecessor's output is not
    // this one's history. Unlike a reconnect, nothing will replay it.
    setItems([]);
    setState("connecting");

    const source = new Source(url);
    /**
     * Set by the terminal frame, and never unset.
     *
     * `close()` stops the connection; it does not cancel dispatch tasks the
     * browser has already queued. Without this, a frame that was in flight
     * when the end arrived appends to a finished log, and a duplicated
     * terminal frame calls `onEnd` — and so invalidates the caller's queries —
     * twice.
     */
    let done = false;
    let armed = false;
    let disarm: ReturnType<typeof setTimeout> | undefined;

    /** Stops treating what arrives as the server's replay. */
    const disarmNow = () => {
      armed = false;
      clearTimeout(disarm);
      disarm = undefined;
    };

    source.onopen = () => {
      if (done) return;
      setState("open");
      armed = true;
      clearTimeout(disarm);
      disarm = setTimeout(disarmNow, REPLAY_WINDOW_MS);
    };

    source.onmessage = (event: MessageEvent<string>) => {
      if (done) return;
      let payload: T;
      try {
        payload = JSON.parse(event.data) as T;
      } catch {
        // One malformed frame is not worth discarding a live operation's
        // output over.
        return;
      }
      if (isEnd(payload)) {
        done = true;
        disarmNow();
        setState("closed");
        source.close();
        onEndRef.current?.(payload);
        return;
      }
      const replaces = armed;
      disarmNow();
      setItems((prev) => (replaces ? [payload] : [...prev, payload]));
    };

    source.onerror = () => {
      if (done) return;
      // `CLOSED` is the browser saying it has given up — an expired session
      // answering 401, a 403, a refused origin. It will not try again, and a
      // caller told "retrying" would show a spinner that can never stop.
      setState(source.readyState === CLOSED ? "error" : "connecting");
    };

    return () => {
      disarmNow();
      source.onopen = null;
      source.onmessage = null;
      source.onerror = null;
      source.close();
    };
  }, [url]);

  return { items, state };
}
