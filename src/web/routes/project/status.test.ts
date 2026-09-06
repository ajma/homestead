import type { ContainerState } from "@shared/projects.js";
import { describe, expect, it } from "vitest";
import {
  dockerStateToStatus,
  formatDuration,
  projectStatus,
} from "./status.js";

function container(over: Partial<ContainerState> = {}): ContainerState {
  return {
    service: "web",
    name: "stack-web-1",
    state: "running",
    health: null,
    exitCode: 0,
    ...over,
  };
}

describe("dockerStateToStatus", () => {
  it("maps the states StatusDot can draw", () => {
    expect(dockerStateToStatus("running")).toBe("running");
    expect(dockerStateToStatus("exited")).toBe("exited");
    expect(dockerStateToStatus("restarting")).toBe("restarting");
  });

  it("falls back to unknown for every other daemon state", () => {
    // `ContainerState.state` is whatever Docker reports, and the daemon has
    // more states than StatusDot has tints. An incomplete map either indexes
    // to undefined and renders an unstyled dot, or — worse — silently reuses
    // the previous key's colour and paints a dead container as healthy.
    for (const state of [
      "created",
      "paused",
      "dead",
      "removing",
      "Running",
      "",
    ])
      expect(dockerStateToStatus(state), state).toBe("unknown");
  });

  it("never reports a stopped container as running", () => {
    for (const state of ["dead", "exited", "paused", "removing"])
      expect(dockerStateToStatus(state), state).not.toBe("running");
  });
});

describe("projectStatus", () => {
  it("says nothing is running when compose reports no containers", () => {
    expect(projectStatus([])).toEqual({
      state: "unknown",
      label: "No containers",
    });
  });

  it("is running only when every container is", () => {
    expect(projectStatus([container(), container({ service: "db" })])).toEqual({
      state: "running",
      label: "Running",
    });
  });

  it("is stopped when none are running", () => {
    expect(
      projectStatus([
        container({ state: "exited" }),
        container({ service: "db", state: "dead" }),
      ]),
    ).toEqual({ state: "exited", label: "Stopped" });
  });

  it("reports a partly-up stack rather than rounding it to running", () => {
    // Rounding up here is how a user concludes their stack is fine while the
    // one container that matters has exited.
    expect(
      projectStatus([container(), container({ service: "db", state: "dead" })]),
    ).toEqual({ state: "unknown", label: "Partially running" });
  });

  it("surfaces a restart loop ahead of everything else", () => {
    expect(
      projectStatus([
        container(),
        container({ service: "db", state: "restarting" }),
      ]),
    ).toEqual({ state: "restarting", label: "Restarting" });
  });
});

describe("formatDuration", () => {
  it("reads in seconds below a minute", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(1_500)).toBe("1s");
    expect(formatDuration(59_900)).toBe("59s");
  });

  it("reads in minutes and seconds above one", () => {
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(125_000)).toBe("2m 05s");
  });

  it("never renders a negative duration from a clock skew", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});
