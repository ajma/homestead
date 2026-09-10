import { ROLES } from "@shared/types";
import { and, eq, exists, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { requireAdmin, requireAuth } from "../auth/context.js";
import { userAppScope, users } from "../db/schema.js";

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

/** Self-join alias, needed to reference `users` inside a subquery on `users`. */
const otherUsers = alias(users, "other_users");

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const { db, auth, events } = app.deps;

  const countUsers = async () => (await db.select({ id: users.id }).from(users)).length;

  /**
   * SQL condition guarding the invariant "at least one administrator can still log in".
   *
   * Two properties, both learned the hard way:
   *
   * 1. It counts only ACTIVE admins (`disabled_at IS NULL`). Counting disabled ones let
   *    an operator disable admin B, then disable admin A, and be left with zero admins
   *    who can sign in — measured, both requests returned 200. Recovery from that state
   *    means editing SQLite by hand, because the bootstrap has permanently closed.
   * 2. It is a CONDITION on the mutating statement, not a preceding SELECT. A
   *    check-then-write pair can interleave with a concurrent one — two requests each
   *    removing a different admin can both observe the other and both proceed.
   *
   * The row being mutated also satisfies the guard when it is not itself an active
   * admin, so deleting or disabling a viewer is never blocked by it.
   */
  const lastActiveAdminIsSafe = (targetId: string) =>
    or(
      // Some OTHER administrator remains who can still log in.
      exists(
        db
          .select({ ok: sql`1` })
          .from(otherUsers)
          .where(
            and(
              eq(otherUsers.role, "admin"),
              ne(otherUsers.id, targetId),
              isNull(otherUsers.disabledAt),
            ),
          ),
      ),
      // Or this row is not an active administrator, so removing it strips nothing.
      ne(users.role, "admin"),
      isNotNull(users.disabledAt),
    );

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
    //
    // The promotion is CONDITIONAL on no administrator existing yet, in one statement.
    // The `countUsers()` check above is a fast path, not a guard: `signUpEmail` awaits,
    // so two concurrent bootstraps can both pass it and both create a user. Making the
    // UPDATE itself conditional means exactly one can win, whatever the interleaving.
    // The loser's account survives as a viewer — an unwanted row an admin can delete,
    // not an unwanted administrator. Reverting a promotion after the fact would not be
    // equivalent: the loser would already hold a session cookie for an admin account.
    const promoted = await db
      .update(users)
      .set({ role: "admin", scopeAllApps: true })
      .where(
        and(
          eq(users.email, body.email),
          notExists(db.select({ ok: sql`1` }).from(otherUsers).where(eq(otherUsers.role, "admin"))),
        ),
      )
      .returning({ id: users.id });

    if (promoted.length === 0) return reply.code(409).send({ error: "already_initialised" });

    const [row] = await db.select(publicUser).from(users).where(eq(users.email, body.email));
    await audit(
      db,
      { userId: null, authPath: "system" },
      {
        action: "setup.admin_created",
        targetType: "user",
        targetId: row?.id,
      },
    );

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
    await audit(db, ctx, {
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

    // Demoting or disabling can strip the last administrator, so those two changes carry
    // the guard as part of the UPDATE itself rather than as a preceding SELECT.
    const stripsAdminPowers = body.role === "viewer" || body.disabled === true;

    const updated = await db
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
      .where(
        stripsAdminPowers ? and(eq(users.id, id), lastActiveAdminIsSafe(id)) : eq(users.id, id),
      )
      .returning({ id: users.id });

    if (updated.length === 0) {
      const [exists_] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
      return exists_
        ? reply.code(409).send({ error: "last_admin" })
        : reply.code(404).send({ error: "not_found" });
    }

    await audit(db, ctx, {
      action: "user.updated",
      targetType: "user",
      targetId: id,
      detail: body,
      ip: request.ip,
    });
    // Role is what `inScope`/`can` are evaluated against; changing it can turn what an
    // open SSE stream shows into something the user should no longer see. Only a role
    // change forces the reconnect — a name-only edit changes nothing it evaluates.
    if (body.role !== undefined) events.closeForUser(id);
    const [row] = await db.select(publicUser).from(users).where(eq(users.id, id));
    return row;
  });

  app.put("/api/users/:id/scope", async (request, reply) => {
    const ctx = requireAdmin(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({ scopeAllApps: z.boolean(), appIds: z.array(z.string()).default([]) })
      .parse(request.body);

    const updated = await db
      .update(users)
      .set({ scopeAllApps: body.scopeAllApps })
      .where(eq(users.id, id))
      .returning({ id: users.id });

    if (updated.length === 0) {
      return reply.code(404).send({ error: "not_found" });
    }

    await db.delete(userAppScope).where(eq(userAppScope.userId, id));
    if (!body.scopeAllApps && body.appIds.length > 0) {
      await db.insert(userAppScope).values(body.appIds.map((appId) => ({ userId: id, appId })));
    }
    await audit(db, ctx, {
      action: "user.scope_set",
      targetType: "user",
      targetId: id,
      detail: body,
      ip: request.ip,
    });
    // A narrowed scope must not let an already-open stream keep emitting events for apps
    // it no longer covers; a widened one just reconnects once, which is harmless.
    events.closeForUser(id);
    return { scopeAllApps: body.scopeAllApps, appIds: body.appIds };
  });

  app.delete("/api/users/:id", async (request, reply) => {
    const ctx = requireAdmin(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const deleted = await db
      .delete(users)
      .where(and(eq(users.id, id), lastActiveAdminIsSafe(id)))
      .returning({ id: users.id });

    if (deleted.length === 0) {
      const [exists_] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
      return exists_
        ? reply.code(409).send({ error: "last_admin" })
        : reply.code(404).send({ error: "not_found" });
    }

    await audit(db, ctx, {
      action: "user.deleted",
      targetType: "user",
      targetId: id,
      ip: request.ip,
    });
    // A deleted user's open stream must not outlive the account it was opened under.
    events.closeForUser(id);
    return reply.code(204).send();
  });
}
