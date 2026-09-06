import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Auth } from "./auth/index.js";
import { authPlugin } from "./auth/plugin.js";
import type { Db } from "./db/client.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { statusRoutes } from "./routes/status.js";

export type AppDeps = {
  db: Db;
  auth: Auth;
  /**
   * Enable Fastify's request logger. Off by default so unit tests stay quiet;
   * the real server turns it on, otherwise `request.log` is a no-op and every
   * server-side error is written nowhere.
   */
  logger?: boolean;
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });

  // Log the real error server-side, return a generic body to the client. 4xx
  // errors (validation, bad JSON) are client-caused and safe to describe, so
  // they keep Fastify's default representation; only 5xx is masked, because
  // those messages can carry filesystem paths and database internals.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.status(status).send(error);
    request.log.error({ err: error }, "unhandled request error");
    return reply.status(status).send({ error: "internal_error" });
  });

  await app.register(authPlugin, { auth: deps.auth });
  await app.register(onboardingRoutes, { db: deps.db, auth: deps.auth });
  await app.register(statusRoutes, { db: deps.db });
  app.get("/api/health", async () => ({ status: "ok" }));
  return app;
}
