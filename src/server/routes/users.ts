import { ROLES } from "@shared/types";
import { and, eq, exists, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AuditContext, audit } from "../audit.js";
import { requireAdmin, requireAuth } from "../auth/context.js";
import { AccessPoliciesStore } from "../cloudflare/access-policies.js";
import { type CloudflareClient, createCloudflareClient } from "../cloudflare/client.js";
import { CloudflareCredentialStore } from "../cloudflare/credentials.js";
import { CloudflareError } from "../cloudflare/errors.js";
import { syncAccessUsers, syncAccessUsersExcluding } from "../cloudflare/sync-access-users.js";
import { userAppScope, users } from "../db/schema.js";

/**
 * Reads a `CloudflareError`'s fault off any thrown value, defaulting to `network` for
 * whatever isn't one — the same helper `routes/cloudflare.ts` defines for its own
 * Cloudflare-facing routes; duplicated here rather than shared because it's a one-line
 * classification, not shared logic worth a new module for two call sites.
 */
function faultOf(error: unknown): CloudflareError["fault"] {
  return error instanceof CloudflareError ? error.fault : "network";
}

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
  const credentialStore = new CloudflareCredentialStore(db, app.deps.secrets);
  const accessPoliciesStore = new AccessPoliciesStore(db, app.deps.secrets);

  const countUsers = async () => (await db.select({ id: users.id }).from(users)).length;

  /**
   * `null` when Access has never been configured on this installation — by far the most
   * common case, and the one Task 3's brief calls out as the most likely to be got wrong
   * and the most damaging: an installation that never touched Cloudflare must delete,
   * disable and create users exactly as it did before this phase, calling Cloudflare not at
   * all. Every mutation route below calls this FIRST and only proceeds to build a client and
   * touch Cloudflare when it returns non-null — so "not configured" isn't a fast exit taken
   * after already doing the work, it's the reason the work never starts.
   *
   * Requires BOTH `CloudflareCredentialStore` (the token) and `AccessPoliciesStore` (the
   * human policy id) — an install that saved credentials but whose `ensureAccessPolicies`
   * attempt never completed (or one where credentials were later cleared while a stale
   * policy id remained recorded) is treated the same as fully unconfigured, not as a
   * half-broken state to attempt and fail loudly on. Read fresh on every call, not cached at
   * `userRoutes` registration time, so credentials saved or cleared after startup take
   * effect on the very next request — the same reasoning `cloudflare-expose.ts` re-reads its
   * own stores per request rather than once.
   */
  async function accessSync(): Promise<{ client: CloudflareClient; policyId: string } | null> {
    const credentials = await credentialStore.get();
    if (!credentials) return null;
    const accessPolicies = await accessPoliciesStore.get();
    if (!accessPolicies) return null;
    const client = createCloudflareClient({
      token: credentials.token,
      accountId: credentials.accountId,
      fetch: app.deps.fetch,
    });
    return { client, policyId: accessPolicies.humanPolicyId };
  }

  /**
   * The blocking half of Ruling 2 (disable/delete must succeed in Cloudflare before the
   * local write), with the Critical fix from the whole-branch review: a recorded
   * `humanPolicyId` that Cloudflare no longer has must never be permanent. Before this
   * existed, `syncAccessUsersExcluding` throwing on a stale id turned into an unconditional
   * 502 on every future disable and delete — `store.get()` still reported "configured"
   * (nothing ever re-checked or cleared the id), so "Retry setup" was a no-op and the only
   * recovery was editing SQLite by hand. Reachable two ordinary ways: saving a different
   * Cloudflare account's credentials over an old one (closed by `clear()` now also clearing
   * this store — see `routes/cloudflare.ts`), or an admin deleting the policy itself in
   * Cloudflare's dashboard — which this half exists for.
   *
   * `getPolicy` (`client.ts`) — added this phase for exactly this question and never
   * called until now — answers "does the policy still exist" without a failed PUT's status
   * code standing in for it. `null` means Cloudflare has already stopped enforcing this
   * policy: it admits nobody, so there is nothing this removal can be blocked on, and
   * continuing to treat the stale id as configured only reproduces the lockout. Rather than
   * silently degrading, this clears `humanPolicyId` (not the whole store — the token and
   * monitor policy are still perfectly good) and audits the fact, which also repairs "Retry
   * setup": `AccessPoliciesStore.get()` now reports incomplete, so `ensureAccessPolicies`
   * takes the same `completeHumanPolicy` path a Phase-2 upgrade does, recreating only the
   * missing policy. Any OTHER failure (network, auth, rate limit, a genuine 5xx) still
   * blocks the removal — those don't tell us the policy is gone, only that this call
   * couldn't find out either way, and Ruling 2 says fail closed on that uncertainty.
   *
   * `null` return means "proceed with the local write"; anything else is the 502 body the
   * caller should send instead.
   */
  async function syncBeforeRemoval(
    sync: { client: CloudflareClient; policyId: string },
    ctx: AuditContext,
    excludeUserId: string,
  ): Promise<{ error: string; fault: CloudflareError["fault"] } | null> {
    let policy: { id: string; name: string } | null;
    try {
      policy = await sync.client.getPolicy(sync.policyId);
    } catch (error) {
      return { error: "cloudflare_error", fault: faultOf(error) };
    }

    if (policy === null) {
      await accessPoliciesStore.clearHumanPolicy();
      await audit(db, ctx, {
        action: "cloudflare.access_policy_missing",
        detail: { policyId: sync.policyId },
      });
      return null;
    }

    try {
      await syncAccessUsersExcluding({
        db,
        client: sync.client,
        policyId: sync.policyId,
        excludeUserId,
      });
      return null;
    } catch (error) {
      return { error: "cloudflare_error", fault: faultOf(error) };
    }
  }

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
    // Better-Auth lowercases email at signup — `users.email` is ALWAYS lowercase on the
    // row it just created — so every lookup below must compare against the same
    // normalisation, not the raw, possibly mixed-case body. Comparing against the raw
    // body here matched zero rows for e.g. `Bob@X.com`: the promotion UPDATE below found
    // nothing to promote and returned 409 even on the very first bootstrap, leaving a
    // permanently unpromoted viewer and no way to ever create an admin.
    const email = body.email.toLowerCase();

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
          eq(users.email, email),
          notExists(db.select({ ok: sql`1` }).from(otherUsers).where(eq(otherUsers.role, "admin"))),
        ),
      )
      .returning({ id: users.id });

    if (promoted.length === 0) return reply.code(409).send({ error: "already_initialised" });

    const [row] = await db.select(publicUser).from(users).where(eq(users.email, email));
    await audit(
      db,
      { userId: null, authPath: "system" },
      {
        action: "setup.admin_created",
        targetType: "user",
        targetId: row?.id,
      },
    );

    // Best-effort, and in practice never fires yet: Access cannot be configured before an
    // administrator exists (every Cloudflare route requires one), so `accessSync()` always
    // returns `null` here. Present anyway for the same reason the create/re-enable routes
    // below call this best-effort — adding access is never the operation that fails
    // (Ruling 2 covers removal specifically) — and so bootstrap does not silently diverge
    // from every other place a user is added the moment that ordering assumption ever stops
    // holding (a future re-bootstrap path, a restored backup with credentials already set).
    const sync = await accessSync();
    if (sync) {
      await syncAccessUsers({ db, client: sync.client, policyId: sync.policyId }).catch(() => {
        // Best-effort — see the comment above.
      });
    }

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
    const rows = await db.select(publicUser).from(users);

    // One query over the whole scope table, grouped in memory, rather than a
    // per-user query — the point of the fix this replaces (`EditScopeDialog`
    // could not show what it was editing because this endpoint carried no
    // `appIds` at all) is defeated if listing N users now costs N+1 queries.
    const scopeRows = await db
      .select({ userId: userAppScope.userId, appId: userAppScope.appId })
      .from(userAppScope);
    const appIdsByUser = new Map<string, string[]>();
    for (const { userId, appId } of scopeRows) {
      const appIds = appIdsByUser.get(userId);
      if (appIds) appIds.push(appId);
      else appIdsByUser.set(userId, [appId]);
    }

    return rows.map((row) => ({ ...row, appIds: appIdsByUser.get(row.id) ?? [] }));
  });

  app.post("/api/users", async (request, reply) => {
    const ctx = requireAdmin(request);
    const body = createUserSchema.parse(request.body);
    // Same normalisation as `/api/setup/admin` above, for the same reason: Better-Auth
    // stores email lowercase regardless of what was submitted, so comparing against the
    // raw body here matched zero rows for a mixed-case email — the role/scope UPDATE
    // silently applied to nothing, the created row stayed a default-role viewer, and the
    // SELECT below returned nothing, so the route answered 201 with an empty body.
    const email = body.email.toLowerCase();

    const result = await auth.api.signUpEmail({
      body: { email: body.email, password: body.password, name: body.name },
      asResponse: true,
    });
    if (!result.ok) return reply.code(result.status).send(await result.json());

    await db
      .update(users)
      .set({ role: body.role, scopeAllApps: body.scopeAllApps })
      .where(eq(users.email, email));

    const [row] = await db.select(publicUser).from(users).where(eq(users.email, email));
    if (row && !body.scopeAllApps && body.appIds.length > 0) {
      await db.insert(userAppScope).values(body.appIds.map((appId) => ({ userId: row.id, appId })));
    }
    // Best-effort, run AFTER the local write — Ruling 2 (Task 3's brief) covers removal
    // specifically: adding a user is never a security risk, so a Cloudflare hiccup here
    // must not fail an otherwise-successful account creation. This is deliberately a
    // different code path from disable/delete below, which block on Cloudflare success
    // BEFORE committing locally — see `accessSync`'s own doc comment on why "not
    // configured" short-circuits before either kind of call is ever attempted.
    const sync = await accessSync();
    if (sync) {
      await syncAccessUsers({ db, client: sync.client, policyId: sync.policyId }).catch(() => {
        // Best-effort — see the comment above.
      });
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

    // Ruling 2 (Task 3's brief): disabling a user must succeed in Cloudflare, or the
    // WHOLE operation fails, before the local disable is ever committed — never the
    // reverse, where the row is disabled here while Cloudflare Access still lets that
    // person into every exposed app. This runs BEFORE the guarded UPDATE below, computing
    // the post-disable email list as if the row were already disabled (`syncAccessUsers
    // Excluding`) rather than disabling first and reverting on failure: the alternative
    // ("disable, sync, undo the disable if the sync fails") is a plain column flip to
    // revert here — cheap — but the identical pattern for DELETE below is not, so both
    // routes use the same before-the-write ordering for consistency rather than one
    // routine doing it the easy way and the other the hard way.
    //
    // Only fires when the row is CURRENTLY enabled: an already-disabled user was never in
    // the policy (`enabledUserEmails`'s predicate), so disabling it again touches nothing
    // in Cloudflare and needs no call at all — including when Access is not configured,
    // where `accessSync()` returns `null` before any client is even built.
    if (body.disabled === true) {
      const [target] = await db
        .select({ role: users.role, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, id));
      if (!target) return reply.code(404).send({ error: "not_found" });

      if (target.disabledAt === null) {
        // Fast path, not a replacement for `lastActiveAdminIsSafe` on the UPDATE below —
        // the same "check-then-write can race, the WHERE clause is what actually
        // prevents it" distinction `/api/setup/admin`'s own `countUsers()` comment makes.
        // This exists purely to avoid the ordinary, non-racing case (an admin disabling
        // the sole remaining admin) from removing that person's Cloudflare access only to
        // then have the local disable itself refused.
        if (target.role === "admin") {
          const [otherAdmin] = await db
            .select({ id: otherUsers.id })
            .from(otherUsers)
            .where(
              and(
                eq(otherUsers.role, "admin"),
                ne(otherUsers.id, id),
                isNull(otherUsers.disabledAt),
              ),
            );
          if (!otherAdmin) return reply.code(409).send({ error: "last_admin" });
        }

        const sync = await accessSync();
        if (sync) {
          const failure = await syncBeforeRemoval(sync, ctx, id);
          if (failure) return reply.code(502).send(failure);
        }
      }
    }

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

    // Re-enabling restores access — not a security risk (Ruling 2 covers removal
    // specifically), so this runs best-effort AFTER the local write, the same as
    // creation above, rather than blocking on Cloudflare the way disabling does.
    if (body.disabled === false) {
      const sync = await accessSync();
      if (sync) {
        await syncAccessUsers({ db, client: sync.client, policyId: sync.policyId }).catch(() => {
          // Best-effort — see the comment above.
        });
      }
    }

    await audit(db, ctx, {
      action: "user.updated",
      targetType: "user",
      targetId: id,
      detail: body,
      ip: request.ip,
    });
    // `role`, `scopeAllApps`, and `disabled` are exactly the fields `AuthContext` is
    // evaluated against — `can`/`inScope` for the first two, and the `preHandler` gate
    // that rejects a disabled user for the third. Any of them can turn what an open SSE
    // stream shows into something the user should no longer see, or should not be able
    // to see at all, so any of them forces the reconnect. `name` changes none of that,
    // so a name-only edit must not close a stream over a rename.
    const changesAuthContext =
      body.role !== undefined || body.scopeAllApps !== undefined || body.disabled !== undefined;
    if (changesAuthContext) events.closeForUser(id);
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

    const [target] = await db
      .select({ role: users.role, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, id));
    if (!target) return reply.code(404).send({ error: "not_found" });

    // Same ordering as PATCH's disable path, and for the identical reason (Ruling 2,
    // Task 3's brief): the delete must succeed in Cloudflare, or the whole operation
    // fails, BEFORE the row is ever removed locally — never the reverse. Computed before
    // any local write rather than deleting-then-reverting-on-failure: `users` cascades to
    // `sessions`, `accounts` (the Better-Auth password credential) and `userAppScope`
    // (`schema.ts`), and reversing a committed delete cleanly would mean capturing and
    // reinserting all three tables' rows — see `sync-access-users.ts`'s own doc comment on
    // `syncAccessUsersExcluding` for why that is a materially riskier operation than never
    // committing the delete until Cloudflare has already accepted the post-removal state.
    //
    // Only fires when the row is CURRENTLY enabled — an already-disabled user was never in
    // the policy, so deleting it touches nothing in Cloudflare.
    if (target.disabledAt === null) {
      // Fast path, not a replacement for `lastActiveAdminIsSafe` on the DELETE below — see
      // PATCH's identical comment.
      if (target.role === "admin") {
        const [otherAdmin] = await db
          .select({ id: otherUsers.id })
          .from(otherUsers)
          .where(
            and(eq(otherUsers.role, "admin"), ne(otherUsers.id, id), isNull(otherUsers.disabledAt)),
          );
        if (!otherAdmin) return reply.code(409).send({ error: "last_admin" });
      }

      const sync = await accessSync();
      if (sync) {
        const failure = await syncBeforeRemoval(sync, ctx, id);
        if (failure) return reply.code(502).send(failure);
      }
    }

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
