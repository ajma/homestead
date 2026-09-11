import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inScope, requireCapability } from "../auth/context.js";
import { apps } from "../db/schema.js";
import { appHealth } from "../launcher/health.js";
import { launcherApps } from "../launcher/query.js";

export async function launcherRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get("/api/launcher", async (request) => {
    const ctx = requireCapability(request, "app:read");
    return { apps: await launcherApps(db, ctx) };
  });

  app.get("/api/launcher/:appId/health", async (request, reply) => {
    const ctx = requireCapability(request, "app:read");
    const { appId } = z.object({ appId: z.string() }).parse(request.params);

    // Scope first, and answer 404 rather than 403: a scoped viewer must not learn that
    // an app they cannot see exists. This mirrors what the probe routes already do.
    if (!inScope(ctx, appId)) return reply.code(404).send({ error: "not_found" });

    // Same filters `launcherApps` applies for the grid: a hidden or archived app is not
    // on the launcher, and this route should not disagree about what "on the launcher"
    // means just because it looks the app up directly by id instead of listing them all.
    const [row] = await db
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.id, appId), eq(apps.showOnLauncher, true), isNull(apps.archivedAt)));
    if (!row) return reply.code(404).send({ error: "not_found" });

    return appHealth(db, appId, Math.floor(Date.now() / 1000));
  });
}
