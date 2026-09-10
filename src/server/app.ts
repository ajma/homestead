import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { Auth } from "./auth/auth.js";
import type { Config } from "./config.js";
import type { SecretStore } from "./crypto/secrets.js";
import type { Db } from "./db/client.js";
import type { Host } from "./host/types.js";
import { healthRoutes } from "./routes/health.js";

/** Headers a client must never be able to set on the request Better-Auth sees. */
const CLIENT_IP_HEADERS = new Set(["x-forwarded-for", "x-real-ip", "cf-connecting-ip"]);

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

      // Client-supplied IP headers are DROPPED, never forwarded.
      //
      // Better-Auth resolves the client IP from headers alone — `auth.handler` takes a
      // Web API Request, which carries no connection peer, so its `trustedProxies`
      // option can only walk the forwarded chain and cannot check who actually
      // connected. Measured: a LAN peer sending
      //   X-Forwarded-For: 203.0.113.99, 127.0.0.1
      // had Better-Auth persist 203.0.113.99 as the session IP, because the walk skips
      // the trusted tail and returns the first untrusted entry.
      //
      // Fastify has already computed the real peer in `request.ip`, honouring the
      // narrowed `trustProxy` allowlist. So we substitute exactly one authoritative
      // value and let nothing the client sent survive.
      for (const [key, value] of Object.entries(request.headers)) {
        if (CLIENT_IP_HEADERS.has(key.toLowerCase())) continue;
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(","));
      }
      headers.set("x-forwarded-for", request.ip);
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
