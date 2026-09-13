import { BlockList, isIP } from "node:net";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { eq, sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AppLock } from "./apps/app-lock.js";
import type { ComposeConfigCache } from "./apps/compose-config.js";
import type { ImageUpdateChecker } from "./apps/image-updates.js";
import type { JobRunner } from "./apps/job-runner.js";
import type { StepJobRunner } from "./apps/step-job-runner.js";
import { ACCESS_JWT_HEADER, type JwksFetcher, verifyAccessJwt } from "./auth/access-plugin.js";
import { resolveAccessSettings } from "./auth/access-settings.js";
import type { Auth } from "./auth/auth.js";
import type { AuthContext } from "./auth/context.js";
import type { TunnelConfigLock } from "./cloudflare/expose.js";
import type { Config } from "./config.js";
import type { SecretStore } from "./crypto/secrets.js";
import type { Db } from "./db/client.js";
import { userAppScope, users } from "./db/schema.js";
import type { PreflightResult } from "./host/preflight.js";
import type { Host } from "./host/types.js";
import type { IconMetadata } from "./icons/metadata.js";
import type { IconStore } from "./icons/store.js";
import type { Scheduler } from "./monitoring/scheduler.js";
import { appRoutes } from "./routes/apps.js";
import { cloudflareRoutes } from "./routes/cloudflare.js";
import { cloudflareExposeRoutes } from "./routes/cloudflare-expose.js";
import { cloudflareTunnelRoutes } from "./routes/cloudflare-tunnel.js";
import { containerRoutes } from "./routes/containers.js";
import type { EventBus } from "./routes/events.js";
import { eventRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { iconRoutes } from "./routes/icons.js";
import { imageRoutes } from "./routes/images.js";
import { jobRoutes } from "./routes/jobs.js";
import { launcherRoutes } from "./routes/launcher.js";
import { logRoutes } from "./routes/logs.js";
import { probeRoutes } from "./routes/probes.js";
import { setupRoutes } from "./routes/setup.js";
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

/**
 * Builds an `AuthContext` from a `users` row — shared by both preHandler hooks below
 * (the password session hook and the Access assertion hook), since resolving scope is
 * identical for either sign-in path; only `authPath` and how the row was found differ.
 */
async function authContextFrom(
  db: Db,
  row: typeof users.$inferSelect,
  authPath: AuthContext["authPath"],
): Promise<AuthContext> {
  const scopeRows = row.scopeAllApps
    ? []
    : await db
        .select({ appId: userAppScope.appId })
        .from(userAppScope)
        .where(eq(userAppScope.userId, row.id));

  return {
    userId: row.id,
    email: row.email,
    role: row.role,
    scopeAllApps: row.scopeAllApps,
    appIds: scopeRows.map((s) => s.appId),
    authPath,
  };
}

/**
 * A `JwksFetcher` for `verifyAccessJwt` built from `deps.fetch` rather than the
 * global `fetch` its own `defaultFetcher` would use — the same injection every other
 * outbound call in this file and `index.ts` goes through, so a test's fake `fetch`
 * covers this path too and no test needs a real network call to exercise it.
 */
function accessJwksFetcher(fetchImpl: typeof fetch, teamDomain: string): JwksFetcher {
  return async () => {
    const res = await fetchImpl(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Failed to fetch Access JWKS: ${res.status}`);
    return (await res.json()) as { keys: import("jose").JWK[] };
  };
}

/**
 * Builds the fields logged when an Access assertion is rejected — deliberately NOT the
 * error object itself. `jose`'s claim-validation errors (`JWTClaimValidationFailed`,
 * `JWTExpired`) attach the token's fully decoded payload as an own enumerable
 * `.payload` property, and pino's default `err` serializer copies every own-enumerable
 * property of an error onto the log record, so logging `{ err }` directly would write
 * out `email`, `sub`, `identity_nonce`, `country`, `iss` and `aud` in full. This
 * reports only what diagnoses a misconfiguration — the error's identity, and, for an
 * audience mismatch specifically (the mistake operators make most often), the
 * configured `aud` against the one the token actually carried — never the rest of the
 * claim set.
 */
export function accessRejectionLogFields(
  err: unknown,
  expectedAud: string,
): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };

  const base: Record<string, unknown> = {
    name: err.name,
    code: (err as { code?: string }).code,
    message: err.message,
  };

  const claim = (err as { claim?: string }).claim;
  const payload = (err as { payload?: { aud?: unknown } }).payload;
  if (claim === "aud" && payload) {
    return { ...base, expectedAud, actualAud: payload.aud };
  }
  return base;
}

/**
 * True when `remoteAddress` — the connection's immediate TCP peer, not `request.ip` —
 * is trusted per `config.trustedProxies`.
 *
 * Deliberately the raw peer, not `request.ip`. `request.ip` is what `trustProxy`
 * (registered above) resolves the address TO once it decides to believe forwarded
 * headers — for genuine tunnel traffic that is typically the original visitor's own
 * address, which is never in `trustedProxies`. The raw peer is exactly the fact
 * `trustProxy` itself consults to decide whether to trust that hop at all. cloudflared
 * runs with `network_mode: host` and connects over loopback (`trustedProxies`'
 * default), so a request that reaches Homestead with cloudflared nowhere in the chain —
 * a LAN client hitting the port directly — has its OWN address as the raw peer, never
 * the loopback address the tunnel connects from.
 *
 * This now genuinely matches what `trustProxy` does, which a plain `includes()` did
 * not: Fastify compiles `trustProxy`'s allowlist with `@fastify/proxy-addr`, which
 * accepts CIDR ranges (`10.0.0.0/8`) and treats an IPv4-mapped IPv6 peer
 * (`::ffff:127.0.0.1`) as equal to its IPv4 form (`127.0.0.1`) — neither of which a
 * string-set membership test can do. `@fastify/proxy-addr` is not a direct dependency
 * of this project (it arrives only transitively through Fastify; pnpm's strict
 * `node_modules` layout means `require.resolve('@fastify/proxy-addr')` fails from this
 * package's own root, confirmed), so importing it directly would be a phantom import.
 * Node's own `net.BlockList` performs the identical CIDR/address-family matching
 * without adding anything: it ships in `node:net`, which Fastify's own request
 * handling already depends on.
 *
 * A destroyed socket can report `remoteAddress` as `undefined`; that — and any
 * unparseable configuration entry — fails CLOSED here, not open.
 */
export function isTrustedProxyAddress(
  remoteAddress: string | undefined,
  trustedProxies: string[],
): boolean {
  if (!remoteAddress) return false;

  const peerFamily = isIP(remoteAddress);
  if (peerFamily === 0) return false;

  const trusted = new BlockList();
  for (const entry of trustedProxies) {
    const slashIndex = entry.indexOf("/");
    const address = slashIndex === -1 ? entry : entry.slice(0, slashIndex);
    const family = isIP(address);
    if (family === 0) continue; // Malformed configuration entries are never trusted.

    const maxPrefix = family === 4 ? 32 : 128;
    const prefix = slashIndex === -1 ? maxPrefix : Number(entry.slice(slashIndex + 1));
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) continue;

    trusted.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }

  return trusted.check(remoteAddress, peerFamily === 4 ? "ipv4" : "ipv6");
}

export type AppDeps = {
  config: Config;
  db: Db;
  host: Host;
  secrets: SecretStore;
  auth: Auth;
  composeConfig: ComposeConfigCache;
  jobs: JobRunner;
  /** Registered here, unused by any route until 2C/2D wires one up — the same shape
   * `jobs` has, so those routes can reach it the same way. Shares its `AppLock` with
   * `jobs` at construction (see `index.ts`/`test-helpers.ts`), which is what makes a step
   * sequence and a compose job exclude each other on the same app. */
  stepJobs: StepJobRunner;
  /** The SAME instance `jobs` and `stepJobs` were constructed with (see
   * `index.ts`/`test-helpers.ts`) — exposed directly here too so a route that needs to
   * exclude itself against an app's in-flight job WITHOUT going through `JobRunner` or
   * `StepJobRunner`'s own `start` can still do so. `cloudflare-expose.ts`'s DELETE route
   * is the first: it has no step sequence of its own to hand to `stepJobs.start`, but
   * still must not run concurrently with that same app's expose job (2D's whole-branch
   * review, F7). */
  appLock: AppLock;
  images: ImageUpdateChecker;
  scheduler: Scheduler;
  events: EventBus;
  icons: { metadata: IconMetadata; store: IconStore };
  preflight: () => Promise<PreflightResult>;
  /** Used to build a `CloudflareClient` per request from whatever credentials are
   * currently stored — see `routes/cloudflare.ts`. A plain function property, like
   * `preflight` above, so tests can override it wholesale without a second injection
   * mechanism. */
  fetch: typeof globalThis.fetch;
  /** ONE instance shared by every concurrent expose in the process — see its own doc
   * comment in `cloudflare/expose.ts` for why this is a different lock from `AppLock`
   * (per-tunnel and global, not per-app) and must not be constructed fresh per request,
   * which would serialise nothing. */
  tunnelConfigLock: TunnelConfigLock;
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

    request.auth = await authContextFrom(deps.db, row, "password");
  });

  /**
   * §7's Access sign-in path: on a request carrying `Cf-Access-Jwt-Assertion` with no
   * active session, verify the assertion and resolve it to a user. Registered as a
   * SECOND `preHandler` — after, not instead of, the password hook above — so it never
   * runs at all once a password session has already set `request.auth`. That ordering
   * is what makes a garbage or forged `Cf-Access-Jwt-Assertion` header harmless against
   * an existing password session: this hook returns on its very first line before ever
   * looking at the header.
   *
   * Every other guard here fails CLOSED, silently, rather than throwing or partially
   * authenticating:
   *
   * - The request did not arrive via a trusted proxy (`isTrustedProxyAddress`, above):
   *   see that function's own doc comment. §6/§9 draw the line at cloudflared —
   *   "externally exposed apps remain reachable on the LAN without passing through
   *   Access" — which makes an Access assertion presented directly on the LAN
   *   meaningless: Cloudflare never evaluated its policy for this request, so revoking
   *   someone from the Access application would not take effect until the bearer token
   *   they copied out of their browser happens to expire. Rejecting it here, before the
   *   header is even read, keeps this indistinguishable from "no header at all".
   * - `resolveAccessSettings` unresolved (2E Task 2 — nothing marks an app
   *   `systemKind: "self"` yet, and no environment override either) means Access is not
   *   configured for this deployment. The header is ignored ENTIRELY, not partially
   *   honoured — and this returns exactly the way "no header at all" does, so a probing
   *   caller cannot distinguish "not configured" from "bad token" from the response.
   * - `verifyAccessJwt` throwing (bad signature, wrong issuer, expired, OR — the check
   *   that matters most, see that function's own doc comment — an `aud` naming a
   *   DIFFERENT Access application in the same Cloudflare account) rejects the same way.
   *   The reason is logged at `debug` (never the token) so a mistyped team domain is
   *   diagnosable instead of silent.
   * - No Homestead user with the asserted email (compared case-insensitively, since the
   *   IdP behind Access is not this database and has no reason to agree on case): NOT
   *   auto-provisioned. Cloudflare Access admits whoever its own policy admits;
   *   deciding who becomes a Homestead user is the admin's call, made through user
   *   management, not implied by a JWT claim this code did not choose to trust with
   *   that decision.
   * - A disabled user's row: rejected, the same as the password hook just above (Phase
   *   1C's carry-forward: a stale `AuthContext` must not keep a disabled user's streams
   *   open, and that applies identically to a freshly-verified Access assertion).
   */
  app.addHook("preHandler", async (request) => {
    if (request.auth) return;

    if (!isTrustedProxyAddress(request.socket.remoteAddress, deps.config.trustedProxies)) return;

    const header = request.headers[ACCESS_JWT_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token) return;

    const settings = await resolveAccessSettings({ db: deps.db, config: deps.config });
    if (!settings) return;

    let email: string;
    try {
      ({ email } = await verifyAccessJwt({
        token,
        teamDomain: settings.teamDomain,
        aud: settings.aud,
        fetchJwks: accessJwksFetcher(deps.fetch, settings.teamDomain),
      }));
    } catch (err) {
      // `debug`, not `warn`: an unauthenticated caller controls how often this fires,
      // and `warn` would let them drive log volume. Deliberately NOT `{ err }`: jose's
      // claim-validation errors carry the token's full decoded payload — email, sub,
      // identity_nonce, country, iss, aud — as an own enumerable `.payload` property,
      // and pino's default `err` serializer walks every own-enumerable property onto
      // the log record, so `{ err }` would write the whole claim set out even though
      // nothing here asked for it. None of that is secret (it's the cleartext body of
      // a JWT the caller already presented), but it is more identifying detail than a
      // debug line needs. `accessRejectionLogFields` reports only what diagnoses a
      // misconfiguration: the error's name/code/message, and — for the audience check
      // specifically, since a mismatched team's `aud` is the mistake operators most
      // often make — the expected value against what the token actually carried.
      request.log.debug(accessRejectionLogFields(err, settings.aud), "access assertion rejected");
      return;
    }

    const [row] = await deps.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`);
    if (!row || row.disabledAt !== null) return;

    request.auth = await authContextFrom(deps.db, row, "access");
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
  await app.register(imageRoutes);
  await app.register(probeRoutes);
  await app.register(cloudflareRoutes);
  await app.register(cloudflareTunnelRoutes);
  await app.register(cloudflareExposeRoutes);
  await app.register(eventRoutes);
  await app.register(launcherRoutes);
  await app.register(iconRoutes);
  await app.register(setupRoutes);
  await app.register(spaRoutes);

  return app;
}
