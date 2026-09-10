import type { Capability } from "@shared/capabilities";
import { roleHas } from "@shared/capabilities";
import type { Role } from "@shared/types";
import { inArray, type SQL, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { apps } from "../db/schema.js";

export type AuthContext = {
  userId: string;
  email: string;
  role: Role;
  scopeAllApps: boolean;
  appIds: string[];
  authPath: "password" | "access";
};

export class UnauthorizedError extends Error {
  statusCode = 401;
  constructor() {
    super("Authentication required");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  statusCode = 403;
  constructor(capability: Capability) {
    super(`Missing capability: ${capability}`);
    this.name = "ForbiddenError";
  }
}

export function can(ctx: AuthContext, capability: Capability): boolean {
  return roleHas(ctx.role, capability);
}

export function inScope(ctx: AuthContext, appId: string): boolean {
  return ctx.scopeAllApps || ctx.appIds.includes(appId);
}

export function canForApp(ctx: AuthContext, capability: Capability, appId: string): boolean {
  return can(ctx, capability) && inScope(ctx, appId);
}

/**
 * The single scope predicate. Every app-reading query composes this, including
 * the SSE fan-out — the path most likely to drift from the REST path.
 */
export function visibleAppsWhere(ctx: AuthContext): SQL | undefined {
  if (ctx.scopeAllApps) return undefined;
  if (ctx.appIds.length === 0) return sql`1 = 0`;
  return inArray(apps.id, ctx.appIds);
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new UnauthorizedError();
  return request.auth;
}

export function requireCapability(request: FastifyRequest, capability: Capability): AuthContext {
  const ctx = requireAuth(request);
  if (!can(ctx, capability)) throw new ForbiddenError(capability);
  return ctx;
}

export function requireAdmin(request: FastifyRequest): AuthContext {
  const ctx = requireAuth(request);
  if (ctx.role !== "admin") throw new ForbiddenError("user:manage");
  return ctx;
}
