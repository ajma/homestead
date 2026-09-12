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

  it("validates the corrected text immediately once a slow, now-outdated request settles", async () => {
    // Before the in-flight gate (see the "in-flight gate" describe block below), a
    // second, newer request went out *while* the first was still pending, and this test
    // proved the older one's late answer got discarded rather than clobbering the
    // newer verdict. The gate now makes that overlap impossible in the first place — a
    // debounce tick found a request already running and declined to start a second one
    // — so what this test proves instead is the other half of the fix: once the
    // outstanding request settles, the hook notices the text has since changed and
    // validates it right away, rather than waiting out another full debounce that may
    // never come if the user has stopped typing.
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

    // The user fixes the typo before the first request answers. The debounce fires
    // again, but finds a request already in flight and declines to start a second one.
    rerender({ text: "services:\n  web:\n    depends_on: [database]\n" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const resolveFirst = must(resolvers[0], "the first request never resolved");

    // The one outstanding request finally answers, for the typo that is no longer on
    // screen — and its own settle handler immediately fires a second request for the
    // corrected text, with no further debounce wait.
    await act(async () => {
      resolveFirst(
        jsonResponse({
          valid: false,
          message: 'service "web" depends on undefined service "databse"',
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const resolveSecond = must(resolvers[1], "the second request never resolved");
    await act(async () => {
      resolveSecond(jsonResponse({ valid: true }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.message).toBeNull();
    expect(result.current.checking).toBe(false);
    unmount();
  });

  it("validates the newly-broken text immediately once a slow, now-outdated request settles", async () => {
    // The mirror image of the test above, confirming the immediate follow-up check is
    // not one-directional: it fires just as readily when the text changed from valid to
    // invalid while the first request was still outstanding.
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
    // Still just the one in-flight request — the tick for the edited text was declined.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const resolveFirst = must(resolvers[0], "the first request never resolved");
    await act(async () => {
      resolveFirst(jsonResponse({ valid: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    // The first answer (for text no longer on screen) is briefly applied — accurate for
    // what was on screen at the time — and a second request for the current text was
    // dispatched immediately as part of the same settle.
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const resolveSecond = must(resolvers[1], "the second request never resolved");
    await act(async () => {
      resolveSecond(
        jsonResponse({
          valid: false,
          message: 'service "web" depends on undefined service "ghost"',
        }),
      );
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

  it("keeps checking true across an immediate follow-up check for text that changed while a request failed in transport", async () => {
    // Before the in-flight gate, this proved `checking` survived a newer request still
    // being outstanding when an older, discarded one rejected. That overlap is no longer
    // possible (a debounce tick while one is in flight declines to start another), so
    // what matters now is that the follow-up check the settle handler fires for changed
    // text doesn't produce a visible `checking: false` flicker in between — both the
    // `setChecking(false)` from the failed request settling and the `setChecking(true)`
    // from the immediate re-dispatch happen inside the same callback, so React's
    // batching should coalesce them into `checking` staying `true` throughout.
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

    // The text changes before the first request answers. The debounce fires again but
    // finds one already in flight, so no second request goes out yet.
    rerender({ text: "second" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.current.checking).toBe(true);

    const rejectFirst = must(rejectors[0], "the first request never registered a rejector");

    // The first request fails in transport. Text has since changed, so its own settle
    // handler immediately fires a second request — `checking` must never read `false`
    // in between, or the user would (however briefly) see "not checking" between two
    // checks that are, from their perspective, one continuous wait.
    await act(async () => {
      rejectFirst(new TypeError("Failed to fetch"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.current.checking).toBe(true);

    const resolveSecond = must(resolvers[1], "the second request never resolved");
    await act(async () => {
      resolveSecond(jsonResponse({ valid: false, message: "second problem" }));
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

  describe("transportError", () => {
    // What lets a caller tell "we don't know" apart from a real verdict — see the
    // hook's own doc comment. `message` must never carry this (a transport failure is
    // not "you're wrong"), so it needs its own field.

    it("goes true when the round trip rejects", async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
      );

      const { result, unmount } = renderHook(() => useServerValidate("app1", "services: {}"));
      expect(result.current.transportError).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(result.current.transportError).toBe(true);
      expect(result.current.message).toBeNull();
      unmount();
    });

    it("goes true for a 200 that does not match ValidateResponse", async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ unexpected: "shape" })),
      );

      const { result, unmount } = renderHook(() => useServerValidate("app1", "services: {}"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(result.current.transportError).toBe(true);
      unmount();
    });

    it("clears once a later round trip gets a real verdict", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      const { result, rerender, unmount } = renderHook(
        ({ text }) => useServerValidate("app1", text),
        { initialProps: { text: "first" } },
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(result.current.transportError).toBe(true);

      fetchMock.mockResolvedValueOnce(jsonResponse({ valid: true }));
      rerender({ text: "second" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(result.current.transportError).toBe(false);
      unmount();
    });

    it("clears as soon as a new attempt starts, not only once it settles", async () => {
      // Once a fresh check is underway, `checking` is already the right thing to show —
      // a stale "could not reach the server" caption sitting next to it would say two
      // different things about the same request.
      vi.useFakeTimers();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      const { result, rerender, unmount } = renderHook(
        ({ text }) => useServerValidate("app1", text),
        { initialProps: { text: "first" } },
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(result.current.transportError).toBe(true);

      fetchMock.mockImplementationOnce(() => new Promise(() => {}));
      rerender({ text: "second" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(result.current.checking).toBe(true);
      expect(result.current.transportError).toBe(false);
      unmount();
    });
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

    it("increments once per round trip, including an immediate follow-up for changed text", async () => {
      // Before the in-flight gate, two requests could be outstanding at once, and this
      // proved the older one — discarded by `seqRef` once a newer one had already
      // answered — did not double-count. That overlap can no longer happen: the gate
      // means a second request only ever starts once the first has fully settled, so
      // neither dispatch is ever "stale" relative to the other — each is simply counted
      // when it finishes, including the automatic follow-up for text that changed while
      // the first was in flight.
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
      // Still one request outstanding — the tick for the changed text was declined.
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const resolveFirst = must(resolvers[0], "the first request never resolved");
      await act(async () => {
        resolveFirst(jsonResponse({ valid: true }));
        await vi.advanceTimersByTimeAsync(0);
      });
      // That settle both counted itself and immediately dispatched the follow-up for
      // "second", which is now the one outstanding request.
      expect(result.current.settledCount).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const resolveSecond = must(resolvers[1], "the second request never resolved");
      await act(async () => {
        resolveSecond(jsonResponse({ valid: true }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.settledCount).toBe(2);
      unmount();
    });
  });

  describe("the in-flight gate", () => {
    // Minor from the final review: `use-server-validate.ts:118` had no gate on
    // *dispatch*, only on which response wins (`seqRef`). Measured consequence: ten
    // seconds of realistic typing against a 2.5s round trip (representative of `docker
    // compose config` on a loaded NAS) produced 14 requests with up to 4 running
    // concurrently — each one a temp file written into the app's own directory, a real
    // subprocess, and a delete.

    it("does not start a second request while one is still in flight", async () => {
      vi.useFakeTimers();
      const resolvers: Array<(response: Response) => void> = [];
      const fetchSpy = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const { rerender, unmount } = renderHook(({ text }) => useServerValidate("app1", text), {
        initialProps: { text: "first" },
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Keep "typing" well past two more debounce windows while the first request is
      // still unresolved — the exact shape of the measured bug.
      rerender({ text: "second" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      rerender({ text: "third" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      // Still exactly one request outstanding.
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Cleans up: let it resolve so nothing leaks into the next test.
      const resolveFirst = must(resolvers[0], "the first request never resolved");
      await act(async () => {
        resolveFirst(jsonResponse({ valid: true }));
        await vi.advanceTimersByTimeAsync(0);
      });
      unmount();
    });
  });
});
