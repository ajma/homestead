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
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        // Reading the session is not an authentication attempt, and must not
        // be throttled as if it were.
        //
        // Better-Auth buckets per path, and — because `ipAddressHeaders` is
        // deliberately empty below — every client shares one bucket. So the
        // 60/minute above was 60 session reads a minute *for the whole
        // household*, and the SPA issues one on every page load. Two people
        // with a few tabs open, or one browser reloading a dashboard, spend
        // that budget in under a minute and are then bounced to the login
        // screen by a 429 that looks exactly like a revoked session. Running
        // the e2e suite at two viewports is simply the first workload large
        // enough to make it reproducible.
        //
        // Relaxing this costs nothing defensively: a session token is 32
        // bytes of entropy presented in a cookie, so there is no credential
        // to guess here, and the endpoint discloses nothing to a caller who
        // does not already hold one. The limits that do guard a guessable
        // secret — `/sign-in/email` above, and Better-Auth's built-in rules
        // for `/sign-up`, `/change-password` and the password-reset paths —
        // are untouched. This stays bounded rather than disabled so a
        // runaway client still cannot spin the server.
        "/get-session": { window: 60, max: 600 },
      },
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
