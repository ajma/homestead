// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useServerValidate } from "@web/editor/use-server-validate";
import { afterEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Count of active `Timeout` handles right now, per `process.getActiveResourcesInfo()`.
 * `process._getActiveHandles()` does not track timers on this Node version, so a test
 * watching it would pass against any implementation, including one that never clears
 * anything — see `use-now.test.tsx` for the same guard applied to a different hook.
 */
function timeoutCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

function bodyOf(call: unknown[]): unknown {
  const init = call[1] as RequestInit | undefined;
  return JSON.parse(init?.body as string);
}

function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

describe("useServerValidate", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not call the server before the debounce elapses", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async () => jsonResponse({ valid: true }));
    vi.stubGlobal("fetch", fetchSpy);

    const { result, unmount } = renderHook(() =>
      useServerValidate("app1", "services:\n  web:\n    image: nginx\n"),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(599);
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.checking).toBe(false);
    unmount();
  });

  it("fires once for a burst of edits, not once per keystroke", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async () => jsonResponse({ valid: true }));
    vi.stubGlobal("fetch", fetchSpy);

    const { rerender, unmount } = renderHook(({ text }) => useServerValidate("app1", text), {
      initialProps: { text: "services:\n  web:\n    image: n\n" },
    });

    // Four more "keystrokes", each well inside the 600ms window of the one before it.
    // A naive per-keystroke implementation would send a request for every one of these.
    for (const text of [
      "services:\n  web:\n    image: ng\n",
      "services:\n  web:\n    image: ngi\n",
      "services:\n  web:\n    image: ngin\n",
      "services:\n  web:\n    image: nginx\n",
    ]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      rerender({ text });
    }

    expect(fetchSpy).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = must(fetchSpy.mock.calls[0], "fetch was not called");
    expect(bodyOf(firstCall)).toEqual({
      content: "services:\n  web:\n    image: nginx\n",
    });
    unmount();
  });

  it("ignores a stale error that arrives after a newer request already reported success", async () => {
    // Each keystroke restarts the debounce, but a slow round trip can still land after
    // the next one has been sent. Showing its verdict means the user sees an error about
    // text they already fixed.
    vi.useFakeTimers();
    const resolvers: Array<(response: Response) => void> = [];
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { result, rerender, unmount } = renderHook(
      ({ text }) => useServerValidate("app1", text),
      { initialProps: { text: "services:\n  web:\n    depends_on: [databse]\n" } },
    );

    // First (broken) request goes out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The user fixes the typo before the first request answers; a second, newer request
    // goes out for the corrected text.
    rerender({ text: "services:\n  web:\n    depends_on: [database]\n" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const resolveOlder = must(resolvers[0], "the first request never resolved");
    const resolveNewer = must(resolvers[1], "the second request never resolved");

    // The newer request answers first: the fixed text is valid.
    await act(async () => {
      resolveNewer(jsonResponse({ valid: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.message).toBeNull();
    expect(result.current.checking).toBe(false);

    // The older, slower request now answers, reporting the typo error for text that is
    // no longer on screen. It must be discarded rather than clobbering the newer verdict.
    await act(async () => {
      resolveOlder(
        jsonResponse({
          valid: false,
          message: 'service "web" depends on undefined service "databse"',
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.message).toBeNull();
    unmount();
  });

  it("ignores a stale success that arrives after a newer request already reported an error", async () => {
    // The more dangerous direction of the same bug: a stale *success* must not clear a
    // real, current error off the screen.
    vi.useFakeTimers();
    const resolvers: Array<(response: Response) => void> = [];
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { result, rerender, unmount } = renderHook(
      ({ text }) => useServerValidate("app1", text),
      { initialProps: { text: "services:\n  web:\n    image: nginx\n" } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    rerender({ text: "services:\n  web:\n    depends_on: [ghost]\n" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const resolveOlder = must(resolvers[0], "the first request never resolved");
    const resolveNewer = must(resolvers[1], "the second request never resolved");

    // The newer request answers first, reporting the real, current error.
    await act(async () => {
      resolveNewer(
        jsonResponse({
          valid: false,
          message: 'service "web" depends on undefined service "ghost"',
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.message).toBe('service "web" depends on undefined service "ghost"');

    // The older request now answers, saying the earlier (now-superseded) text was fine.
    // It must not clear the error that is still accurate for what's on screen now.
    await act(async () => {
      resolveOlder(jsonResponse({ valid: true }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.message).toBe('service "web" depends on undefined service "ghost"');
    unmount();
  });

  it("reports the server's validation message", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          valid: false,
          message: 'service "web" depends on undefined service "db"',
        }),
      ),
    );

    const { result, unmount } = renderHook(() =>
      useServerValidate("app1", "services:\n  web:\n    depends_on: [db]\n"),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(result.current.message).toBe('service "web" depends on undefined service "db"');
    expect(result.current.checking).toBe(false);
    unmount();
  });

  it("keeps a previous invalid verdict when the round trip fails, instead of erasing it", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, message: "bad compose" }));

    const { result, rerender, unmount } = renderHook(
      ({ text }) => useServerValidate("app1", text),
      { initialProps: { text: "first" } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(result.current.message).toBe("bad compose");

    // A genuine network failure, not a validation verdict at all.
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    rerender({ text: "second" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(result.current.message).toBe("bad compose");
    expect(result.current.checking).toBe(false);
    unmount();
  });

  it("keeps a previous valid verdict when the round trip fails, instead of a false error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: true }));

    const { result, rerender, unmount } = renderHook(
      ({ text }) => useServerValidate("app1", text),
      { initialProps: { text: "first" } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(result.current.message).toBeNull();

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    rerender({ text: "second" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(result.current.message).toBeNull();
    expect(result.current.checking).toBe(false);
    unmount();
  });

  it("does not update state from a response that lands after unmount", async () => {
    vi.useFakeTimers();
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = renderHook(() => useServerValidate("app1", "services: {}"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(resolveFetch).toBeDefined();

    unmount();
    await act(async () => {
      resolveFetch?.(jsonResponse({ valid: false, message: "too late" }));
      await vi.advanceTimersByTimeAsync(0);
    });

    // No React "state update on an unmounted component" warning.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("clears the debounce timer on unmount, leaking no Timeout handle", () => {
    const before = timeoutCount();
    const { unmount } = renderHook(() => useServerValidate("app1", "services: {}"));
    expect(timeoutCount()).toBe(before + 1);

    unmount();
    expect(timeoutCount()).toBe(before);
  });

  it("restarts the timer instead of leaking one per keystroke", () => {
    const before = timeoutCount();
    const { rerender, unmount } = renderHook(({ text }) => useServerValidate("app1", text), {
      initialProps: { text: "a" },
    });
    expect(timeoutCount()).toBe(before + 1);

    rerender({ text: "ab" });
    rerender({ text: "abc" });
    expect(timeoutCount()).toBe(before + 1);

    unmount();
    expect(timeoutCount()).toBe(before);
  });
});
