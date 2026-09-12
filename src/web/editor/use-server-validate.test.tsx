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

  it("discards a response that lands after `enabled` has already turned off", async () => {
    // The scenario `enabled` alone cannot prevent: an edit sends a request while dirty,
    // then a revert to the loaded text — still within the debounce window — makes
    // `enabled` false (nothing left worth checking). Turning `enabled` off only stops
    // NEW timers; the request already in flight keeps running. If its answer were
    // applied anyway, `message` would show a verdict right next to a caption telling the
    // user no check is running — two things on screen contradicting each other.
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
      ({ text, enabled }) => useServerValidate("app1", text, enabled),
      { initialProps: { text: "services:\n  web:\n    image: nginx\n", enabled: true } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The revert: `enabled` goes false without a newer request ever being sent.
    rerender({ text: "services:\n  web:\n    image: nginx\n", enabled: false });

    const resolveFirst = must(resolvers[0], "the request never resolved");
    await act(async () => {
      resolveFirst(jsonResponse({ valid: false, message: "stale verdict for reverted text" }));
      await vi.advanceTimersByTimeAsync(0);
    });

    // Discarded: `checking` still settles (nothing is left in flight), but no verdict
    // was applied for a check that, per `enabled`, is not running any more.
    expect(result.current.message).toBeNull();
    expect(result.current.checking).toBe(false);
    unmount();
  });

  it("still applies a response that lands while `enabled` is unchanged", async () => {
    // The property the fix above must not damage: a response is only discarded if
    // `enabled` actually turned off before it landed. This is the ordinary case —
    // nothing reverted, the check is still relevant — so the verdict must still show.
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ valid: false, message: "service depends on undefined service" }),
      ),
    );

    const { result, unmount } = renderHook(() =>
      useServerValidate("app1", "services:\n  web:\n    depends_on: [ghost]\n", true),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(result.current.message).toBe("service depends on undefined service");
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

  describe("a response that does not actually match ValidateResponse", () => {
    // A malformed 200 is transport-adjacent noise, not a verdict — see the hook's own
    // docstring and `isValidateResponse`. Each case here must be handled exactly like a
    // rejected fetch: `checking` goes back to false, but whatever verdict was already on
    // screen must survive untouched. Without the runtime shape check, `{}` and
    // `{ unexpected: "shape" }` make `response.valid` `undefined` (falsy), which used to
    // run the same branch as a genuine `{ valid: false }` and call `setMessage(undefined)`,
    // silently erasing the previous verdict.
    const cases: Array<[string, unknown]> = [
      ["an empty object", {}],
      ["an object with an unexpected shape", { unexpected: "shape" }],
      ["valid as a string rather than a boolean", { valid: "yes" }],
      ["valid: false with no message at all", { valid: false }],
      ["a body that is not an object at all", "just a string"],
    ];

    it.each(cases)("leaves the previous verdict alone for %s", async (_label, malformedBody) => {
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

      fetchMock.mockResolvedValueOnce(jsonResponse(malformedBody));
      rerender({ text: "second" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(result.current.message).toBe("bad compose");
      expect(result.current.checking).toBe(false);
      unmount();
    });
  });

  it("keeps checking true when a stale rejection lands while a newer request is still in flight", async () => {
    // The sequence guard in the *rejection* callback (`seq !== seqRef.current`) exists to
    // stop an older in-flight request, failing after a newer one is already pending, from
    // flipping `checking` back to false while the newer one is still running — which would
    // tell the user the check is done when it isn't. Removing that guard leaves every other
    // test in this file green, since none of them reject an old request while a newer one
    // is still outstanding.
    vi.useFakeTimers();
    const rejectors: Array<(error: unknown) => void> = [];
    const resolvers: Array<(response: Response) => void> = [];
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve, reject) => {
          resolvers.push(resolve);
          rejectors.push(reject);
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { result, rerender, unmount } = renderHook(
      ({ text }) => useServerValidate("app1", text),
      { initialProps: { text: "first" } },
    );

    // First request goes out and is left hanging.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // A second, newer request goes out before the first ever answers.
    rerender({ text: "second" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.current.checking).toBe(true);

    const rejectOlder = must(rejectors[0], "the first request never registered a rejector");
    const resolveNewer = must(resolvers[1], "the second request never resolved");

    // The older request now fails. It must be discarded, including its effect on
    // `checking`: the newer request is still the one running, so `checking` must stay
    // true.
    await act(async () => {
      rejectOlder(new TypeError("Failed to fetch"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.checking).toBe(true);

    // The newer request then lands normally, and is still the one that gets to decide
    // the outcome.
    await act(async () => {
      resolveNewer(jsonResponse({ valid: false, message: "second problem" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.checking).toBe(false);
    expect(result.current.message).toBe("second problem");
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

  describe("settledCount", () => {
    // `ComposeTab` latches its own "has this ever been checked" flag off this counter
    // rather than off `checking` toggling — see the hook's own doc comment for why a
    // true-then-false transition on `checking` cannot be relied on to ever render.

    it("increments once a round trip resolves", async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ valid: true })),
      );

      const { result, unmount } = renderHook(() => useServerValidate("app1", "services: {}"));
      expect(result.current.settledCount).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(result.current.settledCount).toBe(1);
      unmount();
    });

    it("increments even for a rejected request, since the round trip still settled", async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
      );

      const { result, unmount } = renderHook(() => useServerValidate("app1", "services: {}"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(result.current.settledCount).toBe(1);
      unmount();
    });

    it("does not increment for a request discarded as stale by a newer one", async () => {
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
        { initialProps: { text: "first" } },
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      rerender({ text: "second" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const resolveNewer = must(resolvers[1], "the second request never resolved");
      await act(async () => {
        resolveNewer(jsonResponse({ valid: true }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.settledCount).toBe(1);

      // The older, superseded request now answers too — discarded by `seqRef`, same as
      // its effect on `message`, so it must not bump the counter either.
      const resolveOlder = must(resolvers[0], "the first request never resolved");
      await act(async () => {
        resolveOlder(jsonResponse({ valid: true }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.settledCount).toBe(1);
      unmount();
    });
  });
});
