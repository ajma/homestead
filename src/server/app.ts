import fastifyStatic from "@fastify/static";
import type { PreflightResult } from "@shared/preflight.js";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Auth } from "./auth/index.js";
import { authPlugin } from "./auth/plugin.js";
import type { CloudflareClient } from "./cloudflare/client.js";
import type { Db } from "./db/client.js";
import type { DockerRunner } from "./docker/run.js";
import { createRegistry } from "./ops/registry.js";
import { cloudflareRoutes } from "./routes/cloudflare.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { deviceRoutes } from "./routes/devices.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { operationRoutes } from "./routes/operations.js";
import { preflightRoutes } from "./routes/preflight.js";
import { projectRoutes } from "./routes/projects.js";
import { statusRoutes } from "./routes/status.js";
import type { TailscaleClient } from "./tailscale/client.js";

export type AppDeps = {
  db: Db;
  auth: Auth;
  secretKey: Buffer;
  /**
   * Enable Fastify's request logger. Off by default so unit tests stay quiet;
   * the real server turns it on, otherwise `request.log` is a no-op and every
   * server-side error is written nowhere.
   */
  logger?: boolean;
  projectsDir: string;
  projectsHostDir: string;
  dataDir: string;
  /**
   * The only way this app reaches `docker`. Defaults to the real one; tests
   * pass a fake so no test outside `*.integration.test.ts` can spawn a child
   * process, let alone reconcile a compose project on the host.
   */
  docker?: DockerRunner;
  /**
   * Tailscale client factory. Injected so tests never reach the network.
   */
  tailscale?: (opts: { tailnet: string; token: string }) => TailscaleClient;
  /**
   * Cloudflare client factory. Injected so tests never reach the network.
   */
  cloudflare?: (opts: { token: string }) => CloudflareClient;
  /**
   * Directory holding the built SPA. When set, the server serves those files
   * and falls back to `index.html` for unknown non-API paths (client routing).
   * Unset in development, where Vite runs separately.
   */
  webDir?: string;
  /**
   * Preflight check results computed at startup. When absent, the route returns
   * an empty list. Tests never run real checks, so they hold `[]` by default.
   */
  preflight?: PreflightResult[];
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
  await app.register(preflightRoutes, { preflight: deps.preflight ?? [] });
  await app.register(dashboardRoutes, {
    db: deps.db,
    projectsDir: deps.projectsDir,
    dataDir: deps.dataDir,
  });
  await app.register(deviceRoutes, {
    db: deps.db,
    secretKey: deps.secretKey,
    tailscale: deps.tailscale,
  });
  await app.register(cloudflareRoutes, {
    db: deps.db,
    secretKey: deps.secretKey,
    cloudflare: deps.cloudflare,
    projectsDir: deps.projectsDir,
    docker: deps.docker,
  });
  // One registry for both plugins: its per-slug lock is only a lock if delete
  // and the lifecycle verbs contend for the same one.
  const registry = createRegistry(deps.db);
  await app.register(projectRoutes, {
    db: deps.db,
    projectsDir: deps.projectsDir,
    projectsHostDir: deps.projectsHostDir,
    dataDir: deps.dataDir,
    registry,
    docker: deps.docker,
  });
  await app.register(operationRoutes, {
    projectsDir: deps.projectsDir,
    projectsHostDir: deps.projectsHostDir,
    dataDir: deps.dataDir,
    registry,
    docker: deps.docker,
  });
  app.get("/api/health", async () => ({ status: "ok" }));

  // Serve the built SPA in production; unset in development, where Vite runs
  // separately. The notFoundHandler sends `index.html` for unknown non-API
  // paths (client routing), but keeps a JSON 404 for `/api/*` and for non-GET
  // methods (a mistyped POST should not get an HTML page with a 200 status).
  if (deps.webDir) {
    await app.register(fastifyStatic, { root: deps.webDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(200).type("text/html").sendFile("index.html");
    });
  }

  return app;
}
