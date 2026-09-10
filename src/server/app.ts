import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { Auth } from "./auth/auth.js";
import type { Config } from "./config.js";
import type { SecretStore } from "./crypto/secrets.js";
import type { Db } from "./db/client.js";
import type { Host } from "./host/types.js";
import { healthRoutes } from "./routes/health.js";

export type AppDeps = { config: Config; db: Db; host: Host; secrets: SecretStore; auth: Auth };

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

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, deps.config.baseUrl);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(","));
      }
      const response = await deps.auth.handler(
        new Request(url, {
          method: request.method,
          headers,
          body: request.method === "GET" ? undefined : JSON.stringify(request.body),
        }),
      );
      reply.status(response.status);
      for (const [key, value] of response.headers) {
        reply.header(key, value);
      }
      return reply.send(response.body ? await response.text() : null);
    },
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
