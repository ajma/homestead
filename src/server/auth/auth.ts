import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { accounts, sessions, users, verifications } from "../db/schema.js";

/** IP headers Better-Auth will read. Must be a subset of CLIENT_IP_HEADERS in app.ts. */
export const IP_ADDRESS_HEADERS = ["x-forwarded-for"] as const;

export function createAuth(config: Config, db: Db) {
  return betterAuth({
    baseURL: config.baseUrl,
    secret: config.secretKey.toString("base64"),
    trustedOrigins: config.trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    rateLimit: {
      // Explicit `enabled: true` so the guarantee does not depend on NODE_ENV. Without
      // this, an operator who copies `.env.example` (which ships with NODE_ENV=development)
      // gets no login rate limit, violating the design spec's Hygiene requirement.
      enabled: true,
    },
    user: {
      additionalFields: {
        // Server-owned. `input: false` prevents a request body from setting these.
        role: { type: "string", required: false, defaultValue: "viewer", input: false },
        scopeAllApps: { type: "boolean", required: false, defaultValue: true, input: false },
        disabledAt: { type: "number", required: false, input: false },
      },
    },
    advanced: {
      // Do NOT force useSecureCookies. Homestead is reachable over plain HTTP on
      // the LAN by design, and browsers withhold Secure cookies from such origins.
      ipAddress: {
        // Exactly one header, and `app.ts` guarantees the client cannot set it: it
        // strips every client-supplied IP header and substitutes Fastify's
        // `request.ip`, which already honours the narrowed trustProxy allowlist.
        ipAddressHeaders: [...IP_ADDRESS_HEADERS],
        // `trustedProxies` is deliberately NOT set. It exists for deployments where
        // Better-Auth parses a real forwarded chain, and here it would do harm twice
        // over. It cannot help: `auth.handler` receives a Web API Request with no
        // connection peer, so the option can only walk the header chain — measured, a
        // LAN client sending "203.0.113.99, 127.0.0.1" had that first entry persisted
        // as the session IP. And it would hurt: with a single authoritative entry, a
        // genuine loopback client's "127.0.0.1" would match the trusted list, be
        // skipped, and resolve to no IP at all — which drops Better-Auth's rate
        // limiter into one shared bucket for every such request.
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
