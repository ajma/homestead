import { randomUUID } from "node:crypto";
import type { MonitorType } from "@shared/monitoring.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checkRollups, checks, monitors } from "../db/schema.js";
import { enumerateApps } from "./enumerate.js";
import { desiredMonitors, planReconcile } from "./reconcile.js";

export type SyncAppMonitorsDeps = {
  listProjects: () => Promise<string[]>;
  composeConfig: (projectSlug: string) => Promise<unknown>;
  hostnameFor: (
    projectSlug: string,
    hostPort: number,
  ) => Promise<string | null>;
};

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 5000;

export async function syncAppMonitors(
  db: Db,
  deps: SyncAppMonitorsDeps,
): Promise<{ created: number; removed: number }> {
  let created = 0;
  let removed = 0;

  const projects = await deps.listProjects();

  for (const projectSlug of projects) {
    // Enumerate apps for this project
    let config: unknown;
    try {
      config = await deps.composeConfig(projectSlug);
    } catch (_err) {
      // A syntax error is not evidence that the apps are gone. Skip this project
      // and leave its monitors intact.
      continue;
    }

    const apps = enumerateApps(projectSlug, config);

    // For each app, determine desired monitors and reconcile
    for (const app of apps) {
      const hostname = await deps.hostnameFor(app.projectSlug, app.hostPort);
      const desired = desiredMonitors(app, hostname);

      // Fetch existing monitors for this app
      const existingRows = await db
        .select({
          id: monitors.id,
          targetId: monitors.targetId,
          type: monitors.type,
          config: monitors.config,
        })
        .from(monitors)
        .where(
          and(eq(monitors.targetType, "app"), eq(monitors.targetId, app.key)),
        );

      const existing = existingRows.map((row) => ({
        id: row.id,
        targetId: row.targetId,
        type: row.type as MonitorType,
        config: row.config,
      }));

      // Plan the reconciliation
      const plan = planReconcile(desired, existing);

      // Apply the plan: create new monitors
      for (const mon of plan.create) {
        await db.insert(monitors).values({
          id: randomUUID(),
          targetType: "app",
          targetId: mon.targetId,
          type: mon.type,
          config: JSON.stringify(mon.config),
          intervalSeconds: DEFAULT_INTERVAL_SECONDS,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          retries: 0,
          required: mon.required,
          enabled: true,
          nextDueAt: 0,
        });
        created++;
      }

      // Apply the plan: update monitors whose config changed
      for (const upd of plan.update) {
        await db
          .update(monitors)
          .set({ config: JSON.stringify(upd.config) })
          .where(eq(monitors.id, upd.id));
      }

      // Apply the plan: remove obsolete monitors.
      // Checks first: there is no cascade on `checks.monitor_id`, so deleting
      // only the monitor leaves its history addressed to an id nothing can
      // resolve — invisible, unprunable, and counted by every rollup.
      for (const id of plan.remove) {
        await db.delete(checks).where(eq(checks.monitorId, id));
        await db.delete(checkRollups).where(eq(checkRollups.monitorId, id));
        await db.delete(monitors).where(eq(monitors.id, id));
        removed++;
      }
    }

    // Clean up monitors for apps that no longer exist in this project
    const currentAppKeys = new Set(apps.map((a) => a.key));
    const allMonitorsForProject = await db
      .select({ id: monitors.id, targetId: monitors.targetId })
      .from(monitors)
      .where(eq(monitors.targetType, "app"));

    for (const mon of allMonitorsForProject) {
      // Check if this monitor belongs to this project
      if (mon.targetId.startsWith(`${projectSlug}:`)) {
        if (!currentAppKeys.has(mon.targetId)) {
          await db.delete(checks).where(eq(checks.monitorId, mon.id));
          await db
            .delete(checkRollups)
            .where(eq(checkRollups.monitorId, mon.id));
          await db.delete(monitors).where(eq(monitors.id, mon.id));
          removed++;
        }
      }
    }
  }

  return { created, removed };
}
