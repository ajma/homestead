// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useNow } from "@web/lib/use-now";
import { describe, expect, it, vi } from "vitest";

/**
 * Count of active `Timeout` handles right now, per `process.getActiveResourcesInfo()`.
 * `process._getActiveHandles()` does not track timers on this Node version, so it is
 * useless here — a test using it would pass against any implementation, including one
 * that never clears anything.
 */
function timeoutCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

describe("useNow", () => {
  it("shares one interval across two mounted consumers", () => {
    const baseline = timeoutCount();

    const a = renderHook(() => useNow());
    expect(timeoutCount()).toBe(baseline + 1);

    const b = renderHook(() => useNow());
    expect(timeoutCount()).toBe(baseline + 1);

    a.unmount();
    b.unmount();
  });

  it("clears the interval once the last consumer unmounts", () => {
    const baseline = timeoutCount();

    const hook = renderHook(() => useNow());
    expect(timeoutCount()).toBe(baseline + 1);

    hook.unmount();
    expect(timeoutCount()).toBe(baseline);
  });

  it("keeps ticking for the remaining consumer when only one of two unmounts", () => {
    const baseline = timeoutCount();

    const a = renderHook(() => useNow());
    const b = renderHook(() => useNow());
    a.unmount();

    expect(timeoutCount()).toBe(baseline + 1);

    b.unmount();
    expect(timeoutCount()).toBe(baseline);
  });

  it("advances the returned value across a tick", () => {
    vi.useFakeTimers();
    try {
      const hook = renderHook(() => useNow());
      const first = hook.result.current;

      act(() => {
        vi.advanceTimersByTime(30_000);
      });

      expect(hook.result.current).toBeGreaterThan(first);
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
