import type { ConfidenceTier } from "@shared/dashboard.js";
import type { MonitorLatest } from "../monitoring/status.js";

export function deriveTier(monitors: MonitorLatest[]): {
  tier: ConfidenceTier;
  reason: string | null;
} {
  const enabled = monitors.filter((m) => m.enabled);

  // Precedence: down → blocked → degraded → verified → responding → unknown

  // down: any required monitor is down
  for (const mon of enabled) {
    if (mon.required && mon.up === false) {
      const reason = mon.error ? `${mon.type}: ${mon.error}` : mon.type;
      return { tier: "down", reason };
    }
  }

  // blocked: Access authentication failed
  for (const mon of enabled) {
    if (mon.error?.startsWith("access:")) {
      // The "access:" prefix is a contract between the executor and this
      // function, not something a user should read on a tile.
      return {
        tier: "blocked",
        reason: mon.error.slice("access:".length).trim(),
      };
    }
  }

  // degraded: locally up (docker) but publicly unreachable (reachability down)
  const dockerUp = enabled.some((m) => m.type === "docker" && m.up === true);
  const reachabilityDown = enabled.some(
    (m) => m.type === "reachability" && m.up === false,
  );
  if (dockerUp && reachabilityDown) {
    return { tier: "degraded", reason: "Locally up but publicly unreachable" };
  }

  // verified: when a docker/healthcheck passes
  if (dockerUp) {
    return { tier: "verified", reason: null };
  }

  // responding: when only http check has answered
  const hasHttpUp = enabled.some((m) => m.type === "http" && m.up === true);
  if (hasHttpUp) {
    return { tier: "responding", reason: null };
  }

  // unknown: nothing has reported (up: null)
  return { tier: "unknown", reason: null };
}
