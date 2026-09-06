import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import type { Db } from "../db/client.js";
import { ac, roles } from "./permissions.js";

export type AuthOptions = { secret: string; baseURL: string };

export function createAuth(db: Db, opts: AuthOptions) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite" }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    plugins: [
      admin({ ac, roles, defaultRole: "viewer", adminRoles: ["admin"] }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
