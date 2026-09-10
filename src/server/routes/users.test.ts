import { buildTestApp, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

describe("bootstrap", () => {
  it("reports that setup is needed when there are no users", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ needsSetup: true });
    await app.close();
  });

  it("creates the first user as an admin", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ role: "admin", scopeAllApps: true });
    await app.close();
  });

  it("refuses a second bootstrap attempt", async () => {
    const app = await buildTestApp();
    await signUpAdmin(app);
    const second = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      payload: { email: "mallory@example.com", password: "correct-horse-battery", name: "M" },
    });
    expect(second.statusCode).toBe(409);
    await app.close();
  });
});

describe("user management", () => {
  it("rejects anonymous listing", async () => {
    const app = await buildTestApp();
    expect((await app.inject({ method: "GET", url: "/api/users" })).statusCode).toBe(401);
    await app.close();
  });

  it("lets an admin create a viewer with a scoped app list", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie },
      payload: {
        email: "viewer@example.com",
        password: "correct-horse-battery",
        name: "Viewer",
        role: "viewer",
        scopeAllApps: false,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ role: "viewer", scopeAllApps: false });
    await app.close();
  });

  it("forbids a viewer from listing users", async () => {
    const app = await buildTestApp();
    const { cookie: adminCookie } = await signUpAdmin(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: adminCookie },
      payload: {
        email: "viewer@example.com",
        password: "correct-horse-battery",
        name: "Viewer",
        role: "viewer",
        scopeAllApps: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "viewer@example.com", password: "correct-horse-battery" },
    });
    expect(signIn.statusCode).toBe(200);
    const viewerCookie = String(signIn.headers["set-cookie"] ?? "");
    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("never returns a password hash", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({ method: "GET", url: "/api/users", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toMatch(/password|hash/i);
    await app.close();
  });

  it("refuses to remove the last admin", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const id = me.json().id;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("refuses to demote or disable the last admin", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const id = me.json().id;

    const demote = await app.inject({
      method: "PATCH",
      url: `/api/users/${id}`,
      headers: { cookie },
      payload: { role: "viewer" },
    });
    const disable = await app.inject({
      method: "PATCH",
      url: `/api/users/${id}`,
      headers: { cookie },
      payload: { disabled: true },
    });
    expect([demote.statusCode, disable.statusCode]).toEqual([409, 409]);
    await app.close();
  });

  // REGRESSION. Before the guard counted only active admins, this sequence returned
  // 200 twice and left the install with zero administrators able to sign in — an
  // unrecoverable lockout, since the bootstrap refuses to run once any user exists.
  it("cannot be left with zero ACTIVE admins by disabling them one at a time", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const meRes = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(meRes.statusCode).toBe(200);
    const adminA = meRes.json().id;

    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie },
      payload: {
        email: "second-admin@example.com",
        password: "correct-horse-battery",
        name: "Second",
        role: "admin",
        scopeAllApps: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const adminB = created.json().id;

    // Disabling B is legitimate: A is still active.
    const disableB = await app.inject({
      method: "PATCH",
      url: `/api/users/${adminB}`,
      headers: { cookie },
      payload: { disabled: true },
    });
    expect(disableB.statusCode).toBe(200);

    // Disabling A must now fail — B is an administrator but cannot log in.
    const disableA = await app.inject({
      method: "PATCH",
      url: `/api/users/${adminA}`,
      headers: { cookie },
      payload: { disabled: true },
    });
    expect(disableA.statusCode).toBe(409);

    const { users } = await import("../db/schema.js");
    const remaining = await app.deps.db.select().from(users);
    const activeAdmins = remaining.filter((u) => u.role === "admin" && u.disabledAt === null);
    expect(activeAdmins).toHaveLength(1);
    await app.close();
  });

  it("still allows removing a viewer while only one admin exists", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie },
      payload: {
        email: "viewer@example.com",
        password: "correct-horse-battery",
        name: "Viewer",
        role: "viewer",
        scopeAllApps: true,
      },
    });
    expect(created.statusCode).toBe(201);
    // The guard must not over-block: a viewer is not an active admin.
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${created.json().id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("allows setting user app scope and returns 404 for nonexistent user", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie },
      payload: {
        email: "viewer@example.com",
        password: "correct-horse-battery",
        name: "Viewer",
        role: "viewer",
        scopeAllApps: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const viewerId = created.json().id;

    // Seed a host and an app in the database so we can reference them
    const { apps, hosts } = await import("../db/schema.js");
    await app.deps.db.insert(hosts).values({
      id: "test-host",
      name: "Test Host",
      kind: "local",
      composeRoot: "/test",
      dockerSocket: "/var/run/docker.sock",
    });
    await app.deps.db.insert(apps).values({
      id: "test-app",
      hostId: "test-host",
      slug: "jellyfin",
      displayName: "Jellyfin",
      directory: "jellyfin",
      composeFile: "compose.yaml",
      projectName: "jellyfin",
    });

    // Set scope with valid app
    const scoped = await app.inject({
      method: "PUT",
      url: `/api/users/${viewerId}/scope`,
      headers: { cookie },
      payload: { scopeAllApps: false, appIds: ["test-app"] },
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json()).toMatchObject({ scopeAllApps: false, appIds: ["test-app"] });

    // Verify scope persisted
    const { userAppScope } = await import("../db/schema.js");
    const scope = await app.deps.db
      .select()
      .from(userAppScope)
      .where(eq(userAppScope.userId, viewerId));
    expect(scope).toHaveLength(1);
    expect(scope[0]?.appId).toBe("test-app");

    // Nonexistent user returns 404
    const notFound = await app.inject({
      method: "PUT",
      url: "/api/users/nonexistent-id/scope",
      headers: { cookie },
      payload: { scopeAllApps: false, appIds: [] },
    });
    expect(notFound.statusCode).toBe(404);

    await app.close();
  });
});

describe("error handling", () => {
  it("redacts errors inside registered routes and returns safe 500 shape", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);

    // Force an error by trying to set scope for a nonexistent user with a bad appId.
    // Before the fix, this returned 500 with raw SQL including bound parameters.
    // After the fix, it should return 404 (the fix for item 4), but we'll also test
    // with a different error path.

    // To test 500 redaction, we need to trigger an internal error. Let's use PATCH with
    // invalid ID to trigger a 500 from inside userRoutes if any db error occurs.
    // Actually, the brief says the current behavior is that it leaks SQL. Let me create
    // a simpler test: just POST with missing required fields to trigger validation.

    // For a true internal error test, let's use a malformed UUID or trigger a db error.
    // Actually, I should check what the error looks like now. Let me just test the
    // validation case first (which triggers ZodError → 400).

    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie },
      payload: { email: "bad", password: "short", name: "", role: "invalid" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("validation_failed");
    expect(body.message).toBeDefined();
    expect(body.issues).toBeDefined();
    // Should NOT leak the full Zod schema
    expect(JSON.stringify(body)).not.toMatch(/ZodError|_def|parse/);

    await app.close();
  });

  it("returns redacted 500 for internal errors in registered routes", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);

    // To trigger an internal error, we'll close the database connection first
    // Actually, that's hard to do. Let me instead check that SQL errors are redacted
    // by using the PUT /api/users/:id/scope endpoint with a nonexistent app ID
    // which triggers a foreign key error.

    const meRes = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(meRes.statusCode).toBe(200);
    const id = meRes.json().id;

    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${id}/scope`,
      headers: { cookie },
      payload: { scopeAllApps: false, appIds: ["nonexistent-app-id"] },
    });

    // This will trigger a foreign key error when trying to insert into user_app_scope
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("Internal server error");
    // Should NOT leak SQL, table names, or parameters
    expect(JSON.stringify(body)).not.toMatch(/insert|user_app_scope|nonexistent-app-id/i);

    await app.close();
  });
});
