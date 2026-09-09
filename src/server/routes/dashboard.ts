import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
  AppSummary,
  DeviceSummary as DashboardDeviceSummary,
} from "@shared/dashboard.js";
import type { MonitorSummary, MonitorType } from "@shared/monitoring.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { deriveTier } from "../apps/tier.js";
import { requirePermission } from "../auth/guard.js";
import type { Db } from "../db/client.js";
import { checks, devices, manualApps, monitors } from "../db/schema.js";
import type { MonitorLatest } from "../monitoring/status.js";
import { resolveStatus } from "../monitoring/status.js";

import { readIdentities } from "../projects/identity.js";
import { scanProjects } from "../projects/store.js";

/**
 * A monitor's row on an expanded tile. `up: null` becomes "unknown" rather
 * than a third boolean, so the dot component takes one union and no nulls.
 */
function toMonitorSummary(m: MonitorLatest): MonitorSummary {
  return {
    id: m.id,
    type: m.type,
    required: m.required,
    enabled: m.enabled,
    state: m.up === null ? "unknown" : m.up ? "up" : "down",
    lastCheckedAt: m.at,
    error: m.error,
  };
}

type Opts = {
  db: Db;
  projectsDir: string;
  dataDir: string;
};

const createAppBody = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  iconSlug: z.string().optional(),
  iconUrl: z.string().url().optional(),
  hidden: z.boolean().optional(),
});

const updateAppBody = z
  .object({
    name: z.string().min(1).optional(),
    url: z.string().url().optional(),
    iconSlug: z.string().optional(),
    iconUrl: z.string().url().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

export const dashboardRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { db } = opts;

  app.get(
    "/api/dashboard",
    { preHandler: requirePermission({ app: ["read"] }) },
    async (request) => {
      const session = request.session;
      if (!session)
        throw new Error("unreachable: guard ensures session exists");

      const isAdmin = session.user.role === "admin";

      // Fetch all manual apps
      const allManualApps = await db.select().from(manualApps);

      // Fetch all monitors for apps
      const allAppMonitors = await db
        .select()
        .from(monitors)
        .where(eq(monitors.targetType, "app"));

      // Fetch latest check for each monitor - avoid N+1 by fetching all at once
      const monitorIds = allAppMonitors.map((m) => m.id);
      const latestChecks: Record<
        string,
        { up: boolean; at: number; error: string | null }
      > = {};

      if (monitorIds.length > 0) {
        const allChecks = await db
          .select()
          .from(checks)
          .where(inArray(checks.monitorId, monitorIds))
          .orderBy(desc(checks.at));

        // Group by monitor ID and keep only the latest
        for (const check of allChecks) {
          if (!latestChecks[check.monitorId]) {
            latestChecks[check.monitorId] = {
              up: check.up,
              at: check.at,
              error: check.error ?? null,
            };
          }
        }
      }

      // Get distinct app targetIds (both manual and project-backed)
      const appTargetIds = [...new Set(allAppMonitors.map((m) => m.targetId))];

      // The icon and description a project's tiles show. Read for every slug
      // at once rather than per tile: a dashboard is the one screen that holds
      // every app, so a per-tile read is a query per app on every poll.
      const identitySlugs = [
        ...new Set(
          appTargetIds
            .filter((id) => !id.startsWith("manual:"))
            .map((id) => id.slice(0, id.indexOf(":")))
            .filter((slug) => slug.length > 0),
        ),
      ];
      const identities = await readIdentities(db, identitySlugs);

      const apps: AppSummary[] = appTargetIds
        .map((targetId): AppSummary | null => {
          const appMonitors = allAppMonitors.filter(
            (m) => m.targetId === targetId,
          );

          const monitorLatest: MonitorLatest[] = appMonitors.map((m) => {
            const check = latestChecks[m.id];
            return {
              id: m.id,
              type: m.type as MonitorType,
              required: m.required,
              enabled: m.enabled,
              up: check?.up ?? null,
              error: check?.error ?? null,
              at: check?.at ?? null,
            };
          });

          const status = resolveStatus(monitorLatest);
          const { tier } = deriveTier(monitorLatest);
          const monitorSummaries = monitorLatest.map(toMonitorSummary);

          // Determine if this is a manual or project app
          if (targetId.startsWith("manual:")) {
            // Manual app
            const manualId = targetId.slice("manual:".length);
            const manualApp = allManualApps.find((app) => app.id === manualId);

            // Skip hidden manual apps
            if (!manualApp || manualApp.hidden) {
              return null;
            }

            return {
              key: targetId,
              source: "manual" as const,
              name: manualApp.name,
              projectSlug: null,
              service: null,
              hostPort: null,
              hostname: null,
              iconSlug: manualApp.iconSlug,
              iconUrl: manualApp.iconUrl,
              // `manual_apps` has no description column; a manual app is a
              // name and a URL.
              description: null,
              status,
              tier,
              monitors: monitorSummaries,
            };
          }

          // Project-backed app: targetId is "projectSlug:service"
          const colonIndex = targetId.indexOf(":");
          if (colonIndex === -1) {
            // Malformed targetId with no colon - skip this row
            return null;
          }
          const projectSlug = targetId.slice(0, colonIndex);
          const service = targetId.slice(colonIndex + 1);
          const identity = identities.get(projectSlug);

          // Get hostPort from the internal http monitor's URL.
          //
          // This read the tcp monitor's `port` until tcp stopped being
          // provisioned for apps. The http monitor is the one that now always
          // exists, and its loopback URL carries the same number.
          const httpMonitor = appMonitors.find((m) => m.type === "http");
          let hostPort: number | null = null;
          if (httpMonitor) {
            try {
              const config = JSON.parse(httpMonitor.config);
              const port = Number(new URL(config.url).port);
              hostPort = Number.isFinite(port) && port > 0 ? port : null;
            } catch {
              // Invalid config, leave as null
            }
          }

          // Get hostname from the dns monitor, falling back to the public
          // check's URL. The two carry it differently — dns stores a bare
          // hostname, reachability a full URL — so each needs its own read.
          let hostname: string | null = null;
          const dnsMonitor = appMonitors.find((m) => m.type === "dns");
          if (dnsMonitor) {
            try {
              hostname = JSON.parse(dnsMonitor.config).hostname ?? null;
            } catch {
              // Invalid config, leave as null
            }
          }
          if (!hostname) {
            const reachMonitor = appMonitors.find(
              (m) => m.type === "reachability",
            );
            if (reachMonitor) {
              try {
                hostname = new URL(JSON.parse(reachMonitor.config).url)
                  .hostname;
              } catch {
                // Invalid config, leave as null
              }
            }
          }

          return {
            key: targetId,
            source: "project" as const,
            name: service,
            projectSlug,
            service,
            hostPort,
            hostname,
            iconSlug: identity?.iconSlug ?? null,
            iconUrl: identity?.iconUrl ?? null,
            description: identity?.description ?? null,
            status,
            tier,
            monitors: monitorSummaries,
          };
        })
        .filter((app): app is AppSummary => app !== null);

      // Devices are admin-only
      let deviceList: DashboardDeviceSummary[] = [];
      if (isAdmin) {
        // Fetch all devices
        const allDevices = await db.select().from(devices);

        // Fetch all monitors for devices
        const allDeviceMonitors = await db
          .select()
          .from(monitors)
          .where(eq(monitors.targetType, "device"));

        // Fetch latest checks for device monitors
        const deviceMonitorIds = allDeviceMonitors.map((m) => m.id);
        const deviceLatestChecks: Record<
          string,
          { up: boolean; at: number; error: string | null }
        > = {};

        if (deviceMonitorIds.length > 0) {
          const deviceChecks = await db
            .select()
            .from(checks)
            .where(inArray(checks.monitorId, deviceMonitorIds))
            .orderBy(desc(checks.at));

          for (const check of deviceChecks) {
            if (!deviceLatestChecks[check.monitorId]) {
              deviceLatestChecks[check.monitorId] = {
                up: check.up,
                at: check.at,
                error: check.error ?? null,
              };
            }
          }
        }

        // Build DeviceSummary
        deviceList = allDevices.map((device) => {
          const deviceMonitors = allDeviceMonitors.filter(
            (m) => m.targetId === device.id,
          );

          const monitorLatest: MonitorLatest[] = deviceMonitors.map((m) => {
            const check = deviceLatestChecks[m.id];
            return {
              id: m.id,
              type: m.type as MonitorType,
              required: m.required,
              enabled: m.enabled,
              up: check?.up ?? null,
              error: check?.error ?? null,
              at: check?.at ?? null,
            };
          });

          const status = resolveStatus(monitorLatest);

          return {
            id: device.id,
            name: device.name,
            kind: device.kind,
            hidden: device.hidden,
            tailscaleNodeId: device.tailscaleNodeId,
            connectedToControl: device.connectedToControl,
            lastSeen: device.lastSeen,
            os: device.os,
            status,
          };
        });
      }

      // Count projects Homestead knows about
      let projectCount: number | null;
      try {
        const projects = await scanProjects(opts.projectsDir);
        projectCount = projects.length;
      } catch (_err) {
        // Directory unreadable - distinguish from "no projects"
        projectCount = null;
      }

      return { apps, devices: deviceList, projectCount };
    },
  );

  app.post(
    "/api/apps",
    { preHandler: requirePermission({ app: ["create"] }) },
    async (request, reply) => {
      const body = createAppBody.safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: "invalid_body" });

      const id = randomUUID();
      await db.insert(manualApps).values({
        id,
        name: body.data.name,
        url: body.data.url,
        iconSlug: body.data.iconSlug ?? null,
        iconUrl: body.data.iconUrl ?? null,
        hidden: body.data.hidden ?? false,
      });

      // Create exactly one required http monitor pointed at the URL
      const monitorId = randomUUID();
      await db.insert(monitors).values({
        id: monitorId,
        targetType: "app",
        targetId: `manual:${id}`,
        type: "http",
        config: JSON.stringify({ url: body.data.url }),
        intervalSeconds: 60,
        timeoutMs: 5000,
        retries: 0,
        required: true,
        enabled: true,
      });

      return reply.status(201).send({ id });
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/apps/:id",
    { preHandler: requirePermission({ app: ["update"] }) },
    async (request, reply) => {
      const { id } = request.params;

      const body = updateAppBody.safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: "invalid_body" });

      const [manualApp] = await db
        .select()
        .from(manualApps)
        .where(eq(manualApps.id, id));
      if (!manualApp) return reply.status(404).send({ error: "not_found" });

      const updates: Record<string, string | boolean | null> = {};
      if (body.data.name !== undefined) updates.name = body.data.name;
      if (body.data.url !== undefined) updates.url = body.data.url;
      if (body.data.iconSlug !== undefined)
        updates.iconSlug = body.data.iconSlug;
      if (body.data.iconUrl !== undefined) updates.iconUrl = body.data.iconUrl;
      if (body.data.hidden !== undefined) updates.hidden = body.data.hidden;

      if (Object.keys(updates).length > 0) {
        await db.update(manualApps).set(updates).where(eq(manualApps.id, id));
      }

      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/apps/:id",
    { preHandler: requirePermission({ app: ["delete"] }) },
    async (request, reply) => {
      const { id } = request.params;

      const [manualApp] = await db
        .select()
        .from(manualApps)
        .where(eq(manualApps.id, id));
      if (!manualApp) return reply.status(404).send({ error: "not_found" });

      // Delete monitors for this app (and their checks via cascade)
      const targetId = `manual:${id}`;
      const appMonitors = await db
        .select()
        .from(monitors)
        .where(
          and(eq(monitors.targetType, "app"), eq(monitors.targetId, targetId)),
        );

      for (const monitor of appMonitors) {
        await db.delete(checks).where(eq(checks.monitorId, monitor.id));
        await db.delete(monitors).where(eq(monitors.id, monitor.id));
      }

      await db.delete(manualApps).where(eq(manualApps.id, id));

      return { ok: true };
    },
  );

  app.get<{ Params: { key: string } }>(
    "/api/apps/:key/icon",
    { preHandler: requirePermission({ app: ["read"] }) },
    async (request, reply) => {
      const { key } = request.params;

      // Prevent path traversal - key should not contain path separators
      if (key.includes("/") || key.includes("\\") || key.includes("..")) {
        return reply.status(400).send({ error: "invalid_key" });
      }

      // Look up the app to get its iconSlug or iconUrl
      let iconSlug: string | null = null;
      let iconUrl: string | null = null;

      if (key.startsWith("manual:")) {
        const manualId = key.slice("manual:".length);
        const [manualApp] = await db
          .select()
          .from(manualApps)
          .where(eq(manualApps.id, manualId));
        if (!manualApp) {
          return reply.status(404).send({ error: "not_found" });
        }
        iconSlug = manualApp.iconSlug;
        iconUrl = manualApp.iconUrl;
      } else {
        // Project-backed app - no icon stored in DB
        // Icons for project apps would come from labels in compose, which we don't store
        // For now, project apps don't have icons
        return reply.status(404).send({ error: "not_found" });
      }

      // Determine cache key
      let cacheKey: string;
      if (iconSlug) {
        const sanitizedSlug = iconSlug.replace(/[^a-z0-9-]/g, "");
        if (sanitizedSlug.length === 0) {
          return reply.status(404).send({ error: "not_found" });
        }
        cacheKey = sanitizedSlug;
      } else if (iconUrl) {
        const hash = createHash("sha256").update(iconUrl).digest("hex");
        cacheKey = hash.substring(0, 16);
      } else {
        return reply.status(404).send({ error: "not_found" });
      }

      // Look for cached icon with supported extensions
      const iconsDir = join(opts.dataDir, "icons");
      const allowedExtensions = ["png", "jpeg", "jpg", "webp"];
      const contentTypeMap: Record<string, string> = {
        png: "image/png",
        jpeg: "image/jpeg",
        jpg: "image/jpeg",
        webp: "image/webp",
      };

      for (const ext of allowedExtensions) {
        const filename = `${cacheKey}.${ext}`;
        const requestedPath = join(iconsDir, filename);

        // Resolve symlinks and verify the real path is still within iconsDir
        let resolvedPath: string;
        let resolvedIconsDir: string;
        try {
          resolvedPath = await realpath(requestedPath);
          resolvedIconsDir = await realpath(iconsDir);
        } catch (err) {
          // ENOENT means file doesn't exist - try next extension
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          throw err;
        }

        if (
          !resolvedPath.startsWith(`${resolvedIconsDir}/`) &&
          resolvedPath !== resolvedIconsDir
        ) {
          continue; // Path traversal attempt - skip this file
        }

        try {
          const content = await readFile(resolvedPath);
          const contentType = contentTypeMap[ext];
          return reply
            .status(200)
            .header("Content-Type", contentType)
            .send(content);
        } catch (_err) {}
      }

      // No cached icon found
      return reply.status(404).send({ error: "not_found" });
    },
  );
};
