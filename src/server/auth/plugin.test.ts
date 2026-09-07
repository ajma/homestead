import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { user } from "../db/schema.js";
import { tempDir } from "../test-support/tmp.js";
import { requirePermission } from "./guard.js";
import { type Auth, createAuth } from "./index.js";
import { toSessionWithUser } from "./plugin.js";

const TEST_AUTH = {
  secret: "test-secret-value-at-least-32-chars",
  baseURL: "http://localhost:7420",
};

let db: Db;
let auth: Auth;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  db = createDb(":memory:");
  await runMigrations(db);
  auth = createAuth(db, TEST_AUTH);
  const tmpDir = await tempDir("hs-test-");
  app = await buildApp({
    db,
    auth,
    secretKey: Buffer.alloc(32),
    projectsDir: tmpDir,
    projectsHostDir: tmpDir,
    dataDir: tmpDir,
  });
});

/** Signs in over HTTP and returns a Cookie header carrying the session. */
async function signInCookie(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : [String(raw)];
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

async function roleOf(email: string): Promise<string | null> {
  const [row] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.email, email));
  return row?.role ?? null;
}

describe("auth plugin", () => {
  it("mounts the Better-Auth handler", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
    });
    expect(res.statusCode).toBe(200);
  });

  it("leaves request.session null when unauthenticated", async () => {
    app.get("/api/_probe", async (req) => ({
      hasSession: req.session !== null,
    }));
    const res = await app.inject({ method: "GET", url: "/api/_probe" });
    expect(res.json()).toEqual({ hasSession: false });
  });

  it("blocks sign-up over HTTP (D1 guard)", async () => {
    // This guard blocks HTTP requests, but auth.api.signUpEmail() calls
    // from server code bypass Fastify routing entirely and remain unaffected.
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: {
        email: "test@example.com",
        password: "test-password-123",
        name: "Test User",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Sign-up is disabled" });
  });

  it("blocks sign-up with query params (D1 guard fixed)", async () => {
    // Finding 2: guard should not match query params
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/get-session?callbackURL=/sign-up",
    });
    expect(res.statusCode).toBe(200); // Should NOT be 403
  });

  it("HTTP sign-up guard leaves user table empty", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: {
        email: "blocked@example.com",
        password: "test-password-123",
        name: "Blocked User",
      },
    });
    // Verify no user was created
    const users = await db
      .select()
      .from((await import("../db/schema.js")).user);
    expect(users).toHaveLength(0);
  });

  it("allows server-side sign-up and sign-in round trip", async () => {
    // Server-side sign-up (bypasses Fastify guard)
    const signUpResult = await auth.api.signUpEmail({
      body: {
        email: "admin@example.com",
        password: "admin-password-123",
        name: "Admin User",
      },
    });
    expect(signUpResult).toBeDefined();
    expect(signUpResult.user).toBeDefined();
    expect(signUpResult.user.email).toBe("admin@example.com");

    // HTTP sign-in (through Fastify, not blocked)
    const signInRes = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: {
        email: "admin@example.com",
        password: "admin-password-123",
      },
    });
    expect(signInRes.statusCode).toBe(200);
    expect(signInRes.headers["set-cookie"]).toBeDefined();
  });
});

describe("session narrowing", () => {
  it("rejects values that do not carry a usable user", () => {
    expect(toSessionWithUser(null)).toBeNull();
    expect(toSessionWithUser(undefined)).toBeNull();
    expect(toSessionWithUser({})).toBeNull();
    // A re-nested session, as a Better-Auth upgrade might produce.
    expect(toSessionWithUser({ session: { user: { id: "u1" } } })).toBeNull();
    expect(toSessionWithUser({ user: { id: "u1" } })).toBeNull();
    expect(toSessionWithUser({ user: { id: 1, email: "a@b.c" } })).toBeNull();
    expect(
      toSessionWithUser({ user: { id: "u1", email: "a@b.c", role: 7 } }),
    ).toBeNull();
  });

  it("keeps a session whose role is absent so the guard can answer 403", () => {
    expect(toSessionWithUser({ user: { id: "u1", email: "a@b.c" } })).toEqual({
      user: { id: "u1", email: "a@b.c", role: undefined },
    });
  });
});

// I5: the guard used to be tested only against a synthetic session object, so
// a change in Better-Auth's real session shape would have gone unnoticed. This
// drives a genuine sign-in through buildApp and the auth plugin.
describe("requirePermission against a real Better-Auth session", () => {
  const ADMIN = { email: "admin@example.com", password: "admin-password-123" };
  const VIEWER = {
    email: "viewer@example.com",
    password: "viewer-password-123",
  };

  beforeEach(async () => {
    app.get(
      "/api/_guarded",
      { preHandler: requirePermission({ compose: ["write"] }) },
      async () => ({ ok: true }),
    );

    // Created exactly as the app creates them: the admin through the
    // first-run onboarding route, the viewer through a server-side sign-up
    // which picks up the admin plugin's defaultRole.
    const onboarding = await app.inject({
      method: "POST",
      url: "/api/onboarding/admin",
      payload: { ...ADMIN, name: "Admin" },
    });
    expect(onboarding.statusCode).toBe(200);

    await auth.api.signUpEmail({ body: { ...VIEWER, name: "Viewer" } });
  });

  it("assigns the roles the rest of this suite depends on", async () => {
    expect(await roleOf(ADMIN.email)).toBe("admin");
    expect(await roleOf(VIEWER.email)).toBe("viewer");
  });

  it("returns 401 for an anonymous request", async () => {
    const res = await app.inject({ method: "GET", url: "/api/_guarded" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a signed-in viewer", async () => {
    const cookie = await signInCookie(VIEWER.email, VIEWER.password);
    const res = await app.inject({
      method: "GET",
      url: "/api/_guarded",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 200 for a signed-in admin", async () => {
    const cookie = await signInCookie(ADMIN.email, ADMIN.password);
    const res = await app.inject({
      method: "GET",
      url: "/api/_guarded",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
