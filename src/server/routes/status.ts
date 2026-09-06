import { count } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../db/client.js";
import { user } from "../db/schema.js";

export const statusRoutes: FastifyPluginAsync<{ db: Db }> = async (
  app,
  { db },
) => {
  app.get("/api/status", async () => {
    const [row] = await db.select({ n: count() }).from(user);
    return { initialised: (row?.n ?? 0) > 0 };
  });
};
