import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource } from "../test-support/fake-event-source.js";
import { useEventStream } from "./useEventStream.js";

type Frame = { chunk?: string; end?: true };

const URL = "/api/operations/op-1/stream";

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
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
    const { result } = renderHook(() => useEventStream<Frame>(URL));

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
    const { result } = renderHook(() => useEventStream<Frame>(URL));

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
    const { result } = renderHook(() => useEventStream<Frame>(URL));

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

  it("marks the stream errored without throwing", () => {
    // `readyState` CLOSED: the browser has given up and will not reconnect.
    const { result } = renderHook(() => useEventStream<Frame>(URL));

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
    const { result } = renderHook(() => useEventStream<Frame>(URL));

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
    const { result } = renderHook(() => useEventStream<Frame>(URL, { onEnd }));

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
    const { unmount } = renderHook(() => useEventStream<Frame>(URL));
    const es = source();
    expect(es.closeCount).toBe(0);

    unmount();

    expect(es.closeCount).toBe(1);
  });

  it("does nothing when the url is null", () => {
    const { result } = renderHook(() => useEventStream<Frame>(null));

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(result.current.state).toBe("idle");
    expect(result.current.items).toEqual([]);
  });

  it("abandons the old stream, and its output, when the url changes", () => {
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => useEventStream<Frame>(url),
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
    const { result } = renderHook(() => useEventStream<Frame>(URL));

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
    const { result } = renderHook(() => useEventStream<Frame>(URL));
    expect(result.current.state).toBe("idle");
  });
});
