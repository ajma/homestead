import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { user } from "../db/schema.js";

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

/** Server-side sign-in: bypasses the HTTP rate limiter (5/min per file). */
async function signIn(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie returned");
  return cookie.split(";")[0]!;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hs-routes-"));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(
    join(root, "media", "docker-compose.yml"),
    "name: media\nservices:\n  web:\n    image: nginx\n",
  );

  db = createDb(":memory:");
  await runMigrations(db);
  auth = createAuth(db, TEST_AUTH);
  app = await buildApp({
    db,
    auth,
    projectsDir: root,
    projectsHostDir: root,
    dataDir: root,
  });

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

describe("GET /api/projects", () => {
  it("lists discovered projects for an admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().projects.map((p: { slug: string }) => p.slug)).toEqual([
      "media",
    ]);
  });

  it("requires a session", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/projects" })).statusCode,
    ).toBe(401);
  });
});

describe("GET /api/projects/:slug", () => {
  it("returns detail with states and snapshots for an admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/media",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.slug).toBe("media");
    expect(body.model).toBeTruthy();
    expect(Array.isArray(body.states)).toBe(true);
    expect(Array.isArray(body.snapshots)).toBe(true);
  });

  it("denies a viewer because project detail exposes service and port inventory", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/media",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("surfaces a broken compose file as parseError rather than failing the route", async () => {
    await writeFile(
      join(root, "media", "docker-compose.yml"),
      "this is not valid yaml: {{{\n",
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/media",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.slug).toBe("media");
    expect(body.model).toBeNull();
    expect(typeof body.parseError).toBe("string");
    expect(body.parseError).toBeTruthy();
  });
});

describe("compose file access", () => {
  it("lets an admin read the compose file", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/media/file/compose",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toContain("image: nginx");
  });

  it("denies a viewer, because .env and compose hold passwords", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/media/file/compose",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("writes and snapshots on PUT", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/projects/media/file/compose",
      headers: { cookie: adminCookie },
      payload: {
        content: "name: media\nservices:\n  web:\n    image: caddy\n",
      },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({
      method: "GET",
      url: "/api/projects/media/file/compose",
      headers: { cookie: adminCookie },
    });
    expect(get.json().content).toContain("caddy");
    const detail = await app.inject({
      method: "GET",
      url: "/api/projects/media",
      headers: { cookie: adminCookie },
    });
    expect(detail.json().snapshots.length).toBe(1);
  });

  it("denies a viewer writing", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/media/file/compose",
      headers: { cookie: viewerCookie },
      payload: { content: "services: {}\n" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an unknown file name", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/media/file/secrets",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a traversal slug without touching the filesystem", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/..%2F..%2Fetc/file/compose",
      headers: { cookie: adminCookie },
    });
    expect([400, 404]).toContain(res.statusCode);
  });

  it("404s an unknown project", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/nope/file/compose",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/projects/:slug/validate", () => {
  it("denies a viewer because it requires compose:write", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/media/validate",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
