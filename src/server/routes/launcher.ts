import type { FastifyInstance } from "fastify";
import { requireCapability } from "../auth/context.js";
import { launcherApps } from "../launcher/query.js";

export async function launcherRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get("/api/launcher", async (request) => {
    const ctx = requireCapability(request, "app:read");
    return { apps: await launcherApps(db, ctx) };
  });
}
