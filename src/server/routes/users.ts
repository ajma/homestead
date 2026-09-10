import { ROLES } from "@shared/types";
import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/context.js";
import { auditLog, userAppScope, users } from "../db/schema.js";

const createUserSchema = z.object({
  // z.email(), not z.string().email() — the latter is @deprecated in zod 4.
  email: z.email(),
  password: z.string().min(12),
  name: z.string().min(1),
  role: z.enum(ROLES),
  scopeAllApps: z.boolean().default(true),
  appIds: z.array(z.string()).default([]),
});

const publicUser = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  scopeAllApps: users.scopeAllApps,
  disabledAt: users.disabledAt,
  createdAt: users.createdAt,
};

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const { db, auth } = app.deps;

  const countUsers = async () => (await db.select({ id: users.id }).from(users)).length;

  async function audit(entry: {
    userId: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    detail?: unknown;
    ip?: string;
  }) {
    await db.insert(auditLog).values({
      id: ulid(),
      userId: entry.userId,
      authPath: entry.userId ? "password" : "system",
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      detail: (entry.detail ?? null) as never,
      ip: entry.ip ?? null,
    });
  }

  app.get("/api/setup/status", async () => ({ needsSetup: (await countUsers()) === 0 }));

  app.post("/api/setup/admin", async (request, reply) => {
    if ((await countUsers()) > 0) {
      return reply.code(409).send({ error: "already_initialised" });
    }
    const body = createUserSchema
      .pick({ email: true, password: true, name: true })
      .parse(request.body);

    const result = await auth.api.signUpEmail({ body, asResponse: true });
    if (!result.ok) return reply.code(result.status).send(await result.json());

    // Role is server-owned, so promote after creation rather than via the sign-up body.
    await db
      .update(users)
      .set({ role: "admin", scopeAllApps: true })
      .where(eq(users.email, body.email));
    const [row] = await db.select(publicUser).from(users).where(eq(users.email, body.email));
    await audit({
      userId: row?.id ?? null,
      action: "setup.admin_created",
      targetType: "user",
      targetId: row?.id,
    });

    for (const [key, value] of result.headers) {
      reply.header(key, value);
    }
    return reply.code(201).send(row);
  });

  app.get("/api/me", async (request) => {
    const ctx = requireAuth(request);
    const [row] = await db.select(publicUser).from(users).where(eq(users.id, ctx.userId));
    return { ...row, appIds: ctx.appIds };
  });

  app.get("/api/users", async (request) => {
    requireAdmin(request);
    return db.select(publicUser).from(users);
  });

  app.post("/api/users", async (request, reply) => {
    const ctx = requireAdmin(request);
    const body = createUserSchema.parse(request.body);

    const result = await auth.api.signUpEmail({
      body: { email: body.email, password: body.password, name: body.name },
      asResponse: true,
    });
    if (!result.ok) return reply.code(result.status).send(await result.json());

    await db
      .update(users)
      .set({ role: body.role, scopeAllApps: body.scopeAllApps })
      .where(eq(users.email, body.email));

    const [row] = await db.select(publicUser).from(users).where(eq(users.email, body.email));
    if (row && !body.scopeAllApps && body.appIds.length > 0) {
      await db.insert(userAppScope).values(body.appIds.map((appId) => ({ userId: row.id, appId })));
    }
    await audit({
      userId: ctx.userId,
      action: "user.created",
      targetType: "user",
      targetId: row?.id,
      detail: { role: body.role },
      ip: request.ip,
    });
    return reply.code(201).send(row);
  });

  app.patch("/api/users/:id", async (request, reply) => {
    const ctx = requireAdmin(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).optional(),
        role: z.enum(ROLES).optional(),
        scopeAllApps: z.boolean().optional(),
        disabled: z.boolean().optional(),
      })
      .parse(request.body);

    if (body.role === "viewer" || body.disabled === true) {
      const admins = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), ne(users.id, id)));
      if (admins.length === 0) return reply.code(409).send({ error: "last_admin" });
    }

    await db
      .update(users)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.scopeAllApps !== undefined ? { scopeAllApps: body.scopeAllApps } : {}),
        ...(body.disabled !== undefined
          ? // Milliseconds: `users` is a Better-Auth table and its other timestamps are ms.
            { disabledAt: body.disabled ? Date.now() : null }
          : {}),
      })
      .where(eq(users.id, id));

    await audit({
      userId: ctx.userId,
      action: "user.updated",
      targetType: "user",
      targetId: id,
      detail: body,
      ip: request.ip,
    });
    const [row] = await db.select(publicUser).from(users).where(eq(users.id, id));
    return row;
  });

  app.put("/api/users/:id/scope", async (request) => {
    const ctx = requireAdmin(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({ scopeAllApps: z.boolean(), appIds: z.array(z.string()).default([]) })
      .parse(request.body);

    await db.update(users).set({ scopeAllApps: body.scopeAllApps }).where(eq(users.id, id));
    await db.delete(userAppScope).where(eq(userAppScope.userId, id));
    if (!body.scopeAllApps && body.appIds.length > 0) {
      await db.insert(userAppScope).values(body.appIds.map((appId) => ({ userId: id, appId })));
    }
    await audit({
      userId: ctx.userId,
      action: "user.scope_set",
      targetType: "user",
      targetId: id,
      detail: body,
      ip: request.ip,
    });
    return { scopeAllApps: body.scopeAllApps, appIds: body.appIds };
  });

  app.delete("/api/users/:id", async (request, reply) => {
    const ctx = requireAdmin(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "admin"), ne(users.id, id)));
    if (admins.length === 0) return reply.code(409).send({ error: "last_admin" });

    await db.delete(users).where(eq(users.id, id));
    await audit({
      userId: ctx.userId,
      action: "user.deleted",
      targetType: "user",
      targetId: id,
      ip: request.ip,
    });
    return reply.code(204).send();
  });
}
