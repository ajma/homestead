import { count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { settings, user } from "../db/schema.js";
import { tempDir } from "../test-support/tmp.js";

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let auth: ReturnType<typeof createAuth>;

const body = {
  email: "admin@example.com",
  name: "Admin",
  password: "correct-horse-battery",
};
const TEST_AUTH = {
  secret: "test-secret-value-at-least-32-chars",
  baseURL: "http://localhost:7420",
};

beforeEach(async () => {
  db = createDb(":memory:");
  await runMigrations(db);
  auth = createAuth(db, TEST_AUTH);
  const tmpDir = await tempDir("hs-test-");
  app = await buildApp({
    db,
    auth,
    projectsDir: tmpDir,
    projectsHostDir: tmpDir,
    dataDir: tmpDir,
  });
});

describe("POST /api/onboarding/admin", () => {
  it("creates the first user with the admin role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboarding/admin",
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(user);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("admin");
  });

  it("refuses a second call", async () => {
    await app.inject({
      method: "POST",
      url: "/api/onboarding/admin",
      payload: body,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/onboarding/admin",
      payload: { ...body, email: "attacker@example.com" },
    });
    expect(res.statusCode).toBe(409);
    expect((await db.select({ n: count() }).from(user))[0]?.n).toBe(1);
  });

  it("admits exactly one of many concurrent callers", async () => {
    const attempts = Array.from({ length: 8 }, (_, i) =>
      app.inject({
        method: "POST",
        url: "/api/onboarding/admin",
        payload: { ...body, email: `race${i}@example.com` },
      }),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect((await db.select({ n: count() }).from(user))[0]?.n).toBe(1);
  });

  it("rejects invalid input (weak password)", async () => {
    const weak = await app.inject({
      method: "POST",
      url: "/api/onboarding/admin",
      payload: { ...body, password: "short" },
    });
    expect(weak.statusCode).toBe(400);
    const good = await app.inject({
      method: "POST",
      url: "/api/onboarding/admin",
      payload: body,
    });
    expect(good.statusCode).toBe(200);
  });

  it("releases the claim when signup fails after claiming", async () => {
    // Seed an existing user with a specific email
    await auth.api.signUpEmail({
      body: {
        email: "existing@example.com",
        name: "Existing",
        password: "existing-password-12",
      },
    });

    // Attempt to create admin with the same email - claim is taken, then signUpEmail fails
    const res = await app.inject({
      method: "POST",
      url: "/api/onboarding/admin",
      payload: { ...body, email: "existing@example.com" },
    });
    expect(res.statusCode).toBe(400);

    // Verify the sentinel row is actually gone from settings table
    const sentinelRow = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "admin_bootstrap_claimed"));
    expect(sentinelRow).toHaveLength(0);

    // Verify a subsequent valid request with a different email succeeds
    const retry = await app.inject({
      method: "POST",
      url: "/api/onboarding/admin",
      payload: body,
    });
    expect(retry.statusCode).toBe(200);
    expect((await db.select({ n: count() }).from(user))[0]?.n).toBe(2);
  });
});
