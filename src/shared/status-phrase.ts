import type { ProbeSnapshot, StatusReason } from "./launcher.js";
import type { AppStatus } from "./types.js";

/**
 * Worst-wins ordering. `unknown` outranks `up` because a probe we have not heard from
 * is not evidence of health, and this is the screen whose job is to tell the truth
 * about health.
 */
export const SEVERITY: Record<AppStatus, number> = {
  up: 0,
  unknown: 1,
  starting: 2,
  degraded: 3,
  down: 4,
};

/**
 * Reads `kind` and `faultClass` together, because they name different machines.
 * `faultClass` alone cannot tell a missing Access token (external, config) from an
 * unreadable compose file (docker, config) — and collapsing them sends the user to
 * debug the wrong one. `siblingIsUp` may only exonerate `http_external`: no other kind
 * has a machine downstream of it to blame instead.
 */
function phraseFor(worst: ProbeSnapshot, siblingIsUp: boolean): string {
  if (worst.status === "up") return "Healthy";
  if (worst.status === "starting") return "Starting";
  if (worst.status === "unknown") return "Not checked yet";

  if (worst.kind === "docker") {
    if (worst.faultClass === "network") return "Docker is unreachable";
    if (worst.faultClass === "config") return "Compose config invalid";
    return "Containers not running";
  }

  if (worst.kind === "http_internal") {
    if (worst.faultClass === "config") return "Address does not resolve";
    if (worst.faultClass === "network") return "No route to the app";
    return "App not responding";
  }

  // worst.kind === "http_external"
  if (worst.faultClass === "config") {
    return siblingIsUp ? "Access misconfigured — app is fine" : "Access misconfigured";
  }
  // A 5xx that is not a tunnel error means Cloudflare reached the origin and the origin
  // failed. The probe already blamed the app; the phrase must not contradict it by
  // exonerating on the strength of a sibling that never touched the failure.
  if (worst.faultClass === "app") return "Failing through the tunnel";
  return siblingIsUp ? "Tunnel unreachable — app is fine" : "Unreachable";
}

/**
 * One app's probes become one status and one cause.
 *
 * The external probe failing alone is reported as `degraded`, not `down`: the app is
 * running and reachable on the LAN, and painting the tile as down would be wrong for
 * every user standing in the house.
 */
export function rollUpProbes(probes: ProbeSnapshot[]): StatusReason {
  if (probes.length === 0) return { status: "unknown", reason: "Not checked yet", since: null };

  let worst = probes[0] as ProbeSnapshot;
  let worstIndex = 0;
  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i] as ProbeSnapshot;
    if (SEVERITY[probe.status] > SEVERITY[worst.status]) {
      worst = probe;
      worstIndex = i;
    }
  }

  // Excluded by index, not by reference: Task 3 builds these arrays from database rows
  // in a loop, and a caller reusing an object would otherwise silently drop a legitimate
  // sibling or leave `worst` inside `others`.
  const others = probes.filter((_probe, i) => i !== worstIndex);
  const siblingIsUp = others.some(
    (p) => (p.kind === "docker" || p.kind === "http_internal") && p.status === "up",
  );

  // A failing tunnel over a working app is a partial outage, not an outage. Unchanged
  // by faultClass, including `app`: "Failing through the tunnel" while the LAN is fine
  // is still a partial outage.
  const status: AppStatus =
    worst.kind === "http_external" && worst.status === "down" && siblingIsUp
      ? "degraded"
      : worst.status;

  return { status, reason: phraseFor(worst, siblingIsUp), since: worst.statusSince };
}
