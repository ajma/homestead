import type { LauncherApp, ProbeSnapshot } from "@shared/launcher.js";
import { and, eq, isNull } from "drizzle-orm";
import type { AuthContext } from "../auth/context.js";
import { visibleAppsWhere } from "../auth/context.js";
import type { Db } from "../db/client.js";
import { apps, probes } from "../db/schema.js";
import { rollUpProbes } from "./status-phrase.js";

/**
 * Two indexed selects and an in-memory join. No Docker call, no `docker compose config`
 * spawn — see the spec: a wedged Docker socket must not degrade the screen whose job is
 * to reach Jellyfin. `GET /api/apps` deliberately does the expensive thing; this route
 * deliberately does not, and that is why it is a separate route.
 */
export async function launcherApps(db: Db, ctx: AuthContext): Promise<LauncherApp[]> {
  const scope = visibleAppsWhere(ctx);
  const rows = await db
    .select()
    .from(apps)
    .where(and(eq(apps.showOnLauncher, true), isNull(apps.archivedAt), ...(scope ? [scope] : [])));

  if (rows.length === 0) return [];

  // One select for every probe on the host, bucketed in memory. The alternative is a
  // query per tile, which is the shape this screen exists to avoid.
  const allProbes = await db
    .select({
      appId: probes.appId,
      kind: probes.kind,
      label: probes.label,
      status: probes.lastStatus,
      faultClass: probes.lastFaultClass,
      statusSince: probes.statusSince,
      lastCheckedAt: probes.lastCheckedAt,
      enabled: probes.enabled,
    })
    .from(probes);

  const byApp = new Map<string, ProbeSnapshot[]>();
  for (const probe of allProbes) {
    // A disabled probe is not evidence of anything. Including it would pin a tile at
    // whatever status it held when an admin switched it off.
    if (!probe.enabled) continue;
    const list = byApp.get(probe.appId) ?? [];
    list.push({
      kind: probe.kind,
      label: probe.label,
      status: probe.status,
      faultClass: probe.faultClass,
      statusSince: probe.statusSince,
      lastCheckedAt: probe.lastCheckedAt,
    });
    byApp.set(probe.appId, list);
  }

  return rows
    .map((row) => {
      const { status, reason, since } = rollUpProbes(byApp.get(row.id) ?? []);
      // Every property explicit. Do not rewrite as a spread — that inverts the failure
      // mode so a new column leaks until someone remembers to exclude it.
      return {
        id: row.id,
        slug: row.slug,
        displayName: row.displayName,
        description: row.description,
        iconRef: row.iconRef,
        category: row.category,
        launchUrl: row.launchInternalUrl,
        sortOrder: row.sortOrder,
        status,
        reason,
        since,
      };
    })
    .sort(
      (a, b) =>
        (a.category ?? "").localeCompare(b.category ?? "") ||
        a.sortOrder - b.sortOrder ||
        a.displayName.localeCompare(b.displayName),
    );
}
