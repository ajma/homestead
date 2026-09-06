import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import type { Db } from "../db/client.js";
import { ac, roles } from "./permissions.js";

export type AuthOptions = {
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
};

export function createAuth(db: Db, opts: AuthOptions) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite" }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: opts.trustedOrigins,
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    // Set explicitly rather than relying on Better-Auth's default, which only
    // enables rate limiting when NODE_ENV === "production". Nothing in this
    // project sets NODE_ENV, so the default leaves sign-in unthrottled against
    // an account that is root-equivalent on the host.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
    advanced: {
      // Better-Auth skips the Origin check whenever NODE_ENV === "test".
      // Pinning it off keeps the check identical in tests and in production,
      // for the same reason `secret` and `baseURL` are explicit parameters:
      // security behaviour must not depend on an ambient environment variable.
      disableOriginCheck: false,
      ipAddress: {
        // Do not derive the rate-limit key from any client-supplied header.
        // Better-Auth trusts `x-forwarded-for` by default with no trusted-proxy
        // list, so an attacker could rotate that header and get a fresh
        // sign-in bucket per request, defeating the limit above. With no
        // trusted header the limiter falls back to one shared bucket per path,
        // which throttles brute force at the cost of being global.
        ipAddressHeaders: [],
      },
    },
    plugins: [
      admin({ ac, roles, defaultRole: "viewer", adminRoles: ["admin"] }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
