import Fastify, { type FastifyInstance } from "fastify";
import type { Auth } from "./auth/index.js";
import { authPlugin } from "./auth/plugin.js";
import type { Db } from "./db/client.js";
import { onboardingRoutes } from "./routes/onboarding.js";

export type AppDeps = { db: Db; auth: Auth };

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(authPlugin, { auth: deps.auth });
  await app.register(onboardingRoutes, { db: deps.db, auth: deps.auth });
  app.get("/api/health", async () => ({ status: "ok" }));
  return app;
}
