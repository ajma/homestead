import type { ProbeSnapshot, StatusReason } from "@shared/launcher.js";
import type { AppStatus } from "@shared/types.js";

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

function phraseFor(worst: ProbeSnapshot, others: ProbeSnapshot[]): string {
  if (worst.status === "up") return "Healthy";
  if (worst.status === "starting") return "Starting";
  if (worst.status === "unknown") return "Not checked yet";
  if (worst.faultClass === "config") return "Compose config invalid";

  if (worst.kind === "http_external") {
    // Only exonerate the app when something actually observed it working. Saying
    // "app is fine" on the strength of no evidence is worse than saying nothing.
    const appIsFine = others.some(
      (p) => (p.kind === "docker" || p.kind === "http_internal") && p.status === "up",
    );
    if (appIsFine) return "Tunnel unreachable — app is fine";
    return "Unreachable";
  }

  if (worst.kind === "docker") return "Containers not running";
  return "App not responding";
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
  for (const probe of probes) {
    if (SEVERITY[probe.status] > SEVERITY[worst.status]) worst = probe;
  }

  const others = probes.filter((p) => p !== worst);
  const appIsFine = others.some(
    (p) => (p.kind === "docker" || p.kind === "http_internal") && p.status === "up",
  );

  // A failing tunnel over a working app is a partial outage, not an outage.
  const status: AppStatus =
    worst.kind === "http_external" && worst.status === "down" && appIsFine
      ? "degraded"
      : worst.status;

  return { status, reason: phraseFor(worst, others), since: worst.statusSince };
}
