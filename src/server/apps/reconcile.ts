import type { MonitorType } from "@shared/monitoring.js";
import type { EnumeratedApp } from "./enumerate.js";

export type DesiredMonitor = {
  targetId: string;
  type: MonitorType;
  config: Record<string, unknown>;
  required: boolean;
};

export type ExistingMonitor = {
  id: string;
  targetId: string;
  type: MonitorType;
  config: string;
};

export type MonitorUpdate = {
  id: string;
  config: Record<string, unknown>;
};

export type ReconcilePlan = {
  create: DesiredMonitor[];
  update: MonitorUpdate[];
  remove: string[];
  keep: string[];
};

/**
 * Determine which monitors an app should have based on whether it has a hostname.
 *
 * Unpublished apps get `docker` (is the container alive) and `http` (does it
 * answer on the loopback address). Published apps add `dns` and
 * `reachability` — the same request from outside, through Cloudflare Access.
 *
 * There is deliberately no `tcp` monitor. HTTP runs over TCP, so a passing
 * `http` check already proves the handshake; as a gate it could only ever
 * restate what `http` said. It remains available for devices, where the
 * protocol behind a port is unknown.
 */
export function desiredMonitors(
  app: EnumeratedApp,
  hostname: string | null,
): DesiredMonitor[] {
  const monitors: DesiredMonitor[] = [];

  // All apps get local health checks
  monitors.push({
    targetId: app.key,
    type: "docker",
    config: { projectSlug: app.projectSlug, service: app.service },
    required: true,
  });

  // The internal check: loopback, no DNS, no Cloudflare in the path.
  monitors.push({
    targetId: app.key,
    type: "http",
    config: { url: `http://127.0.0.1:${app.hostPort}` },
    required: true,
  });

  // Apps with a hostname get external reachability checks
  if (hostname) {
    monitors.push({
      targetId: app.key,
      type: "dns",
      config: { hostname },
      required: true,
    });

    // The public check: the URL a person would type, through Access. Only the
    // URL is stored — the probe's service token comes from the check context,
    // so rotating it does not mean rewriting a row per app, and the secret
    // lives in one settings row rather than one per monitor.
    //
    // Required, so a published app that nobody outside can reach does not
    // report green. The cost is that a Cloudflare outage reddens every
    // published tile at once; the expanded tile names which check failed.
    monitors.push({
      targetId: app.key,
      type: "reachability",
      config: { url: `https://${hostname}` },
      required: true,
    });
  }

  // Guard: desiredMonitors produces exactly one monitor per type.
  // Two of the same type would collide in planReconcile's find() logic.
  const types = monitors.map((m) => m.type);
  const uniqueTypes = new Set(types);
  if (types.length !== uniqueTypes.size) {
    throw new Error(
      `desiredMonitors produced duplicate types for ${app.key}: ${types.join(", ")}`,
    );
  }

  return monitors;
}

/**
 * Plan how to move from the current monitor set to the desired set.
 * Matching is on (targetId, type). Existing monitors that are still wanted
 * are kept to preserve their uptime history and user edits (intervalSeconds,
 * required, enabled). If the config changes (port, URL, hostname), the
 * monitor is updated rather than recreated.
 */
export function planReconcile(
  desired: DesiredMonitor[],
  existing: ExistingMonitor[],
): ReconcilePlan {
  const plan: ReconcilePlan = {
    create: [],
    update: [],
    remove: [],
    keep: [],
  };

  // Get the targetId we're reconciling (from desired, or from existing if desired is empty)
  const targetId = desired[0]?.targetId ?? existing[0]?.targetId;

  if (!targetId) {
    // Nothing to reconcile
    return plan;
  }

  // Filter existing monitors to only those for this target
  const existingForTarget = existing.filter((e) => e.targetId === targetId);

  // Match existing to desired
  for (const des of desired) {
    const match = existingForTarget.find((e) => e.type === des.type);

    if (match) {
      // Parse existing config to compare
      const existingConfig = JSON.parse(match.config) as Record<
        string,
        unknown
      >;
      const configChanged =
        JSON.stringify(existingConfig) !== JSON.stringify(des.config);

      if (configChanged) {
        // Config changed (e.g., port moved) — update to avoid stale target
        plan.update.push({ id: match.id, config: des.config });
      } else {
        // Config unchanged — keep untouched to preserve user edits
        plan.keep.push(match.id);
      }
    } else {
      plan.create.push(des);
    }
  }

  // Find existing monitors for this target that are no longer wanted
  for (const ex of existingForTarget) {
    const stillWanted = desired.some((d) => d.type === ex.type);
    if (!stillWanted) {
      plan.remove.push(ex.id);
    }
  }

  return plan;
}
