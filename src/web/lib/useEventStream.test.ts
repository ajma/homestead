import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource } from "../test-support/fake-event-source.js";
import { useEventStream } from "./useEventStream.js";

type Frame = { chunk?: string; end?: true };

const URL = "/api/operations/op-1/stream";

/**
 * Both of this app's endpoints restart a reconnected subscriber from the
 * beginning, so `replace` is what every real caller passes.
 */
const REPLAY = { onReopen: "replace" } as const;

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The one instance the hook should have constructed. */
function source(): FakeEventSource {
  const last = FakeEventSource.last;
  if (!last) throw new Error("the hook never opened an EventSource");
  return last;
}

/** Everything the fake does happens outside React's event system. */
function emit(fn: (es: FakeEventSource) => void) {
  act(() => {
    fn(source());
  });
}

describe("useEventStream", () => {
  it("accumulates parsed events", () => {
    const { result } = renderHook(() => useEventStream<Frame>(URL, REPLAY));

    expect(source().url).toBe(URL);
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "one\n" });
      es.emitMessage({ chunk: "two\n" });
    });

    expect(result.current.state).toBe("open");
    expect(result.current.items).toEqual([
      { chunk: "one\n" },
      { chunk: "two\n" },
    ]);
  });

  it("clears accumulated items when the stream reopens", () => {
    // Plan 2's registry replays its entire buffer to every new subscriber, so
    // appending after a reconnect duplicates the whole log. On a phone moving
    // between networks this is not a rare path.
    const { result } = renderHook(() => useEventStream<Frame>(URL, REPLAY));

    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "one\n" });
      es.emitMessage({ chunk: "two\n" });
    });
    expect(result.current.items).toHaveLength(2);

    emit((es) => {
      es.emitDrop();
      es.emitOpen();
      es.emitMessage({ chunk: "replayed\n" });
    });

    expect(result.current.items).toEqual([{ chunk: "replayed\n" }]);
  });

  it("keeps what it has when a reopen produces nothing at all", () => {
    // The replay only happens while the operation is still in `live`. Once it
    // has finished and been evicted — or the server restarted — `subscribe`
    // finds no entry and ends the stream immediately, with zero chunks. A
    // naive reset-on-open blanks the panel at exactly that moment, and the
    // person watching a failure loses the failure.
    const { result } = renderHook(() => useEventStream<Frame>(URL, REPLAY));

    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "ERROR: port is already allocated\n" });
    });

    emit((es) => {
      es.emitDrop();
      es.emitOpen();
      es.emitMessage({ end: true });
    });

    expect(result.current.items).toEqual([
      { chunk: "ERROR: port is already allocated\n" },
    ]);
    expect(result.current.state).toBe("closed");
  });

  it("replaces with the first frame after a reopen, however late it is", () => {
    // This used to be a one-second stopwatch, on the theory that a replay
    // shares the connection's first read. `/logs` disproves it: the route
    // writes its headers and `: connected` immediately and only then spawns
    // compose, so `onopen` fires at request accept and the whole cold start
    // sits inside any window you pick. On a NAS the first `--tail=N` line can
    // arrive well after it, and appending that duplicates N lines. The flag is
    // spent by a frame, never by a clock.
    vi.useFakeTimers();
    const { result } = renderHook(() => useEventStream<Frame>(URL, REPLAY));

    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "one\n" });
    });

    emit((es) => {
      es.emitDrop();
      es.emitOpen();
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    emit((es) => {
      es.emitMessage({ chunk: "one\n" });
      es.emitMessage({ chunk: "two\n" });
    });

    // Frame 1 replaced; frame 2 appended onto it. What is on screen is exactly
    // what the server just sent, neither doubled nor truncated.
    expect(result.current.items).toEqual([
      { chunk: "one\n" },
      { chunk: "two\n" },
    ]);
  });

  it("replaces once and then appends, however fast the frames arrive", () => {
    // The other direction, and the one a re-introduced window would break the
    // other way: only the *first* frame after a reopen is the replay's start.
    const { result } = renderHook(() => useEventStream<Frame>(URL, REPLAY));

    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "one\n" });
    });

    emit((es) => {
      es.emitDrop();
      es.emitOpen();
      es.emitMessage({ chunk: "one\n" });
      es.emitMessage({ chunk: "two\n" });
      es.emitMessage({ chunk: "three\n" });
    });

    expect(result.current.items).toEqual([
      { chunk: "one\n" },
      { chunk: "two\n" },
      { chunk: "three\n" },
    ]);
  });

  it("appends across a reopen when the consumer says append", () => {
    // A consumer whose endpoint carries on where it left off. Only the caller
    // knows which it is, which is why the policy is required rather than
    // defaulted — getting it wrong is silent in both directions.
    const { result } = renderHook(() =>
      useEventStream<Frame>(URL, { onReopen: "append" }),
    );

    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "before\n" });
    });

    emit((es) => {
      es.emitDrop();
      es.emitOpen();
      es.emitMessage({ chunk: "after\n" });
    });

    expect(result.current.items).toEqual([
      { chunk: "before\n" },
      { chunk: "after\n" },
    ]);
  });

  it("counts reopens, so a lossy reconnect can be reported", () => {
    // `/logs` has no scrollback on the server: the reconnect is handed the
    // last N lines and everything older is gone. A viewer that redraws in
    // silence has quietly destroyed the reader's history.
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => useEventStream<Frame>(url, REPLAY),
      { initialProps: { url: URL } },
    );

    emit((es) => es.emitOpen());
    expect(result.current.reopens).toBe(0);

    emit((es) => {
      es.emitDrop();
      es.emitOpen();
    });
    expect(result.current.reopens).toBe(1);

    emit((es) => {
      es.emitDrop();
      es.emitOpen();
    });
    expect(result.current.reopens).toBe(2);

    // A new url is a new stream, not a reconnect to the old one.
    rerender({ url: "/api/operations/op-2/stream" });
    emit((es) => es.emitOpen());
    expect(result.current.reopens).toBe(0);
  });

  it("ignores everything that arrives after the terminal frame", () => {
    // `close()` stops the connection; it does not cancel dispatch tasks the
    // browser has already queued, so a frame in flight when the end arrived
    // still lands. Appending it would add content to a finished log, and a
    // second terminal frame would invalidate the caller's queries twice.
    const onEnd = vi.fn();
    const { result } = renderHook(() =>
      useEventStream<Frame>(URL, { ...REPLAY, onEnd }),
    );

    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "done\n" });
      es.emitMessage({ end: true });
      es.emitMessage({ chunk: "a straggler\n" });
      es.emitMessage({ end: true });
      es.emitOpen();
      es.emitFatal();
    });

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(result.current.items).toEqual([{ chunk: "done\n" }]);
    expect(result.current.state).toBe("closed");
  });

  it("marks the stream errored without throwing", () => {
    // `readyState` CLOSED: the browser has given up and will not reconnect.
    const { result } = renderHook(() => useEventStream<Frame>(URL, REPLAY));

    emit((es) => {
      es.emitOpen();
      es.emitFatal();
    });

    expect(result.current.state).toBe("error");
  });

  it("calls a drop the browser will retry `connecting`, not an error", () => {
    // A phone changing networks is a blink. Reporting it the same way as a
    // session that expired mid-operation means a caller must either alarm the
    // user on every Wi-Fi handoff or promise a retry that will never come.
    const { result } = renderHook(() => useEventStream<Frame>(URL, REPLAY));

    emit((es) => {
      es.emitOpen();
      es.emitDrop();
    });

    expect(result.current.state).toBe("connecting");

    emit((es) => es.emitOpen());
    expect(result.current.state).toBe("open");
  });

  it("hands the terminal payload to onEnd and stops listening", () => {
    const onEnd = vi.fn();
    const { result } = renderHook(() =>
      useEventStream<Frame>(URL, { ...REPLAY, onEnd }),
    );

    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "done\n" });
      es.emitMessage({ end: true });
    });

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith({ end: true });
    expect(source().closeCount).toBe(1);
    expect(result.current.state).toBe("closed");
    // The terminal frame is not output: appending it would make the
    // zero-chunk reconnect above look like content and wipe the log.
    expect(result.current.items).toEqual([{ chunk: "done\n" }]);
  });

  it("closes the EventSource on unmount", () => {
    const { unmount } = renderHook(() => useEventStream<Frame>(URL, REPLAY));
    const es = source();
    expect(es.closeCount).toBe(0);

    unmount();

    expect(es.closeCount).toBe(1);
  });

  it("does nothing when the url is null", () => {
    const { result } = renderHook(() => useEventStream<Frame>(null, REPLAY));

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(result.current.state).toBe("idle");
    expect(result.current.items).toEqual([]);
  });

  it("abandons the old stream, and its output, when the url changes", () => {
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => useEventStream<Frame>(url, REPLAY),
      { initialProps: { url: URL } },
    );
    const first = source();
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "first operation\n" });
    });

    rerender({ url: "/api/operations/op-2/stream" });

    expect(first.closeCount).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(source().url).toBe("/api/operations/op-2/stream");
    // A different operation's output is not this one's history.
    expect(result.current.items).toEqual([]);
  });

  it("survives a frame that is not JSON", () => {
    const { result } = renderHook(() => useEventStream<Frame>(URL, REPLAY));

    emit((es) => {
      es.emitOpen();
      es.emitRaw("not json");
      es.emitMessage({ chunk: "still here\n" });
    });

    expect(result.current.items).toEqual([{ chunk: "still here\n" }]);
    expect(result.current.state).toBe("open");
  });

  it("does not open a stream where EventSource does not exist", () => {
    // Server-side rendering and jsdom both lack it; a hook that assumes it
    // takes the whole page down with a ReferenceError.
    vi.stubGlobal("EventSource", undefined);
    const { result } = renderHook(() => useEventStream<Frame>(URL, REPLAY));
    expect(result.current.state).toBe("idle");
  });
});
