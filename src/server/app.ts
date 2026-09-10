import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { ComposeConfigCache } from "./apps/compose-config.js";
import type { JobRunner } from "./apps/job-runner.js";
import type { Auth } from "./auth/auth.js";
import type { Config } from "./config.js";
import type { SecretStore } from "./crypto/secrets.js";
import type { Db } from "./db/client.js";
import { userAppScope, users } from "./db/schema.js";
import type { Host } from "./host/types.js";
import { appRoutes } from "./routes/apps.js";
import { containerRoutes } from "./routes/containers.js";
import { healthRoutes } from "./routes/health.js";
import { jobRoutes } from "./routes/jobs.js";
import { logRoutes } from "./routes/logs.js";
import { spaRoutes } from "./routes/spa.js";
import { userRoutes } from "./routes/users.js";

/** Headers a client must never be able to set on the request Better-Auth sees. */
export const CLIENT_IP_HEADERS = new Set(["x-forwarded-for", "x-real-ip", "cf-connecting-ip"]);

/**
 * Builds headers for Better-Auth with client-supplied IP headers stripped and replaced
 * with exactly one authoritative value from Fastify's `request.ip`.
 *
 * Client-supplied IP headers are DROPPED, never forwarded. Better-Auth resolves the
 * client IP from headers alone — `auth.handler` takes a Web API Request, which carries
 * no connection peer, so its `trustedProxies` option can only walk the forwarded chain
 * and cannot check who actually connected. Measured: a LAN peer sending
 *   X-Forwarded-For: 203.0.113.99, 127.0.0.1
 * had Better-Auth persist 203.0.113.99 as the session IP, because the walk skips the
 * trusted tail and returns the first untrusted entry.
 *
 * Fastify has already computed the real peer in `request.ip`, honouring the narrowed
 * `trustProxy` allowlist. So we substitute exactly one authoritative value and let
 * nothing the client sent survive.
 */
function buildForwardedHeaders(
  requestHeaders: Record<string, string | string[] | undefined>,
  authoritativeIp: string,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (CLIENT_IP_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(","));
  }
  headers.set("x-forwarded-for", authoritativeIp);
  return headers;
}

export type AppDeps = {
  config: Config;
  db: Db;
  host: Host;
  secrets: SecretStore;
  auth: Auth;
  composeConfig: ComposeConfigCache;
  jobs: JobRunner;
};

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
      const headers = buildForwardedHeaders(request.headers, request.ip);
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

  app.addHook("preHandler", async (request) => {
    const headers = buildForwardedHeaders(request.headers, request.ip);
    const session = await deps.auth.api.getSession({ headers });
    if (!session?.user) return;

    const [row] = await deps.db.select().from(users).where(eq(users.id, session.user.id));
    if (!row || row.disabledAt !== null) return;

    const scopeRows = row.scopeAllApps
      ? []
      : await deps.db
          .select({ appId: userAppScope.appId })
          .from(userAppScope)
          .where(eq(userAppScope.userId, row.id));

    request.auth = {
      userId: row.id,
      email: row.email,
      role: row.role,
      scopeAllApps: row.scopeAllApps,
      appIds: scopeRows.map((s) => s.appId),
      authPath: "password",
    };
  });

  // Custom error handler MUST be registered BEFORE route plugins. Fastify child contexts
  // capture the parent's error handler at registration time, so a handler declared after
  // `app.register(...)` does not apply inside those routes — they keep the default, which
  // leaks raw error details to clients (including unredacted SQL and Zod schema dumps).
  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, "request failed");

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_failed",
        message: "Request validation failed",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({
      error: status === 500 ? "internal_error" : (error as Error).name,
      message: status === 500 ? "Internal server error" : (error as Error).message,
    });
  });

  await app.register(healthRoutes);
  await app.register(userRoutes);
  await app.register(appRoutes);
  await app.register(jobRoutes);
  await app.register(logRoutes);
  await app.register(containerRoutes);
  await app.register(spaRoutes);

  return app;
}
