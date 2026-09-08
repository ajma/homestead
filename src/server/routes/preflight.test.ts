import type { PreflightResult } from "@shared/preflight.js";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { user } from "../db/schema.js";
import { createFakeDocker } from "../docker/fake.js";
import { tempDir } from "../test-support/tmp.js";

const TEST_AUTH = {
  secret: "test-secret-value-at-least-32-chars",
  baseURL: "http://localhost:7420",
};

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let auth: ReturnType<typeof createAuth>;
let root: string;
let adminCookie: string;
let viewerCookie: string;

const baseDeps = () => ({
  db,
  auth,
  secretKey: Buffer.alloc(32),
  projectsDir: root,
  projectsHostDir: root,
  dataDir: root,
  docker: createFakeDocker().runner,
});

/** Server-side sign-in: bypasses the HTTP rate limiter (5/min per file). */
async function signIn(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie returned");
  const [sessionCookie] = cookie.split(";");
  if (!sessionCookie) throw new Error("malformed session cookie");
  return sessionCookie;
}

beforeEach(async () => {
  root = await tempDir();
  db = createDb(":memory:");
  await runMigrations(db);
  auth = createAuth(db, TEST_AUTH);

  const a = await auth.api.signUpEmail({
    body: {
      email: "admin@example.com",
      name: "Admin",
      password: "correct-horse-battery",
    },
  });
  await db.update(user).set({ role: "admin" }).where(eq(user.id, a.user.id));
  await auth.api.signUpEmail({
    body: {
      email: "viewer@example.com",
      name: "Viewer",
      password: "correct-horse-battery",
    },
  });
  adminCookie = await signIn("admin@example.com", "correct-horse-battery");
  viewerCookie = await signIn("viewer@example.com", "correct-horse-battery");
});

afterEach(async () => {
  if (app) await app.close();
});

const failing: PreflightResult[] = [
  {
    id: "data_dir_local_fs",
    label: "Data directory is on a local filesystem",
    ok: false,
    detail: "/data is on a network filesystem",
    severity: "danger",
  },
];

it("returns the results it was given", async () => {
  app = await buildApp({ ...baseDeps(), preflight: failing });
  const res = await app.inject({
    method: "GET",
    url: "/api/preflight",
    headers: { cookie: adminCookie },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().checks).toEqual(failing);
});

it("returns an empty list when no checks were run", async () => {
  app = await buildApp(baseDeps());
  const res = await app.inject({
    method: "GET",
    url: "/api/preflight",
    headers: { cookie: adminCookie },
  });
  expect(res.json().checks).toEqual([]);
});

it("refuses a viewer", async () => {
  // Homestead holds the Docker socket. Its environment is not viewer business.
  app = await buildApp({ ...baseDeps(), preflight: failing });
  const res = await app.inject({
    method: "GET",
    url: "/api/preflight",
    headers: { cookie: viewerCookie },
  });
  expect(res.statusCode).toBe(403);
});

it("refuses an anonymous request", async () => {
  app = await buildApp({ ...baseDeps(), preflight: failing });
  const res = await app.inject({ method: "GET", url: "/api/preflight" });
  expect(res.statusCode).toBe(401);
});

it("leaves /api/status unauthenticated and free of preflight detail", async () => {
  // The login page reads /api/status before anyone has signed in.
  app = await buildApp({ ...baseDeps(), preflight: failing });
  const res = await app.inject({ method: "GET", url: "/api/status" });
  expect(res.statusCode).toBe(200);
  expect(res.body).not.toContain("network filesystem");
  expect(res.json()).not.toHaveProperty("preflight");
});
