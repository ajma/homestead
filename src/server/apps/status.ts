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
      return "down";
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

/**
 * Worst-first rank, so a service's state is the worst of its replicas'.
 *
 * A `Record` rather than an array on purpose: adding a member to `ServiceState` without
 * ranking it here is then a compile error. An array typed `ServiceState[]` accepts a
 * missing entry silently, and the new state would fall through to the `down` default.
 */
const SEVERITY: Record<ServiceState, number> = {
  down: 0,
  degraded: 1,
  starting: 2,
  up: 3,
  completed: 4,
};

/**
 * Collapses one service's containers into a single state.
 *
 * A service can have more than one container — `deploy.replicas`, or a `scale` left
 * over from a manual `docker compose up --scale`. Keying a Map by service name kept
 * only the last one, so two healthy replicas beside one unhealthy reported the whole
 * app as up: a green dot over a partly broken service, which is the exact failure this
 * module exists to prevent.
 */
function worst(states: ServiceState[]): ServiceState {
  return states.reduce<ServiceState>(
    (acc, state) => (SEVERITY[state] < SEVERITY[acc] ? state : acc),
    "completed",
  );
}

export function rollUpStatus(
  expected: ResolvedService[],
  containers: ContainerSummary[],
): AppStatusSummary {
  if (expected.length === 0) return { status: "unknown", detail: null };

  const byService = new Map<string, ContainerSummary[]>();
  for (const c of containers) {
    const key = c.service ?? "";
    byService.set(key, [...(byService.get(key) ?? []), c]);
  }

  const states = expected.map((service) => {
    const found = byService.get(service.name) ?? [];
    if (found.length === 0) return classify(service, undefined);
    return worst(found.map((c) => classify(service, c)));
  });

  const count = (state: ServiceState) => states.filter((s) => s === state).length;
  const up = count("up");
  const completed = count("completed");
  const missing = expected.filter((s) => (byService.get(s.name) ?? []).length === 0).length;
  // A service that is `down` but has a container is failing, not absent — an unhealthy
  // health check or a non-zero exit. Separating the two is the whole point of the line.
  const failing = count("down") - missing;

  // `completed` counts toward the numerator. A one-shot that exited zero IS in its
  // intended state, and excluding it produced a green dot beside the words
  // "0/1 services up" — which reads as broken.
  //
  // The remaining clauses name the cause, which is what this line is for: the dot says
  // something is wrong, the line says what. Without them a stack of three restarting
  // containers and a stack with three missing ones both read "0/3 services up".
  const parts = [`${up + completed}/${expected.length} services up`];
  if (completed > 0) parts.push(`${completed} completed`);
  if (count("starting") > 0) parts.push(`${count("starting")} starting`);
  if (count("degraded") > 0) parts.push(`${count("degraded")} degraded`);
  if (failing > 0) parts.push(`${failing} failing`);
  if (missing > 0) parts.push(`${missing} missing`);
  const detail = parts.join(", ");

  if (states.includes("down")) return { status: "down", detail };
  if (states.includes("degraded")) return { status: "degraded", detail };
  if (states.includes("starting")) return { status: "starting", detail };
  return { status: "up", detail };
}
