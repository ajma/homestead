import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { projectIdentity, user } from "../db/schema.js";
import {
  composeVerbOf,
  createFakeDocker,
  type FakeDocker,
} from "../docker/fake.js";
import { scanProjects } from "../projects/store.js";

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
    secretKey: Buffer.alloc(32),
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

describe("POST /api/projects", () => {
  it("creates a blank project and reports it valid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: adminCookie },
      payload: { slug: "media", source: "blank" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ slug: "media", valid: true });
    // The scaffold is on disk under the new slug, carrying its provenance.
    const file = await readFile(
      join(root, "media", "docker-compose.yml"),
      "utf8",
    );
    expect(file).toContain("x-homestead");
  });

  it("stores an invalid paste rather than rejecting it", async () => {
    // Spec §6.1: refusing the paste discards content the user has nowhere
    // else to put; the detail page surfaces parseError instead.
    // `config: undefined` makes the fake exit non-zero, exactly as
    // `docker compose config` does for unparseable YAML.
    await build({ config: undefined });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: adminCookie },
      payload: {
        slug: "broken",
        source: "paste",
        content: "services:\n  - [nope\n",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ slug: "broken", valid: false });
    expect(res.json().error).toBeTruthy();
    // Kept verbatim: unparseable content cannot be round-tripped, so the
    // paste is stored exactly as the user gave it.
    const file = await readFile(
      join(root, "broken", "docker-compose.yml"),
      "utf8",
    );
    expect(file).toBe("services:\n  - [nope\n");
  });

  it("stores a paste that is valid YAML but not a mapping, without a 500", async () => {
    // A pasted URL, log line, or list fragment parses cleanly and then makes
    // `yaml`'s setIn throw. The directory already exists by then, so the 500
    // used to leave an orphan that made the advertised retry 409 forever.
    await build({ config: undefined });
    for (const [i, content] of [
      "just a string",
      "- a\n- b\n",
      "42\n",
    ].entries()) {
      const slug = `hs-scalar-${i}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: adminCookie },
        payload: { slug, source: "paste", content },
      });
      expect(res.statusCode, content).toBe(201);
      expect(res.json()).toMatchObject({ slug, valid: false });
      expect(
        await readFile(join(root, slug, "docker-compose.yml"), "utf8"),
      ).toBe(content);
    }
  });

  it("returns 409 when the directory already exists", async () => {
    await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: adminCookie },
      payload: { slug: "media", source: "blank" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: adminCookie },
      payload: { slug: "media", source: "blank" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "project_exists" });
  });

  it("rejects a slug that escapes the projects root", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: adminCookie },
      payload: { slug: "../evil", source: "blank" },
    });
    expect(res.statusCode).toBe(400);
    // Nothing was written outside the root, and nothing inside it either.
    expect(await scanProjects(root)).toHaveLength(1);
  });

  it("refuses a slug the router reserves, so no directory is created", async () => {
    // The client checks it first, but the client is not the boundary: a curl
    // against this route would otherwise leave a directory only shell access
    // could remove.
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: adminCookie },
      payload: { slug: "new", source: "blank" },
    });
    expect(res.statusCode).toBe(400);
    // Its own code, not `invalid_slug`: the name breaks no character rule, and
    // a client that wants to explain the refusal has to be able to tell the
    // two apart.
    expect(res.json()).toMatchObject({ error: "reserved_slug" });
    expect(await scanProjects(root)).toHaveLength(1);
  });

  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: viewerCookie },
      payload: { slug: "media", source: "blank" },
    });
    expect(res.statusCode).toBe(403);
    expect(await scanProjects(root)).toHaveLength(1);
  });
});

describe("DELETE /api/projects/:slug", () => {
  /** The argv of the first invocation carrying the `down` verb, if any. */
  function downArgs(): string[] | undefined {
    return fake.calls.map((c) => c.args).find((args) => args.includes("down"));
  }

  it("brings the stack down and removes the directory", async () => {
    await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: adminCookie },
      payload: { slug: "media", source: "blank" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/media",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const down = downArgs();
    expect(down).toBeTruthy();
    // The wrapper's allow-list must make a volume flag impossible.
    expect(down).not.toContain("-v");
    expect(down).not.toContain("--volumes");
    const list = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: adminCookie },
    });
    // Only the fixture project the harness created remains.
    expect(list.json().projects.map((p: { slug: string }) => p.slug)).toEqual([
      slug,
    ]);
    await expect(stat(join(root, "media"))).rejects.toThrow();
  });

  it("is refused while another operation is running for the same project", async () => {
    // The race this closes: tab B starts `up`, tab A confirms delete. Without
    // the lock the `down` runs, the `up` finishes afterwards and recreates the
    // containers, and the `rm -rf` then removes the compose file — leaving
    // containers running and holding host ports that Homestead can no longer
    // enumerate or stop, on a project the UI says is gone.
    let finishUp: (() => void) | undefined;
    await build({
      config: { name: slug, services: { web: { image: "nginx" } } },
      // Only the `up` hangs. The `down` the retry issues must still complete,
      // or the test would pass for the wrong reason — a hung delete looks the
      // same as a refused one from the outside.
      stream: async (args) => {
        if (composeVerbOf(args) !== "up") return 0;
        await new Promise<void>((resolve) => {
          finishUp = resolve;
        });
        return 0;
      },
    });
    const up = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/up`,
      headers: { cookie: adminCookie },
    });
    expect(up.statusCode).toBe(202);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "operation_in_progress" });
    // The two things that must not have happened: no `down` was issued behind
    // the running `up`, and the directory is still there.
    expect(downArgs()).toBeUndefined();
    expect((await stat(join(root, slug))).isDirectory()).toBe(true);

    finishUp?.();
    // Once the `up` releases the lock, the same delete succeeds — this is a
    // lock, not a permanent refusal.
    await vi.waitFor(async () => {
      const retry = await app.inject({
        method: "DELETE",
        url: `/api/projects/${slug}`,
        headers: { cookie: adminCookie },
      });
      expect(retry.statusCode).toBe(200);
    });
    await expect(stat(join(root, slug))).rejects.toThrow();
  });

  it("holds the lock across the whole delete, so an `up` cannot slip in", async () => {
    // The other half, and the one that actually matters: checking `busy` and
    // then releasing before the `rm -rf` would still let an `up` begun a
    // moment later recreate the containers after the compose file is gone.
    let finishDown: (() => void) | undefined;
    await build({
      config: { name: slug, services: { web: { image: "nginx" } } },
      stream: async (args) => {
        if (composeVerbOf(args) !== "down") return 0;
        await new Promise<void>((resolve) => {
          finishDown = resolve;
        });
        return 0;
      },
    });
    const deleting = app.inject({
      method: "DELETE",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
    });
    await vi.waitFor(() => expect(finishDown).toBeTypeOf("function"));

    const up = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/up`,
      headers: { cookie: adminCookie },
    });
    expect(up.statusCode).toBe(409);

    finishDown?.();
    expect((await deleting).statusCode).toBe(200);
  });

  it("still removes a pre-existing directory whose name the router reserves", async () => {
    // An adopted directory literally named `new`, already on the NAS before
    // Homestead ever saw it. The create form refuses to make one, but that is
    // a policy about new names — it must not make an existing directory
    // unmanageable through the API as well. `isValidSlug` is a path-safety
    // predicate; `new` is a perfectly safe path segment.
    await mkdir(join(root, "new"), { recursive: true });
    await writeFile(
      join(root, "new", "docker-compose.yml"),
      "name: new\nservices:\n  web:\n    image: nginx\n",
    );

    const detail = await app.inject({
      method: "GET",
      url: "/api/projects/new",
      headers: { cookie: adminCookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().slug).toBe("new");

    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/new",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    await expect(stat(join(root, "new"))).rejects.toThrow();
  });

  it("removes the directory even when compose down fails", async () => {
    // A stack that will not come down — unreachable daemon, unparseable
    // compose file — must not strand the user with a project they cannot
    // get rid of.
    await build({
      config: { name: slug, services: { web: { image: "nginx" } } },
      stream: () => Promise.reject(new Error("Cannot connect to the daemon")),
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(downArgs()).toBeTruthy();
    expect(await scanProjects(root)).toEqual([]);
  });

  it("returns 404 for a project that is not there", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/ghost",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    // Nothing was run against a stack that does not exist.
    expect(downArgs()).toBeUndefined();
  });

  it("rejects an over-long slug before touching the filesystem", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${"a".repeat(65)}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_slug" });
  });

  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${slug}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
    // The refusal is total: no `down` was issued and the directory survives.
    expect(downArgs()).toBeUndefined();
    expect(await scanProjects(root)).toHaveLength(1);
  });
});

describe("GET /api/projects/:slug — provenance", () => {
  it("reports hasHomestead true for a project Homestead created", async () => {
    await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: adminCookie },
      payload: { slug: "made", source: "blank" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/made",
      headers: { cookie: adminCookie },
    });
    expect(res.json()).toMatchObject({ hasHomestead: true });
  });

  it("reports hasHomestead false for an adopted directory", async () => {
    // Absence of the x-homestead block IS the provenance marker (§3.7) — this
    // is what makes deletion ask twice for a directory we did not create.
    await mkdir(join(root, "adopted"), { recursive: true });
    await writeFile(
      join(root, "adopted", "docker-compose.yml"),
      "services:\n  web:\n    image: nginx\n",
      "utf8",
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/adopted",
      headers: { cookie: adminCookie },
    });
    expect(res.json()).toMatchObject({ hasHomestead: false });
  });
});

describe("project identity", () => {
  it("stores a display name, description and icon", async () => {
    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${slug}/identity`,
      headers: { cookie: adminCookie },
      payload: {
        displayName: "Media Stack",
        description: "Jellyfin and friends",
        iconSlug: "jellyfin",
      },
    });
    expect(put.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
    });
    expect(res.json().identity).toMatchObject({
      displayName: "Media Stack",
      description: "Jellyfin and friends",
      iconSlug: "jellyfin",
    });
  });

  it("leaves the compose file untouched and the project still adopted", async () => {
    // The whole reason identity is in SQLite. Writing x-homestead would flip
    // hasHomestead, which the delete dialog reads to decide whether to confirm
    // twice — so naming a project would quietly make it easier to delete.
    const file = join(root, slug, "docker-compose.yml");
    const before = await readFile(file, "utf8");

    await app.inject({
      method: "PUT",
      url: `/api/projects/${slug}/identity`,
      headers: { cookie: adminCookie },
      payload: { displayName: "Renamed", iconSlug: "jellyfin" },
    });

    expect(await readFile(file, "utf8")).toBe(before);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
    });
    expect(res.json().hasHomestead).toBe(false);
  });

  it("reports no identity for a project that has none", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
    });
    expect(res.json().identity).toBeNull();
  });

  it("lists identity alongside each project", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/projects/${slug}/identity`,
      headers: { cookie: adminCookie },
      payload: { displayName: "Media Stack" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: adminCookie },
    });
    const entry = res
      .json()
      .projects.find((p: { slug: string }) => p.slug === slug);
    expect(entry.identity).toMatchObject({ displayName: "Media Stack" });
  });

  it("forgets identity when the project is deleted", async () => {
    // A directory recreated under the same slug must not inherit a stranger's
    // description.
    await app.inject({
      method: "PUT",
      url: `/api/projects/${slug}/identity`,
      headers: { cookie: adminCookie },
      payload: { displayName: "Gone Soon" },
    });
    await app.inject({
      method: "DELETE",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
    });

    const [row] = await db
      .select()
      .from(projectIdentity)
      .where(eq(projectIdentity.slug, slug));
    expect(row).toBeUndefined();
  });

  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${slug}/identity`,
      headers: { cookie: viewerCookie },
      payload: { displayName: "Nope" },
    });
    expect(res.statusCode).toBe(403);
  });
});
