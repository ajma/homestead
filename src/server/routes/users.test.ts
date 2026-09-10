import { buildTestApp } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

async function signUpAdmin(app: Awaited<ReturnType<typeof buildTestApp>>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    payload: { email: "admin@example.com", password: "correct-horse-battery", name: "Admin" },
  });
  const cookie = String(res.headers["set-cookie"] ?? "");
  return { res, cookie };
}

describe("bootstrap", () => {
  it("reports that setup is needed when there are no users", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(res.json()).toMatchObject({ needsSetup: true });
    await app.close();
  });

  it("creates the first user as an admin", async () => {
    const app = await buildTestApp();
    const { res, cookie } = await signUpAdmin(app);
    expect(res.statusCode).toBeLessThan(400);
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
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
    await app.inject({
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
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "viewer@example.com", password: "correct-horse-battery" },
    });
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
    expect(JSON.stringify(res.json())).not.toMatch(/password|hash/i);
    await app.close();
  });

  it("refuses to remove the last admin", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
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
    const id = (await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).json().id;

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
    const adminA = (await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).json()
      .id;

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
    // The guard must not over-block: a viewer is not an active admin.
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${created.json().id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });
});
