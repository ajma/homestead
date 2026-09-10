import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { SecretStore } from "./crypto/secrets.js";
import type { Db } from "./db/client.js";
import type { Host } from "./host/types.js";
import { healthRoutes } from "./routes/health.js";

export type AppDeps = { config: Config; db: Db; host: Host; secrets: SecretStore };

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.config.nodeEnv !== "test",
    // NEVER `trustProxy: true`. That believes X-Forwarded-For from any peer, and
    // Homestead is reachable on the LAN by design — so any LAN client could forge
    // `request.ip`, poisoning audit records and defeating IP-keyed rate limiting by
    // rotating the header. Trust only the tunnel's own origin: cloudflared runs with
    // network_mode: host and reaches Homestead over loopback, while LAN clients
    // connect from a LAN address and are therefore not believed.
    trustProxy: deps.config.trustedProxies,
  });

  app.decorate("deps", deps);

  await app.register(cookie);
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    // Explicit so the trust boundary is visible at the point it matters. `request.ip`
    // is only meaningful because trustProxy is narrowed above.
    keyGenerator: (request) => request.ip,
  });

  await app.register(healthRoutes);

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found", path: request.url });
    }
    return reply.code(404).send({ error: "not_found" });
  });

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({
      error: status === 500 ? "internal_error" : (error as Error).name,
      message: status === 500 ? "Internal server error" : (error as Error).message,
    });
  });

  return app;
}
