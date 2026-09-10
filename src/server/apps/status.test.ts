import type { ResolvedService } from "@server/apps/compose-config";
import { rollUpStatus } from "@server/apps/status";
import type { ContainerSummary } from "@server/host/types";
import { describe, expect, it } from "vitest";

const service = (name: string, restart: string | null = null): ResolvedService => ({
  name,
  image: "x",
  restart,
  publishedPorts: [],
});

const container = (service: string, state: string, status = ""): ContainerSummary => ({
  id: service,
  names: [service],
  image: "x",
  state,
  status,
  project: "p",
  service,
  labels: {},
});

describe("rollUpStatus", () => {
  it("is up when every expected service is running", () => {
    expect(
      rollUpStatus(
        [service("web"), service("db")],
        [
          container("web", "running", "Up 2 hours"),
          container("db", "running", "Up 2 hours (healthy)"),
        ],
      ),
    ).toMatchObject({ status: "up" });
  });

  it("is up when a healthy container reports healthy", () => {
    expect(
      rollUpStatus([service("db")], [container("db", "running", "Up 5 minutes (healthy)")]).status,
    ).toBe("up");
  });

  it("is down when a container reports unhealthy", () => {
    expect(
      rollUpStatus([service("db")], [container("db", "running", "Up 5 minutes (unhealthy)")])
        .status,
    ).toBe("down");
  });

  it("is starting while a health check is still starting", () => {
    expect(
      rollUpStatus([service("db")], [container("db", "running", "Up 3 seconds (health: starting)")])
        .status,
    ).toBe("starting");
  });

  it("is degraded when a container is restarting", () => {
    expect(
      rollUpStatus(
        [service("web")],
        [container("web", "restarting", "Restarting (1) 5 seconds ago")],
      ).status,
    ).toBe("degraded");
  });

  it("is down when an expected service has no container at all", () => {
    expect(
      rollUpStatus([service("web"), service("db")], [container("web", "running")]).status,
    ).toBe("down");
  });

  // The rule that keeps real stacks from reading as permanently broken.
  it("treats an exited-zero one-shot with restart:no as completed, not down", () => {
    const result = rollUpStatus(
      [service("web"), service("init", "no")],
      [
        container("web", "running", "Up 2 hours"),
        container("init", "exited", "Exited (0) 2 hours ago"),
      ],
    );
    expect(result.status).toBe("up");
    expect(result.detail).toContain("1 completed");
  });

  it("is down when a one-shot exits non-zero", () => {
    expect(
      rollUpStatus(
        [service("web"), service("init", "no")],
        [container("web", "running"), container("init", "exited", "Exited (1) 2 hours ago")],
      ).status,
    ).toBe("down");
  });

  it("is down when a long-running service exits zero", () => {
    // No `restart: no`, so exiting is not this service's normal end state.
    expect(
      rollUpStatus([service("web")], [container("web", "exited", "Exited (0) 2 hours ago")]).status,
    ).toBe("down");
  });

  it("is unknown when the config resolved no services", () => {
    expect(rollUpStatus([], []).status).toBe("unknown");
  });

  it("covers the remaining container states", () => {
    // Each is a distinct switch branch, and a silent regression in any of them shows
    // the user a green dot over a stack that is not serving.
    expect(rollUpStatus([service("w")], [container("w", "created")]).status).toBe("starting");
    expect(rollUpStatus([service("w")], [container("w", "paused")]).status).toBe("degraded");
    expect(rollUpStatus([service("w")], [container("w", "dead")]).status).toBe("down");
  });

  it("ignores a container the compose file no longer declares", () => {
    // `docker compose up` without `--remove-orphans` leaves the container of a deleted
    // service running. The rollup answers "are the declared services healthy", so an
    // undeclared extra is not a fault here; the adoption scan is where strays surface.
    const result = rollUpStatus(
      [service("web")],
      [container("web", "running", "Up 2 hours"), container("removed", "running", "Up 9 days")],
    );
    expect(result).toEqual({ status: "up", detail: "1/1 services up" });
  });

  it("summarises counts in the detail string", () => {
    const result = rollUpStatus(
      [service("a"), service("b"), service("c")],
      [container("a", "running"), container("b", "running")],
    );
    expect(result.detail).toBe("2/3 services up, 1 missing");
  });
});
