import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the *verb* in `requirePermission({ project: ["delete"] })`, which the
 * ordinary route tests cannot do.
 *
 * There, both roles are the real ones: `admin` holds every `project` verb and
 * `viewer` holds none, so "admin 200 / viewer 403" passes identically whether
 * the delete route asks for `delete`, `read`, or `control`. The guard's
 * argument is unobserved, and weakening it to `project: ["read"]` — the sort
 * of thing a copy-paste does — would leave the whole suite green while
 * handing every viewer-adjacent role `rm -rf` on a host directory.
 *
 * The lever is that `guard.ts` reads `roles` from `./permissions.js` at call
 * time, so a module mock can supply a role that grants `project:read` and not
 * `project:delete`. That is a real Better-Auth role evaluated by the real
 * guard, not a stub of the decision — the only synthetic part is which verbs
 * the role happens to hold.
 *
 * **`src/server/auth/permissions.ts` is not modified.** §6 forbids modifying
 * it; this file never touches it. Everything below is local to this test
 * module, which is why it lives in its own file: `vi.mock` is module-scoped.
 */
vi.mock("../auth/permissions.js", async () => {
  const { homesteadStatement } = await import("@shared/permissions.js");
  const { createAccessControl } = await import("better-auth/plugins/access");
  const { adminAc, defaultStatements } = await import(
    "better-auth/plugins/admin/access"
  );
  const statement = { ...defaultStatements, ...homesteadStatement } as const;
  const ac = createAccessControl(statement);
  // Identical to the real admin role except for `project`, which is missing
  // `delete`. Everything else stays granted so a failure can only mean the
  // delete route consulted a verb this role does not have.
  const adminRole = ac.newRole({
    ...adminAc.statements,
    project: ["read", "create", "update", "control"],
    compose: ["read", "write"],
    tunnel: ["read", "create", "delete"],
    app: ["read"],
    logs: ["read"],
    stats: ["read"],
    settings: ["read", "write"],
  });
  const viewerRole = ac.newRole({ app: ["read"] });
  return {
    statement,
    ac,
    adminRole,
    viewerRole,
    roles: { admin: adminRole, viewer: viewerRole },
  };
});

const { buildApp } = await import("../app.js");
const { createAuth } = await import("../auth/index.js");
const { createDb, runMigrations } = await import("../db/client.js");
const { user } = await import("../db/schema.js");
const { createFakeDocker } = await import("../docker/fake.js");

const TEST_AUTH = {
  secret: "test-secret-value-at-least-32-chars",
  baseURL: "http://localhost:7420",
};

let app: Awaited<ReturnType<typeof buildApp>>;
let root: string;
let cookie: string;
let slug: string;

beforeEach(async () => {
  slug = `hs-perm-${Math.random().toString(36).slice(2, 10)}`;
  root = await mkdtemp(join(tmpdir(), "hs-perms-"));
  await mkdir(join(root, slug), { recursive: true });
  await writeFile(
    join(root, slug, "docker-compose.yml"),
    `name: ${slug}\nservices:\n  web:\n    image: nginx\n`,
  );

  const db = createDb(":memory:");
  await runMigrations(db);
  const auth = createAuth(db, TEST_AUTH);
  app = await buildApp({
    db,
    auth,
    projectsDir: root,
    projectsHostDir: root,
    dataDir: root,
    docker: createFakeDocker({
      config: { name: slug, services: { web: { image: "nginx" } } },
    }).runner,
  });

  const signed = await auth.api.signUpEmail({
    body: {
      email: "admin@example.com",
      name: "Admin",
      password: "correct-horse-battery",
    },
  });
  await db
    .update(user)
    .set({ role: "admin" })
    .where(eq(user.id, signed.user.id));
  const res = await auth.api.signInEmail({
    body: { email: "admin@example.com", password: "correct-horse-battery" },
    asResponse: true,
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie returned");
  cookie = setCookie.split(";")[0] as string;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("project verb guards, against a role that lacks project:delete", () => {
  it("still allows GET, so the role and session are not the reason", async () => {
    // The control. Without it a 403 on DELETE could just mean the mock broke
    // sign-in, and the test would be green for no reason at all.
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().slug).toBe(slug);
  });

  it("refuses DELETE, and the directory survives", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${slug}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "forbidden" });
    // The guard has to stop it, not merely report it.
    expect((await stat(join(root, slug))).isDirectory()).toBe(true);
  });

  it("still allows the lifecycle verbs, which ask for project:control", async () => {
    // Pins the other direction: DELETE's 403 is about the verb it names, not
    // about `project` being broken wholesale for this role.
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/up`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(202);
  });
});
