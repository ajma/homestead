import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { createAuth } from "./index.js";

const TEST_AUTH = {
  secret: "test-secret-value-at-least-32-chars",
  baseURL: "http://localhost:7420",
};

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  db = createDb(":memory:");
  await runMigrations(db);
  app = await buildApp({ db, auth: createAuth(db, TEST_AUTH) });
});

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
    const auth = createAuth(db, TEST_AUTH);

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
