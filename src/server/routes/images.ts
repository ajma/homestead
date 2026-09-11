import type { ImageStatusRow } from "@shared/admin.js";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireCapability } from "../auth/context.js";
import { imageStatus } from "../db/schema.js";
import { loadApp } from "./apps.js";

export async function imageRoutes(app: FastifyInstance): Promise<void> {
  const { db, images } = app.deps;

  app.get("/api/apps/:id/images", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const rows = await db.select().from(imageStatus).where(eq(imageStatus.appId, id));
    return rows satisfies ImageStatusRow[];
  });

  app.post("/api/apps/:id/images/check", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    await images.check(row);
    const rows = await db.select().from(imageStatus).where(eq(imageStatus.appId, id));
    return rows satisfies ImageStatusRow[];
  });
}
