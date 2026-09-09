import { describe, expect, it } from "vitest";
import type { MonitorLatest } from "../monitoring/status.js";
import { deriveTier } from "./tier.js";

const m = (over: Partial<MonitorLatest> = {}): MonitorLatest => ({
  id: "m",
  type: "http",
  required: true,
  enabled: true,
  up: true,
  error: null,
  at: 1,
  ...over,
});

describe("deriveTier", () => {
  it("is unknown when nothing has reported", () => {
    expect(deriveTier([m({ up: null, at: null })]).tier).toBe("unknown");
  });

  it("is verified when a healthcheck passes", () => {
    expect(deriveTier([m({ type: "docker", error: null })]).tier).toBe(
      "verified",
    );
  });

  it("is down when a required monitor is down", () => {
    expect(deriveTier([m({ up: false, error: "refused" })]).tier).toBe("down");
  });

  it("is blocked when a probe was rejected by Access", () => {
    const t = deriveTier([
      m({
        type: "reachability",
        required: false,
        up: false,
        error: "access: Authentication failed",
      }),
    ]);
    expect(t.tier).toBe("blocked");
    // The marker is a contract between the executor and this function. It must
    // not reach the tile, where it reads as a typo rather than a prefix.
    expect(t.reason).toBe("Authentication failed");
    expect(t.reason).not.toContain("access:");
  });

  it("is blocked even when docker is up and reachability has Access error", () => {
    // Realistic case: healthy service but misconfigured Access policy
    const t = deriveTier([
      m({ type: "docker" }),
      m({
        type: "reachability",
        required: false,
        up: false,
        error: "access: Authentication failed",
      }),
    ]);
    expect(t.tier).toBe("blocked");
  });

  it("is blocked regardless of human message wording when marker present", () => {
    // Marker decouples tier logic from prose: message can change, tier does not
    const t = deriveTier([
      m({
        type: "reachability",
        required: false,
        up: false,
        error: "access: Auth rejected by policy",
      }),
    ]);
    expect(t.tier).toBe("blocked");
  });

  it("ignores disabled monitors even if they carry Access error", () => {
    const t = deriveTier([
      m({ type: "docker" }),
      m({
        type: "reachability",
        enabled: false,
        up: false,
        error: "access: Authentication failed",
      }),
    ]);
    expect(t.tier).toBe("verified");
  });

  it("is down when it is locally up but publicly unreachable", () => {
    // This was the `degraded` tier, back when reachability was advisory and
    // could fail without moving the dot. Now that the public check gates,
    // an app nobody outside can reach is down — and the reason still names
    // reachability, so the two outages stay tellable apart.
    const t = deriveTier([
      m({ type: "docker" }),
      m({ type: "reachability", required: true, up: false, error: "HTTP 502" }),
    ]);
    expect(t.tier).toBe("down");
    expect(t.reason).toBe("reachability: HTTP 502");
  });

  it("is blocked, not down, when a required public check is refused by Access", () => {
    // Both branches match once reachability is required. `blocked` has to be
    // tested first or this reads as the raw "reachability: access: ..."
    // string, which the marker exists to keep off the tile.
    const t = deriveTier([
      m({ type: "docker" }),
      m({
        type: "reachability",
        required: true,
        up: false,
        error: "access: Authentication failed",
      }),
    ]);
    expect(t.tier).toBe("blocked");
    expect(t.reason).toBe("Authentication failed");
  });

  it("is responding when only an http check has answered", () => {
    expect(deriveTier([m({ type: "http" })]).tier).toBe("responding");
  });
});
