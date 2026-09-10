import { applyTransition, type ProbeState } from "@server/monitoring/transition";
import { describe, expect, it } from "vitest";

const NOW = 1_800_000_000;
const state = (over: Partial<ProbeState> = {}): ProbeState => ({
  lastStatus: "up",
  consecutiveFailures: 0,
  statusSince: NOW - 3600,
  ...over,
});
const run = (over: Partial<Parameters<typeof applyTransition>[0]> = {}) =>
  applyTransition({
    state: state(),
    observed: "up",
    now: NOW,
    graceUntil: null,
    failureThreshold: 2,
    ...over,
  });

describe("applyTransition", () => {
  it("does not go down on a single failure", () => {
    // The asymmetry: one failed check is packet loss, and a false alarm costs more than
    // sixty seconds of delayed detection.
    const out = run({ observed: "down" });
    expect(out.status).toBe("up");
    expect(out.consecutiveFailures).toBe(1);
    expect(out.changed).toBe(false);
    expect(out.statusSince).toBe(NOW - 3600);
  });

  it("goes down on the second consecutive failure", () => {
    const out = run({ observed: "down", state: state({ consecutiveFailures: 1 }) });
    expect(out).toMatchObject({ status: "down", changed: true, statusSince: NOW });
  });

  it("recovers on the first success", () => {
    const out = run({
      observed: "up",
      state: state({ lastStatus: "down", consecutiveFailures: 5, statusSince: NOW - 600 }),
    });
    expect(out).toMatchObject({
      status: "up",
      consecutiveFailures: 0,
      changed: true,
      statusSince: NOW,
    });
  });

  it("leaves statusSince alone when nothing changed", () => {
    // The timeline must record real outages, not every sample.
    const out = run({ observed: "up", state: state({ statusSince: NOW - 9999 }) });
    expect(out.changed).toBe(false);
    expect(out.statusSince).toBe(NOW - 9999);
  });

  it("resets the failure count on any success", () => {
    const out = run({ observed: "up", state: state({ consecutiveFailures: 1 }) });
    expect(out.consecutiveFailures).toBe(0);
  });

  it("reports starting during the grace window instead of down", () => {
    // A restart the user initiated is never an outage.
    const out = run({
      observed: "down",
      graceUntil: NOW + 60,
      state: state({ consecutiveFailures: 5, lastStatus: "up" }),
    });
    expect(out.status).toBe("starting");
  });

  it("does not let the grace window mask a success", () => {
    const out = run({ observed: "up", graceUntil: NOW + 60 });
    expect(out.status).toBe("up");
  });

  it("stops masking once the grace window has passed", () => {
    const out = run({
      observed: "down",
      graceUntil: NOW - 1,
      state: state({ consecutiveFailures: 1 }),
    });
    expect(out.status).toBe("down");
  });

  it("counts failures during grace so the fall is immediate when it ends", () => {
    // Otherwise a stack that never comes back looks healthy for two more intervals after
    // the window closes.
    const out = run({ observed: "down", graceUntil: NOW + 60 });
    expect(out.consecutiveFailures).toBe(1);
  });

  it("treats degraded as a failure for counting but reports it distinctly", () => {
    const first = run({ observed: "degraded" });
    expect(first).toMatchObject({ status: "up", consecutiveFailures: 1, changed: false });
    const second = run({ observed: "degraded", state: state({ consecutiveFailures: 1 }) });
    expect(second).toMatchObject({ status: "degraded", changed: true });
  });

  it("honours a threshold of 1", () => {
    const out = run({ observed: "down", failureThreshold: 1 });
    expect(out).toMatchObject({ status: "down", changed: true });
  });

  it("sets statusSince on the first ever check", () => {
    const out = run({ observed: "up", state: state({ lastStatus: "unknown", statusSince: null }) });
    expect(out).toMatchObject({ status: "up", changed: true, statusSince: NOW });
  });
});
