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

/**
 * What the first frame after a **reopen** means, which only the consumer knows.
 *
 * - `replace` — the server starts a reconnected subscriber from the beginning:
 *   Plan 2's operation registry replays its whole buffer, and `/logs` re-issues
 *   `--tail=N`. Appending that duplicates everything already on screen, so the
 *   first frame after the reopen replaces what is there and frames 2..N append
 *   onto it, reconstructing exactly what the server just sent.
 * - `append` — the reconnected stream carries on from where it left off, and
 *   nothing already on screen is about to be repeated.
 *
 * It is a required option rather than a default because getting it wrong is
 * silent in both directions — a doubled log, or a deleted one — and the hook
 * cannot tell which endpoint it is pointed at.
 */
export type ReopenPolicy = "replace" | "append";

export type EventStream<T> = {
  items: T[];
  state: EventStreamState;
  /**
   * How many times the browser has re-established this connection since the
   * url last changed.
   *
   * Exposed because for some endpoints a reconnect is lossy and the user has
   * to be told. `/logs` has no scrollback on the server: the reconnect is
   * handed the last N lines and everything older is simply gone, so a viewer
   * that redraws in silence has quietly destroyed the reader's history.
   */
  reopens: number;
};

/**
 * `EventSource.CLOSED`, read as a literal.
 *
 * Not off the constructor: a stub installed by a caller need not carry the
 * statics, and the value is fixed by the spec.
 */
const CLOSED = 2;

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
 * itself, and both of this app's stream endpoints restart a reconnected
 * subscriber from the beginning — the operation registry replays its buffer,
 * `/logs` re-issues `--tail=N`. Appending on reconnect therefore duplicates
 * everything on screen: a phone changing networks mid-`pull` would show every
 * line twice. So a reopen sets a flag, and the first frame that follows it
 * *replaces* rather than appends. Frames 2..N append onto that one, so what
 * ends up on screen is exactly what the server just sent.
 *
 * **The flag is consumed by a frame, never by a clock.** This was a one-second
 * stopwatch, on the theory that a replay is written synchronously as the
 * subscription is accepted and so shares the connection's first read. It is
 * not true of `/logs`: the route writes its headers and `: connected`
 * immediately and only then spawns compose, so `onopen` fires at request
 * accept and the whole compose cold start sits inside any window you pick.
 * Both directions then fail on timing alone — a fast reconnect deletes a
 * reader's scrollback, a slow one on a NAS appends the entire `--tail=N` twice
 * — and no window is right for both. The consumer states the policy instead.
 *
 * **A reopen that produces nothing changes nothing.** The flag is only spent
 * by a content frame. The operation registry replays only while the operation
 * is still in its `live` map; once it has finished and been evicted, or the
 * server has restarted, `subscribe` finds no entry and ends the stream
 * immediately with zero chunks. Resetting eagerly on `open` would blank the
 * panel at exactly that moment, leaving the person who reconnected to read why
 * their stack failed with an empty log and a terminal status.
 */
export function useEventStream<T>(
  url: string | null,
  opts: { onReopen: ReopenPolicy; onEnd?: (payload: T) => void },
): EventStream<T> {
  const [items, setItems] = useState<T[]>([]);
  const [state, setState] = useState<EventStreamState>("idle");
  const [reopens, setReopens] = useState(0);

  // Through refs so a caller may pass an inline closure: putting these in the
  // dependency list would tear down and reopen the stream — and re-trigger the
  // server's whole replay — on every render of the component above.
  const onEndRef = useRef(opts.onEnd);
  onEndRef.current = opts.onEnd;
  const policyRef = useRef(opts.onReopen);
  policyRef.current = opts.onReopen;

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
    setReopens(0);

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
    /** False until the browser has opened this connection once. */
    let opened = false;
    /** The next content frame replaces what is on screen. */
    let replaceNext = false;

    source.onopen = () => {
      if (done) return;
      setState("open");
      // The first `open` is not a reopen: there is nothing on screen for a
      // replay to duplicate, and nothing has been lost.
      if (opened) {
        replaceNext = policyRef.current === "replace";
        setReopens((n) => n + 1);
      }
      opened = true;
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
        setState("closed");
        source.close();
        onEndRef.current?.(payload);
        return;
      }
      const replaces = replaceNext;
      replaceNext = false;
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
      source.onopen = null;
      source.onmessage = null;
      source.onerror = null;
      source.close();
    };
  }, [url]);

  return { items, state, reopens };
}
