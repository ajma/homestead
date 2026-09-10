import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { accounts, sessions, users, verifications } from "../db/schema.js";

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
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
        // Better-Auth reads these headers itself, independently of Fastify's
        // trustProxy. Without a trusted-proxy list it would believe them from any
        // peer, re-opening inside auth exactly the forgery that narrowing Fastify's
        // trustProxy closes — and auth is where a forged IP does the most damage,
        // since it keys rate limiting on login.
        trustedProxies: config.trustedProxies,
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
