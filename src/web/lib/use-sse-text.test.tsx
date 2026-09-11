// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { MAX_RETAINED_CHARS, useSseText } from "@web/lib/use-sse-text";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no EventSource. This double mirrors the one in
// `src/web/live/useEventStream.test.tsx`: it records every instance so a test can both
// dispatch events into the hook and assert the connection was actually closed.
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn),
    );
  }
  close() {
    this.closed = true;
  }
  // `data` is omitted for a native connection error, which carries none.
  emit(type: string, data?: unknown) {
    const init = data === undefined ? {} : { data: JSON.stringify(data) };
    for (const fn of this.listeners.get(type) ?? []) {
      fn(new MessageEvent(type, init));
    }
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("useSseText", () => {
  it("opens nothing while the url is null", () => {
    renderHook(() => useSseText(null));
    expect(FakeEventSource.instances.length).toBe(0);
  });

  it("accumulates line events in order", () => {
    const { result } = renderHook(() => useSseText("/api/apps/a1/containers/c1/logs"));
    act(() => {
      FakeEventSource.instances[0]?.emit("line", { text: "first\n", stream: "stdout" });
      FakeEventSource.instances[0]?.emit("line", { text: "second\n", stream: "stdout" });
    });
    expect(result.current.text).toBe("first\nsecond\n");
    expect(result.current.done).toBe(false);
  });

  it("also accumulates job-style output events, staying agnostic to log semantics", () => {
    // Task 10 reuses this hook for `/api/jobs/:jobId/stream`, whose event is named
    // `output` rather than `line`. Both carry the same `{ text, stream }` shape.
    const { result } = renderHook(() => useSseText("/api/jobs/j1/stream"));
    act(() => {
      FakeEventSource.instances[0]?.emit("output", { text: "pulling image", stream: "stdout" });
    });
    expect(result.current.text).toBe("pulling image");
  });

  it("sets done on the terminal done event", () => {
    const { result } = renderHook(() => useSseText("/api/apps/a1/containers/c1/logs"));
    act(() => {
      FakeEventSource.instances[0]?.emit("done", {});
    });
    expect(result.current.done).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("marks the stream finished on an error event too, with the server's message", () => {
    // The exact bug the 1B-ii carry-forward records: a client that tears down only on
    // `done` hangs forever when the stream instead ends with only `error`.
    const { result } = renderHook(() => useSseText("/api/apps/a1/containers/c1/logs"));
    act(() => {
      FakeEventSource.instances[0]?.emit("error", {
        code: "stream_failed",
        message: "The stream ended unexpectedly.",
      });
    });
    expect(result.current.done).toBe(true);
    expect(result.current.error).toBe("The stream ended unexpectedly.");
  });

  it("still finishes on a native connection error, which carries no data at all", () => {
    const { result } = renderHook(() => useSseText("/api/apps/a1/containers/c1/logs"));
    act(() => {
      FakeEventSource.instances[0]?.emit("error");
    });
    expect(result.current.done).toBe(true);
    expect(result.current.error).toBeTruthy();
  });

  it("closes the stream when the component unmounts", () => {
    // Navigating away from the tab must end the upstream Docker stream. The server
    // aborts on disconnect, but only if the client actually disconnects.
    const { unmount } = renderHook(() => useSseText("/api/apps/a1/containers/c1/logs"));
    unmount();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });

  it("opens a new connection and closes the old one when the url changes", () => {
    const { rerender } = renderHook(({ url }) => useSseText(url), {
      initialProps: { url: "/api/apps/a1/containers/c1/logs" as string | null },
    });
    expect(FakeEventSource.instances.length).toBe(1);

    rerender({ url: "/api/apps/a1/containers/c2/logs" });

    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    expect(FakeEventSource.instances[1]?.closed).toBe(false);
  });

  it("closes and opens nothing new when the url goes from a value to null", () => {
    const { rerender } = renderHook(({ url }) => useSseText(url), {
      initialProps: { url: "/api/apps/a1/containers/c1/logs" as string | null },
    });
    rerender({ url: null });
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });

  it("caps retained text at a fixed length, dropping from the front", () => {
    const { result } = renderHook(() => useSseText("/api/apps/a1/containers/c1/logs"));
    act(() => {
      FakeEventSource.instances[0]?.emit("line", {
        text: `MARKER${"a".repeat(MAX_RETAINED_CHARS)}`,
        stream: "stdout",
      });
      FakeEventSource.instances[0]?.emit("line", { text: "b".repeat(500), stream: "stdout" });
    });
    expect(result.current.text.length).toBe(MAX_RETAINED_CHARS);
    // The tail survives; the front — including the marker at the very start — is what
    // gets dropped.
    expect(result.current.text.endsWith("b".repeat(500))).toBe(true);
    expect(result.current.text.includes("MARKER")).toBe(false);
  });

  it("reset clears accumulated text, done and error without closing the stream", () => {
    const { result } = renderHook(() => useSseText("/api/apps/a1/containers/c1/logs"));
    act(() => {
      FakeEventSource.instances[0]?.emit("line", { text: "hi", stream: "stdout" });
      FakeEventSource.instances[0]?.emit("done", {});
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.text).toBe("");
    expect(result.current.done).toBe(false);
    expect(result.current.error).toBeNull();
    expect(FakeEventSource.instances[0]?.closed).toBe(false);
  });
});
