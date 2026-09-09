import type { ConfidenceTier } from "@shared/dashboard.js";
import type { MonitorLatest } from "../monitoring/status.js";

export function deriveTier(monitors: MonitorLatest[]): {
  tier: ConfidenceTier;
  reason: string | null;
} {
  const enabled = monitors.filter((m) => m.enabled);

  // Precedence: blocked → down → verified → responding → unknown

  // blocked: Access authentication failed.
  //
  // Ahead of `down`, not behind it. Since the reachability monitor became
  // required, an Access rejection also trips the `down` test — and "down"
  // would win a race it should lose, because "Cloudflare would not let our
  // probe through" is the *reason* for that down, not a rival verdict. Behind
  // `down`, this branch was unreachable and the tile showed the raw
  // "reachability: access: ..." string the comment below says nobody should
  // read.
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

  // down: any required monitor is down
  for (const mon of enabled) {
    if (mon.required && mon.up === false) {
      const reason = mon.error ? `${mon.type}: ${mon.error}` : mon.type;
      return { tier: "down", reason };
    }
  }

  // There is no `degraded` tier here any more. It meant "locally up but
  // publicly unreachable", which was a distinction worth drawing only while
  // the reachability monitor was advisory and could fail without moving the
  // dot. Now that it gates, that state *is* down, and a branch below `down`
  // that tests the same condition could never be reached.

  // verified: when a docker/healthcheck passes
  const dockerUp = enabled.some((m) => m.type === "docker" && m.up === true);
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
