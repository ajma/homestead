import { describe, expect, it } from "vitest";
import { resolveStatus } from "./status.js";

const m = (
  over: Partial<Parameters<typeof resolveStatus>[0][number]> = {},
) => ({
  id: "m",
  type: "tcp" as const,
  required: true,
  enabled: true,
  up: true,
  error: null,
  at: 1,
  ...over,
});

describe("resolveStatus", () => {
  it("is unknown when there are no monitors at all", () => {
    expect(resolveStatus([])).toEqual({ state: "unknown", reason: null });
  });

  it("is unknown when no monitor has reported yet", () => {
    expect(resolveStatus([m({ up: null, at: null })]).state).toBe("unknown");
  });

  it("is up when every required monitor is up", () => {
    expect(resolveStatus([m(), m({ id: "m2", type: "dns" })]).state).toBe("up");
  });

  it("is down when any required monitor is down, and names it", () => {
    const s = resolveStatus([
      m(),
      m({ id: "m2", type: "http", up: false, error: "timeout" }),
    ]);
    expect(s.state).toBe("down");
    // Red alone is not actionable: "container exited" and "callback timed out"
    // send you to different places.
    expect(s.reason).toContain("http");
  });

  it("is NOT pulled down by an advisory monitor", () => {
    const s = resolveStatus([
      m(),
      m({ id: "m2", required: false, up: false, error: "no ICMP" }),
    ]);
    expect(s.state).toBe("up");
  });

  it("ignores a disabled monitor entirely", () => {
    expect(resolveStatus([m({ enabled: false, up: false })]).state).toBe(
      "unknown",
    );
  });

  // Resolution 1: Precedence is down > unknown > up
  it("is unknown when one required monitor is up and another has never reported", () => {
    const s = resolveStatus([m(), m({ id: "m2", up: null, at: null })]);
    expect(s.state).toBe("unknown");
  });

  it("is down when one required monitor is down even if another has never reported", () => {
    const s = resolveStatus([
      m({ id: "m1", up: false, error: "failed" }),
      m({ id: "m2", up: null, at: null }),
    ]);
    expect(s.state).toBe("down");
  });

  // Resolution 2: All advisory monitors is unknown, not up
  it("is unknown when all monitors are advisory, not up", () => {
    const s = resolveStatus([
      m({ id: "m1", required: false, up: true }),
      m({ id: "m2", required: false, up: true }),
    ]);
    expect(s.state).toBe("unknown");
  });

  // Resolution 3: Multiple failures name the first in input order
  it("names the first failing monitor when multiple are down", () => {
    const s = resolveStatus([
      m({ id: "m1", type: "tcp", up: false, error: "connection refused" }),
      m({ id: "m2", type: "http", up: false, error: "timeout" }),
      m({ id: "m3", type: "dns", up: false, error: "NXDOMAIN" }),
    ]);
    expect(s.state).toBe("down");
    expect(s.reason).toContain("tcp");
    expect(s.reason).not.toContain("http");
    expect(s.reason).not.toContain("dns");
  });
});
