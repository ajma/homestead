import type { ContainerSummary } from "../host/types.js";
import type { ResolvedService } from "./compose-config.js";
import type { AppStatusSummary } from "./serialize.js";

type ServiceState = "up" | "starting" | "degraded" | "down" | "completed";

/**
 * Docker exposes health only in the human-readable status string — `Up 5 minutes
 * (healthy)`, `(unhealthy)`, `(health: starting)`. `listContainers` does not surface a
 * structured health field, so this parses it. Most images define no health check at
 * all, in which case a running container counts as up.
 */
function healthOf(status: string): "healthy" | "unhealthy" | "starting" | "none" {
  if (status.includes("(healthy)")) return "healthy";
  if (status.includes("(unhealthy)")) return "unhealthy";
  if (status.includes("health: starting")) return "starting";
  return "none";
}

function exitCodeOf(status: string): number | null {
  const match = /Exited \((\d+)\)/.exec(status);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function classify(service: ResolvedService, container: ContainerSummary | undefined): ServiceState {
  if (!container) return "down";

  switch (container.state) {
    case "running": {
      const health = healthOf(container.status);
      if (health === "unhealthy") return "down";
      if (health === "starting") return "starting";
      return "up";
    }
    case "restarting":
      return "degraded";
    case "created":
      return "starting";
    case "paused":
      return "degraded";
    case "exited": {
      // A one-shot init or migration container finishing cleanly is normal. Reporting
      // it as a failure would make most real stacks permanently red.
      //
      // Only an EXPLICIT `restart: "no"` counts. Treating an absent policy as one-shot
      // too would cover almost every service in a typical compose file — the field is
      // usually omitted — so a web server that exited cleanly would read as success and
      // the app would show green while nothing was serving.
      const isOneShot = service.restart === "no";
      return isOneShot && exitCodeOf(container.status) === 0 ? "completed" : "down";
    }
    default:
      return "down";
  }
}

export function rollUpStatus(
  expected: ResolvedService[],
  containers: ContainerSummary[],
): AppStatusSummary {
  if (expected.length === 0) return { status: "unknown", detail: null };

  const byService = new Map(containers.map((c) => [c.service ?? "", c]));
  const states = expected.map((service) => classify(service, byService.get(service.name)));

  const count = (state: ServiceState) => states.filter((s) => s === state).length;
  const up = count("up");
  const completed = count("completed");
  const missing = expected.filter((s) => !byService.has(s.name)).length;

  const parts = [`${up}/${expected.length} services up`];
  if (completed > 0) parts.push(`${completed} completed`);
  if (missing > 0) parts.push(`${missing} missing`);
  const detail = parts.join(", ");

  if (states.includes("down")) return { status: "down", detail };
  if (states.includes("degraded")) return { status: "degraded", detail };
  if (states.includes("starting")) return { status: "starting", detail };
  return { status: "up", detail };
}
