import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { user } from "../db/schema.js";
import { createFakeDocker, type FakeDocker } from "../docker/fake.js";

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
/** Collision-proof: nothing here may ever address a real user stack. */
let slug: string;
let fake: FakeDocker;

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

/**
 * Rebuilds the app with a scripted Docker double. `config` is what `docker
 * compose config --format json` would print; passing `undefined` makes it fail,
 * which is how a broken compose file is simulated without a daemon.
 */
async function build(options: Parameters<typeof createFakeDocker>[0]) {
  fake = createFakeDocker(options);
  app = await buildApp({
    db,
    auth,
    projectsDir: root,
    projectsHostDir: root,
    dataDir: root,
    docker: fake.runner,
  });
}

beforeEach(async () => {
  slug = `hs-test-${randomUUID().slice(0, 8)}`;
  root = await mkdtemp(join(tmpdir(), "hs-routes-"));
  await mkdir(join(root, slug), { recursive: true });
  await writeFile(
    join(root, slug, "docker-compose.yml"),
    `name: ${slug}\nservices:\n  web:\n    image: nginx\n`,
  );
  await writeFile(join(root, slug, ".env"), "DB_PASSWORD=hunter2\n");

  db = createDb(":memory:");
  await runMigrations(db);
  auth = createAuth(db, TEST_AUTH);
  await build({
    config: { name: slug, services: { web: { image: "nginx" } } },
    ps: [
      {
        Service: "web",
        Name: `${slug}-web-1`,
        State: "running",
        Health: "",
        ExitCode: 0,
      },
    ],
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

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
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
      slug,
    ]);
  });

  it("requires a session", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/projects" })).statusCode,
    ).toBe(401);
  });

  it("does not put the host filesystem path on the wire", async () => {
    // No client code ever read it, and it is an absolute path on the machine
    // holding the Docker socket. Whoever widens this endpoint's audience
    // should not have to notice a field nobody needs.
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: adminCookie },
    });
    const entry = res.json().projects[0];
    expect(entry.slug).toBe(slug);
    expect(entry).not.toHaveProperty("path");
    // Belt and braces: nothing else smuggled the root in either.
    expect(JSON.stringify(res.json())).not.toContain(root);
  });
});

describe("GET /api/projects/:slug", () => {
  it("returns detail with states and snapshots for an admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.slug).toBe(slug);
    expect(body.model).toBeTruthy();
    expect(body.model.projectName).toBe(slug);
    expect(body.states).toHaveLength(1);
    expect(body.states[0].state).toBe("running");
    expect(Array.isArray(body.snapshots)).toBe(true);
  });

  it("denies a viewer because project detail exposes service and port inventory", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("surfaces a broken compose file as parseError rather than failing the route", async () => {
    // No canonical config: `docker compose config` exits non-zero, exactly as
    // it does for unparseable YAML.
    await build({ config: undefined });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.slug).toBe(slug);
    expect(body.model).toBeNull();
    expect(typeof body.parseError).toBe("string");
    expect(body.parseError).toBeTruthy();
  });
});

describe("compose file access", () => {
  it("lets an admin read the compose file", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/file/compose`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toContain("image: nginx");
  });

  it("denies a viewer, because .env and compose hold passwords", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/file/compose`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("writes and snapshots on PUT", async () => {
    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${slug}/file/compose`,
      headers: { cookie: adminCookie },
      payload: {
        content: `name: ${slug}\nservices:\n  web:\n    image: caddy\n`,
      },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/file/compose`,
      headers: { cookie: adminCookie },
    });
    expect(get.json().content).toContain("caddy");
    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
    });
    expect(detail.json().snapshots.length).toBe(1);
  });

  it("denies a viewer writing", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${slug}/file/compose`,
      headers: { cookie: viewerCookie },
      payload: { content: "services: {}\n" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an unknown file name", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/file/secrets`,
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

describe("env file access", () => {
  it("lets an admin read the env file", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/file/env`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe("DB_PASSWORD=hunter2\n");
  });

  it("denies a viewer reading the env file, which is the secret store", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/file/env`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s a project with no env file", async () => {
    await rm(join(root, slug, ".env"));
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/file/env`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("writes and snapshots the env file on PUT", async () => {
    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${slug}/file/env`,
      headers: { cookie: adminCookie },
      payload: { content: "DB_PASSWORD=correct-horse\n" },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/file/env`,
      headers: { cookie: adminCookie },
    });
    expect(get.json().content).toBe("DB_PASSWORD=correct-horse\n");
    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
    });
    expect(detail.json().snapshots).toHaveLength(1);
    expect(detail.json().snapshots[0]).toMatch(/\.env$/);
  });

  it("denies a viewer writing the env file", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${slug}/file/env`,
      headers: { cookie: viewerCookie },
      payload: { content: "DB_PASSWORD=pwned\n" },
    });
    expect(res.statusCode).toBe(403);
    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/file/env`,
      headers: { cookie: adminCookie },
    });
    expect(get.json().content).toBe("DB_PASSWORD=hunter2\n");
  });

  it("404s writing the env file of an unknown project", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/nope/file/env",
      headers: { cookie: adminCookie },
      payload: { content: "A=1\n" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a body that is not the expected shape", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${slug}/file/env`,
      headers: { cookie: adminCookie },
      payload: { content: 42 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/projects/:slug/validate", () => {
  it("denies a viewer because it requires compose:write", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/validate`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("reports a canonical config as valid for an admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/validate`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
    expect(res.json().model.projectName).toBe(slug);
  });
});
