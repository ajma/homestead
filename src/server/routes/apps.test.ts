import { readFile } from "node:fs/promises";
import { apps, jobs } from "@server/db/schema";
import { buildTestApp, createViewer, fakeSelfMountinfo, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";

// Same technique as `preflight.test.ts`: a native ESM module namespace is not
// configurable, so `vi.spyOn` cannot override `readFile` in place. `vi.mock` with
// `importOriginal` replaces the whole binding with a real `vi.fn()` whose default
// implementation IS the real `readFile`, so nothing here behaves differently unless a
// test below queues a one-off override — used to feed `self-detect.ts`'s
// `/proc/self/mountinfo` read a chosen container id without needing a real container.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

async function adoptOne(app: Awaited<ReturnType<typeof buildTestApp>>, cookie: string) {
  app.deps.host.files.set("a/compose.yaml", "services: {}\n");
  app.deps.host.composeResults.set("config --format json", {
    exitCode: 0,
    stdout: JSON.stringify({ name: "a", services: {} }),
    stderr: "",
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/apps/adopt",
    headers: { cookie },
    payload: { directories: ["a"] },
  });
  return res.json().adopted[0].id as string;
}

describe("app inventory API", () => {
  it("refuses the scan to a viewer", async () => {
    const app = await buildTestApp();
    const { cookie: adminCookie } = await signUpAdmin(app);
    const viewer = await createViewer(app, adminCookie);
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/scan",
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("adopts a discovered directory and resolves its project name", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("jellyfin/compose.yaml", "services:\n  web:\n    image: nginx\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "custom-name", services: { web: { image: "nginx" } } }),
      stderr: "",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["jellyfin"] },
    });
    expect(res.statusCode).toBe(201);
    // The project name comes from compose, not from the directory name.
    expect(res.json().adopted[0].projectName).toBe("custom-name");
    await app.close();
  });

  describe("marking Homestead itself (self-detect.ts)", () => {
    const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
    // A full 64-hex container id, the shape `extractSelfContainerId` requires and
    // `listContainers()` reports — not the short prefix the pre-2F-fix-wave `$HOSTNAME`
    // approach matched against.
    const SELF_CONTAINER_ID = `abc123${"0".repeat(58)}`;

    it("marks the directory Homestead itself runs from as systemKind: self, on adoption", async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      app.deps.host.files.set("homestead/compose.yaml", "services: {}\n");
      app.deps.host.composeResults.set("config --format json", {
        exitCode: 0,
        stdout: JSON.stringify({ name: "homestead", services: {} }),
        stderr: "",
      });
      // Default `composeRoot` (`config.ts`) is `/volume2/docker` — see `buildTestApp`.
      app.deps.host.containers = [
        {
          id: SELF_CONTAINER_ID,
          names: ["homestead"],
          image: "homestead:latest",
          state: "running",
          status: "Up",
          project: "homestead",
          service: "homestead",
          labels: { [WORKING_DIR_LABEL]: "/volume2/docker/homestead" },
        },
      ];
      vi.mocked(readFile).mockImplementationOnce(async () => fakeSelfMountinfo(SELF_CONTAINER_ID));

      const res = await app.inject({
        method: "POST",
        url: "/api/apps/adopt",
        headers: { cookie },
        payload: { directories: ["homestead"] },
      });
      expect(res.statusCode).toBe(201);

      const [row] = await app.deps.db
        .select()
        .from(apps)
        .where(eq(apps.id, res.json().adopted[0].id));
      expect(row?.systemKind).toBe("self");
      await app.close();
    });

    it("leaves every other directory unaffected", async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      app.deps.host.files.set("homestead/compose.yaml", "services: {}\n");
      app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
      app.deps.host.composeResults.set("config --format json", {
        exitCode: 0,
        stdout: JSON.stringify({ name: "x", services: {} }),
        stderr: "",
      });
      app.deps.host.containers = [
        {
          id: SELF_CONTAINER_ID,
          names: ["homestead"],
          image: "homestead:latest",
          state: "running",
          status: "Up",
          project: "homestead",
          service: "homestead",
          labels: { [WORKING_DIR_LABEL]: "/volume2/docker/homestead" },
        },
      ];
      vi.mocked(readFile).mockImplementationOnce(async () => fakeSelfMountinfo(SELF_CONTAINER_ID));

      const res = await app.inject({
        method: "POST",
        url: "/api/apps/adopt",
        headers: { cookie },
        payload: { directories: ["homestead", "jellyfin"] },
      });
      expect(res.statusCode).toBe(201);

      const rows = await app.deps.db.select().from(apps);
      const jellyfin = rows.find((r) => r.directory === "jellyfin");
      const homestead = rows.find((r) => r.directory === "homestead");
      expect(homestead?.systemKind).toBe("self");
      expect(jellyfin?.systemKind).toBeNull();
      await app.close();
    });

    it("marks nothing when run outside a container — no mountinfo match, no guess", async () => {
      // Simulates the honest "cannot tell" case `self-detect.ts` documents (`pnpm dev`,
      // or any non-container process): `/proc/self/mountinfo` exists but has no
      // `containers/<id>/...` bind mount for this process. Even a container list that
      // WOULD otherwise match must not be consulted; detection has to fail closed here,
      // not merely happen not to find a match.
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      app.deps.host.files.set("homestead/compose.yaml", "services: {}\n");
      app.deps.host.composeResults.set("config --format json", {
        exitCode: 0,
        stdout: JSON.stringify({ name: "homestead", services: {} }),
        stderr: "",
      });
      app.deps.host.containers = [
        {
          id: SELF_CONTAINER_ID,
          names: ["homestead"],
          image: "homestead:latest",
          state: "running",
          status: "Up",
          project: "homestead",
          service: "homestead",
          labels: { [WORKING_DIR_LABEL]: "/volume2/docker/homestead" },
        },
      ];
      vi.mocked(readFile).mockImplementationOnce(async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/apps/adopt",
        headers: { cookie },
        payload: { directories: ["homestead"] },
      });
      expect(res.statusCode).toBe(201);

      const [row] = await app.deps.db
        .select()
        .from(apps)
        .where(eq(apps.id, res.json().adopted[0].id));
      expect(row?.systemKind).toBeNull();
      await app.close();
    });

    it("adopts normally, marking nothing, when the Docker socket is unreachable (F4)", async () => {
      // Phase 2F whole-branch review, F4: `detectSelfDirectory` used to let
      // `listContainers()` rejecting propagate uncaught, 500ing the whole adopt request.
      // It now catches internally and returns `null` — "cannot tell", never a guess and
      // never a 500 — so a transient daemon hiccup during adoption degrades to "nothing
      // marked self" rather than failing every directory in the request.
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      app.deps.host.files.set("homestead/compose.yaml", "services: {}\n");
      app.deps.host.composeResults.set("config --format json", {
        exitCode: 0,
        stdout: JSON.stringify({ name: "homestead", services: {} }),
        stderr: "",
      });
      app.deps.host.listContainers = async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      };
      vi.mocked(readFile).mockImplementationOnce(async () => fakeSelfMountinfo(SELF_CONTAINER_ID));

      const res = await app.inject({
        method: "POST",
        url: "/api/apps/adopt",
        headers: { cookie },
        payload: { directories: ["homestead"] },
      });
      expect(res.statusCode).toBe(201);

      const [row] = await app.deps.db
        .select()
        .from(apps)
        .where(eq(apps.id, res.json().adopted[0].id));
      expect(row?.systemKind).toBeNull();
      await app.close();
    });
  });

  it("pre-fills iconRef with a confident slug match on the directory name", async () => {
    // Spec §8: the directory name is matched against slugs and aliases on adoption. The
    // test fixture's icon index (see test-helpers.ts) knows "jellyfin".
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "jellyfin", services: {} }),
      stderr: "",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["jellyfin"] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().adopted[0].iconRef).toBe("jellyfin");
    await app.close();
  });

  it("pre-fills iconRef from a confident exact alias match", async () => {
    // The fixture's "jellyfin" entry carries the alias "emby". A directory named exactly
    // "emby" is a confident hit even though it names a different slug.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("emby/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "emby", services: {} }),
      stderr: "",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["emby"] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().adopted[0].iconRef).toBe("jellyfin");
    await app.close();
  });

  it("declines a weak substring-only match rather than guessing wrong", async () => {
    // "myplexserver" only contains "plex" partway through — a substring match, not an
    // exact one — and a wrong icon is worse than a letter tile.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("myplexserver/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "myplexserver", services: {} }),
      stderr: "",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["myplexserver"] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().adopted[0].iconRef).toBeNull();
    await app.close();
  });

  it("declines a NAS-ordinary prefix directory like 'plex-backup' rather than guessing wrong", async () => {
    // A wrong icon is worse than the letter-tile fallback: "plex-backup" is exactly the
    // kind of suffixed directory that is ordinary on a NAS and used to sail through as a
    // confident bidirectional prefix hit.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("plex-backup/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "plex-backup", services: {} }),
      stderr: "",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["plex-backup"] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().adopted[0].iconRef).toBeNull();
    await app.close();
  });

  it("refuses to adopt a directory with an invalid compose file", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("broken/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 1,
      stdout: "",
      stderr: "invalid compose project",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["broken"] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().failed[0].message).toContain("invalid compose project");
    await app.close();
  });

  it("is idempotent: adopting twice does not duplicate", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "jellyfin", services: {} }),
      stderr: "",
    });
    const body = { directories: ["jellyfin"] };
    await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: body,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: body,
    });
    expect(second.statusCode).toBe(409);
    const list = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const apps = list.json();
    expect(apps).toHaveLength(1);
    await app.close();
  });

  it("gives a viewer the viewer DTO and an admin the admin DTO", async () => {
    const app = await buildTestApp();
    const { cookie: adminCookie } = await signUpAdmin(app);
    app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "jellyfin", services: {} }),
      stderr: "",
    });
    await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie: adminCookie },
      payload: { directories: ["jellyfin"] },
    });
    const viewer = await createViewer(app, adminCookie);

    const adminRes = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { cookie: adminCookie },
    });
    const viewerRes = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { cookie: viewer.cookie },
    });

    expect(adminRes.statusCode).toBe(200);
    expect(viewerRes.statusCode).toBe(200);
    const asAdmin = adminRes.json();
    const asViewer = viewerRes.json();
    expect(asAdmin).toHaveLength(1);
    expect(asViewer).toHaveLength(1);

    expect(asAdmin[0]).toHaveProperty("directory");
    expect(asViewer[0]).not.toHaveProperty("directory");
    expect(asViewer[0]).not.toHaveProperty("projectName");
    expect(asViewer[0]).toHaveProperty("displayName");
    await app.close();
  });

  it("hides apps outside a scoped viewer's allowlist", async () => {
    const app = await buildTestApp();
    const { cookie: adminCookie } = await signUpAdmin(app);
    app.deps.host.files.set("a/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "a", services: {} }),
      stderr: "",
    });
    await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie: adminCookie },
      payload: { directories: ["a"] },
    });
    const viewer = await createViewer(app, adminCookie, { scopeAllApps: false, appIds: [] });
    const res = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  // Delete is refused for both system kinds — unlike the lifecycle guard in jobs.ts,
  // which allows `cloudflared` through. Deleting either kind makes Homestead forget a
  // resource it still manages, and that loss cannot be undone from the client.
  for (const kind of ["self", "cloudflared"] as const) {
    it(`refuses to delete a system app (${kind})`, async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      app.deps.host.files.set("cloudflared/compose.yaml", "services: {}\n");
      app.deps.host.composeResults.set("config --format json", {
        exitCode: 0,
        stdout: JSON.stringify({ name: "cloudflared", services: {} }),
        stderr: "",
      });
      const adopted = await app.inject({
        method: "POST",
        url: "/api/apps/adopt",
        headers: { cookie },
        payload: { directories: ["cloudflared"] },
      });
      const id = adopted.json().adopted[0].id;
      await app.deps.db.update(apps).set({ systemKind: kind }).where(eq(apps.id, id));
      const res = await app.inject({
        method: "DELETE",
        url: `/api/apps/${id}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(409);
      await app.close();
    });
  }

  it("refuses to delete Homestead marked self by REAL detection, not a seeded row", async () => {
    // Same reasoning as `jobs.test.ts`'s equivalent: every test above seeds `systemKind`
    // directly, which proves the GUARD but not that anything in production ever actually
    // sets the value it guards on. This runs the real `self-detect.ts` pipeline through
    // `POST /api/apps/adopt` instead.
    const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
    const selfContainerId = `abc123${"0".repeat(58)}`;
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("homestead/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "homestead", services: {} }),
      stderr: "",
    });
    app.deps.host.containers = [
      {
        id: selfContainerId,
        names: ["homestead"],
        image: "homestead:latest",
        state: "running",
        status: "Up",
        project: "homestead",
        service: "homestead",
        labels: { [WORKING_DIR_LABEL]: "/volume2/docker/homestead" },
      },
    ];
    vi.mocked(readFile).mockImplementationOnce(async () => fakeSelfMountinfo(selfContainerId));
    const adopted = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["homestead"] },
    });
    const id = adopted.json().adopted[0].id;

    const [row] = await app.deps.db.select().from(apps).where(eq(apps.id, id));
    expect(row?.systemKind).toBe("self");

    const res = await app.inject({
      method: "DELETE",
      url: `/api/apps/${id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("returns 404 for an unknown app id", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({ method: "GET", url: "/api/apps/nope", headers: { cookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET /api/apps/:id also resolves a slug, for the edit page's single-app query", async () => {
    // The root fix for Important 3 in the 1E final-fix brief: `EditApp` only has `:slug`
    // from the URL until this resolves, so the cheap single-app endpoint has to accept
    // one — the alternative was `useAdminApps()`'s whole-inventory rollup staying active
    // on every edit page.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "jellyfin", services: {} }),
      stderr: "",
    });
    const adopted = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["jellyfin"] },
    });
    const { id, slug } = adopted.json().adopted[0] as { id: string; slug: string };

    const byId = await app.inject({ method: "GET", url: `/api/apps/${id}`, headers: { cookie } });
    const bySlug = await app.inject({
      method: "GET",
      url: `/api/apps/${slug}`,
      headers: { cookie },
    });

    expect(byId.statusCode).toBe(200);
    expect(bySlug.statusCode).toBe(200);
    expect(bySlug.json()).toEqual(byId.json());
    await app.close();
  });

  it("scopes the slug lookup exactly like the id lookup, not wider", async () => {
    const app = await buildTestApp();
    const { cookie: adminCookie } = await signUpAdmin(app);
    app.deps.host.files.set("a/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "a", services: {} }),
      stderr: "",
    });
    const adopted = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie: adminCookie },
      payload: { directories: ["a"] },
    });
    const { slug } = adopted.json().adopted[0] as { id: string; slug: string };

    const viewer = await createViewer(app, adminCookie, {
      scopeAllApps: false,
      appIds: [],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${slug}`,
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("gives colliding directory names distinct slugs", async () => {
    // `My Media` and `My_Media` both normalise to `mymedia` — the underscore is
    // stripped, the hyphen in `my-media` is not, so THESE two are the colliding pair.
    // `apps_host_slug` is unique, so without disambiguation the second insert raised a
    // constraint violation that surfaced as a 500 mid-adopt, discarding the successes.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("My Media/compose.yaml", "services: {}\n");
    app.deps.host.files.set("My_Media/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "p", services: {} }),
      stderr: "",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["My Media", "My_Media"] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().failed).toEqual([]);
    const slugs = res
      .json()
      .adopted.map((a: { slug: string }) => a.slug)
      .sort();
    expect(slugs).toEqual(["mymedia", "mymedia-2"]);
    await app.close();
  });

  it("refuses to adopt a stack compose gives no project name", async () => {
    // An empty project name matches no container for the life of the app, so it would
    // read as permanently down. Refusing and saying why beats creating a broken row.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("nameless/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ services: {} }),
      stderr: "",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["nameless"] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().failed[0].message).toContain("no project name");
    await app.close();
  });

  it("rejects a PATCH with no fields instead of crashing", async () => {
    // Every field is optional, so `{}` parses cleanly, and Drizzle throws on an empty
    // `set()` — a 500 for what is really a no-op request.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("a/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "a", services: {} }),
      stderr: "",
    });
    const adopted = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["a"] },
    });
    const id = adopted.json().adopted[0].id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/apps/${id}`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  describe("the explicit systemKind: self override", () => {
    it("lets an admin mark an app self by hand — the override a wrong or missing detection needs", async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      const id = await adoptOne(app, cookie);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/apps/${id}`,
        headers: { cookie },
        payload: { systemKind: "self" },
      });
      expect(res.statusCode).toBe(200);

      const [row] = await app.deps.db.select().from(apps).where(eq(apps.id, id));
      expect(row?.systemKind).toBe("self");
      await app.close();
    });

    it("lets an admin clear a wrong self marking — the false-positive recovery path", async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      const id = await adoptOne(app, cookie);
      await app.deps.db.update(apps).set({ systemKind: "self" }).where(eq(apps.id, id));

      const res = await app.inject({
        method: "PATCH",
        url: `/api/apps/${id}`,
        headers: { cookie },
        payload: { systemKind: null },
      });
      expect(res.statusCode).toBe(200);

      const [row] = await app.deps.db.select().from(apps).where(eq(apps.id, id));
      expect(row?.systemKind).toBeNull();
      await app.close();
    });

    it("refuses to assign self while another app already holds it", async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      app.deps.host.files.set("a/compose.yaml", "services: {}\n");
      app.deps.host.files.set("b/compose.yaml", "services: {}\n");
      app.deps.host.composeResults.set("config --format json", {
        exitCode: 0,
        stdout: JSON.stringify({ name: "x", services: {} }),
        stderr: "",
      });
      const adopted = await app.inject({
        method: "POST",
        url: "/api/apps/adopt",
        headers: { cookie },
        payload: { directories: ["a", "b"] },
      });
      const [firstId, secondId] = adopted.json().adopted.map((a: { id: string }) => a.id);
      await app.deps.db.update(apps).set({ systemKind: "self" }).where(eq(apps.id, firstId));

      const res = await app.inject({
        method: "PATCH",
        url: `/api/apps/${secondId}`,
        headers: { cookie },
        payload: { systemKind: "self" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("self_already_assigned");

      const [firstRow] = await app.deps.db.select().from(apps).where(eq(apps.id, firstId));
      expect(firstRow?.systemKind).toBe("self");
      await app.close();
    });

    it("never lets this override touch a cloudflared app, in either direction", async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      const id = await adoptOne(app, cookie);
      await app.deps.db.update(apps).set({ systemKind: "cloudflared" }).where(eq(apps.id, id));

      const res = await app.inject({
        method: "PATCH",
        url: `/api/apps/${id}`,
        headers: { cookie },
        payload: { systemKind: null },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("system_app");

      const [row] = await app.deps.db.select().from(apps).where(eq(apps.id, id));
      expect(row?.systemKind).toBe("cloudflared");
      await app.close();
    });

    it('rejects "cloudflared" outright — this override only ever assigns self', async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      const id = await adoptOne(app, cookie);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/apps/${id}`,
        headers: { cookie },
        payload: { systemKind: "cloudflared" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  it("lists every app with a single call to Docker", async () => {
    // One round trip for the whole page. Per-row lookups meant one call per app on the
    // screen that shows all of them — thirty on this NAS, every page load.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    for (const dir of ["a", "b", "c"]) {
      app.deps.host.files.set(`${dir}/compose.yaml`, "services: {}\n");
    }
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "p", services: {} }),
      stderr: "",
    });
    await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["a", "b", "c"] },
    });
    app.deps.host.listContainersCalls = 0;
    const res = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
    expect(res.json()).toHaveLength(3);
    expect(app.deps.host.listContainersCalls).toBe(1);
    await app.close();
  });

  describe("lastDeployAt", () => {
    it("shows the finish time of a succeeded deploy", async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      const id = await adoptOne(app, cookie);
      await app.deps.db
        .insert(jobs)
        .values({ id: ulid(), appId: id, kind: "up", status: "succeeded", finishedAt: 12_345 });

      const res = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
      expect(res.json()[0].lastDeployAt).toBe(12_345);
      await app.close();
    });

    it("says 'never' (null) when the only job is a pull", async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      const id = await adoptOne(app, cookie);
      await app.deps.db
        .insert(jobs)
        .values({ id: ulid(), appId: id, kind: "pull", status: "succeeded", finishedAt: 12_345 });

      const res = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
      expect(res.json()[0].lastDeployAt).toBeNull();
      await app.close();
    });

    it("says 'never' (null) when the only up job failed", async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      const id = await adoptOne(app, cookie);
      await app.deps.db
        .insert(jobs)
        .values({ id: ulid(), appId: id, kind: "up", status: "failed", finishedAt: 12_345 });

      const res = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
      expect(res.json()[0].lastDeployAt).toBeNull();
      await app.close();
    });

    it("shows the later of two succeeded deploys", async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      const id = await adoptOne(app, cookie);
      await app.deps.db
        .insert(jobs)
        .values({ id: ulid(), appId: id, kind: "up", status: "succeeded", finishedAt: 100 });
      await app.deps.db
        .insert(jobs)
        .values({ id: ulid(), appId: id, kind: "restart", status: "succeeded", finishedAt: 200 });

      const res = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
      expect(res.json()[0].lastDeployAt).toBe(200);
      await app.close();
    });

    it("is null for an app with no jobs at all", async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      await adoptOne(app, cookie);

      const res = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
      expect(res.json()[0].lastDeployAt).toBeNull();
      await app.close();
    });

    it("costs one grouped query for the whole list, not one per app", async () => {
      // The absolute count includes fixed overhead (session lookup, capability checks,
      // the `apps` select itself) that has nothing to do with deploy timestamps, so the
      // binding assertion is that the count does not grow with the number of apps on the
      // page — a per-row lookup would add one `select` per adopted app, a grouped query
      // adds exactly one regardless of how many rows it covers.
      async function selectsForList(app: Awaited<ReturnType<typeof buildTestApp>>, cookie: string) {
        const selectSpy = vi.spyOn(app.deps.db, "select");
        await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
        const calls = selectSpy.mock.calls.length;
        selectSpy.mockRestore();
        return calls;
      }

      const oneApp = await buildTestApp();
      const { cookie: oneCookie } = await signUpAdmin(oneApp);
      await adoptOne(oneApp, oneCookie);
      const selectsForOne = await selectsForList(oneApp, oneCookie);
      await oneApp.close();

      const threeApps = await buildTestApp();
      const { cookie: threeCookie } = await signUpAdmin(threeApps);
      for (const dir of ["a", "b", "c"]) {
        threeApps.deps.host.files.set(`${dir}/compose.yaml`, "services: {}\n");
      }
      threeApps.deps.host.composeResults.set("config --format json", {
        exitCode: 0,
        stdout: JSON.stringify({ name: "p", services: {} }),
        stderr: "",
      });
      const adopted = await threeApps.inject({
        method: "POST",
        url: "/api/apps/adopt",
        headers: { cookie: threeCookie },
        payload: { directories: ["a", "b", "c"] },
      });
      expect(adopted.json().adopted).toHaveLength(3);
      const selectsForThree = await selectsForList(threeApps, threeCookie);
      await threeApps.close();

      expect(selectsForThree).toBe(selectsForOne);
    });

    it("never issues its query for a viewer", async () => {
      // A response-level assertion can't catch the gate going missing: `lastDeployAt`
      // is stripped from the viewer DTO whether or not this query actually ran, so
      // asserting on the JSON body passes either way. What has to be observed instead
      // is the query itself — `deployTimestamps`' own `select({ appId, lastDeployAt })`
      // shape, which is unique among this handler's queries (the base `apps` select
      // takes no argument at all, and `runningJobs`' shape is `{ id, appId }`).
      const app = await buildTestApp();
      const { cookie: adminCookie } = await signUpAdmin(app);
      await adoptOne(app, adminCookie);
      const viewer = await createViewer(app, adminCookie);

      const selectSpy = vi.spyOn(app.deps.db, "select");
      const res = await app.inject({
        method: "GET",
        url: "/api/apps",
        headers: { cookie: viewer.cookie },
      });
      expect(res.statusCode).toBe(200);
      const ranDeployTimestampsQuery = selectSpy.mock.calls.some(
        (call) => call[0] !== undefined && "lastDeployAt" in call[0],
      );
      selectSpy.mockRestore();

      expect(ranDeployTimestampsQuery).toBe(false);
      await app.close();
    });
  });

  describe("runningJobId", () => {
    it("shows the running job's id for an admin", async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      const id = await adoptOne(app, cookie);
      const jobId = ulid();
      await app.deps.db
        .insert(jobs)
        .values({ id: jobId, appId: id, kind: "up", status: "running" });

      const res = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
      expect(res.json()[0].runningJobId).toBe(jobId);
      await app.close();
    });

    it("is null for an app with no running job", async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      const id = await adoptOne(app, cookie);
      await app.deps.db
        .insert(jobs)
        .values({ id: ulid(), appId: id, kind: "up", status: "succeeded", finishedAt: 100 });

      const res = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
      expect(res.json()[0].runningJobId).toBeNull();
      await app.close();
    });

    it("is absent from the viewer DTO even while a job is running", async () => {
      // The security-shaped assertion: a viewer must not receive `runningJobId` at all,
      // not merely receive it as `null`. Seeding an actually-running job is what makes
      // this a real test of the field's absence rather than one that would pass anyway
      // because the fixture happened to have nothing running.
      const app = await buildTestApp();
      const { cookie: adminCookie } = await signUpAdmin(app);
      const id = await adoptOne(app, adminCookie);
      await app.deps.db
        .insert(jobs)
        .values({ id: ulid(), appId: id, kind: "up", status: "running" });
      const viewer = await createViewer(app, adminCookie);

      const res = await app.inject({
        method: "GET",
        url: "/api/apps",
        headers: { cookie: viewer.cookie },
      });
      expect(res.json()[0]).not.toHaveProperty("runningJobId");
      await app.close();
    });

    it("never issues its query for a viewer", async () => {
      // Same reasoning as `deployTimestamps`' sibling test above: the field is stripped
      // from the viewer DTO regardless of whether this query ran, so only observing the
      // query itself — `runningJobs`' own `select({ id, appId })` shape — can tell the
      // gate apart from a version that runs it unconditionally.
      const app = await buildTestApp();
      const { cookie: adminCookie } = await signUpAdmin(app);
      await adoptOne(app, adminCookie);
      const viewer = await createViewer(app, adminCookie);

      const selectSpy = vi.spyOn(app.deps.db, "select");
      const res = await app.inject({
        method: "GET",
        url: "/api/apps",
        headers: { cookie: viewer.cookie },
      });
      expect(res.statusCode).toBe(200);
      const ranRunningJobsQuery = selectSpy.mock.calls.some(
        (call) => call[0] !== undefined && "id" in call[0] && "appId" in call[0],
      );
      selectSpy.mockRestore();

      expect(ranRunningJobsQuery).toBe(false);
      await app.close();
    });

    it("keeps a running job's id when Docker is unreachable, rather than hard-nulling it", async () => {
      // The `!dockerReachable` branch builds its `AdminApp` from a stub status rather
      // than a real one, and it would be easy for that branch's own `runningMap.get(...)
      // ?? null` to get simplified to a bare `null` without anything noticing — every
      // other test of this branch only checks `status`/`statusDetail`. A job that really
      // is running is what makes this observe the fallback rather than the case (no job
      // running) both a correct and a broken version would agree on.
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      const id = await adoptOne(app, cookie);
      const jobId = ulid();
      await app.deps.db
        .insert(jobs)
        .values({ id: jobId, appId: id, kind: "up", status: "running" });

      const originalListContainers = app.deps.host.listContainers.bind(app.deps.host);
      app.deps.host.listContainers = async () => {
        throw new Error("Cannot connect to the Docker daemon");
      };

      const res = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
      expect(res.json()[0].runningJobId).toBe(jobId);

      app.deps.host.listContainers = originalListContainers;
      await app.close();
    });
  });

  describe("runningJobId on GET /api/apps/:id", () => {
    it("shows the running job's id for an admin", async () => {
      // `GET /api/apps` has its own version of this test; the single-app route builds
      // its `AdminApp` from a separately-written `runningMap.get(row.id) ?? null`
      // (`apps.ts:576`) that nothing exercised — a mutation hard-nulling it would pass
      // every existing test for this route, all of which use apps with no running job.
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      const id = await adoptOne(app, cookie);
      const jobId = ulid();
      await app.deps.db
        .insert(jobs)
        .values({ id: jobId, appId: id, kind: "up", status: "running" });

      const res = await app.inject({
        method: "GET",
        url: `/api/apps/${id}`,
        headers: { cookie },
      });
      expect(res.json().runningJobId).toBe(jobId);
      await app.close();
    });

    it("is absent from the viewer DTO even while a job is running", async () => {
      // The list route gates `runningJobId` behind `can(ctx, "app:config")` before ever
      // computing it; this route's `!can(ctx, "app:config")` branch (`apps.ts:573`)
      // returns `toViewerApp` — which has no `runningJobId` field at all — before
      // `deployTimestamps`/`runningJobs` are even called. Proven here rather than just
      // read off the source, the same way the list route's sibling test is: a viewer
      // reading this route while a job actually runs must not see the field, not merely
      // see it as `null`.
      const app = await buildTestApp();
      const { cookie: adminCookie } = await signUpAdmin(app);
      const id = await adoptOne(app, adminCookie);
      await app.deps.db
        .insert(jobs)
        .values({ id: ulid(), appId: id, kind: "up", status: "running" });
      const viewer = await createViewer(app, adminCookie);

      const res = await app.inject({
        method: "GET",
        url: `/api/apps/${id}`,
        headers: { cookie: viewer.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty("runningJobId");
      await app.close();
    });
  });

  it("never shows a viewer the raw output of docker compose config", async () => {
    // Measured before the split: a viewer's statusDetail read
    // `validating /volume2/docker/jellyfin/compose.yaml: ... invalid value
    // "sk-live-9f3c8" from /volume2/docker/jellyfin/.env` — an absolute path and an
    // interpolated secret, shown to the housemate this role exists to be safe for.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "jf", services: {} }),
      stderr: "",
    });
    await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["jellyfin"] },
    });
    const viewer = await createViewer(app, cookie);

    const secret = 'invalid value "sk-live-9f3c8" from /volume2/docker/jellyfin/.env';
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 1,
      stdout: "",
      stderr: secret,
    });
    app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n# edited\n");

    const viewerRes = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { cookie: viewer.cookie },
    });
    expect(viewerRes.statusCode).toBe(200);
    const asViewer = viewerRes.json();
    expect(asViewer).toHaveLength(1);
    expect(JSON.stringify(asViewer)).not.toContain("sk-live");
    expect(JSON.stringify(asViewer)).not.toContain("/volume2");
    expect(asViewer[0].statusDetail).toBe("compose configuration is invalid");

    // The admin still needs the real message to fix the file.
    const adminRes = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { cookie },
    });
    expect(adminRes.statusCode).toBe(200);
    const asAdmin = adminRes.json();
    expect(asAdmin).toHaveLength(1);
    expect(asAdmin[0].statusDetail).toBe(secret);
    await app.close();
  });

  it("survives one app's compose file going missing and does not 500 the list", async () => {
    // The compose root is an SMB share the user edits over SSH, so a renamed file is
    // ordinary operation. Without a guard, `composeConfig.resolve` rejects and
    // `Promise.all` propagates it, so the whole list 500s and the admin sees no apps.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
    app.deps.host.files.set("sonarr/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "p", services: { web: { image: "nginx" } } }),
      stderr: "",
    });
    await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["jellyfin", "sonarr"] },
    });

    // One compose file disappears.
    app.deps.host.files.delete("jellyfin/compose.yaml");

    const res = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const apps = res.json();
    expect(apps).toHaveLength(2);

    const broken = apps.find((a: { directory: string }) => a.directory === "jellyfin");
    const healthy = apps.find((a: { directory: string }) => a.directory === "sonarr");

    expect(broken.status).toBe("unknown");
    // Admin sees the full error (adminDetail takes precedence in toAdminApp)
    expect(broken.statusDetail).toContain("jellyfin/compose.yaml");
    expect(healthy.status).not.toBe("unknown");
    await app.close();
  });

  it("survives Docker being unreachable and marks all apps unknown, not down", async () => {
    // A wedged Docker socket must not paint every app red. `unknown` is the truth: we do
    // not know. Falling back to an empty container list would make `rollUpStatus` report
    // `down` with "N missing", which tells the user their whole NAS is broken.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "jf", services: { web: { image: "nginx" } } }),
      stderr: "",
    });
    await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["jellyfin"] },
    });

    // Simulate Docker being unreachable.
    const originalListContainers = app.deps.host.listContainers.bind(app.deps.host);
    app.deps.host.listContainers = async () => {
      throw new Error("Cannot connect to the Docker daemon");
    };

    const res = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const apps = res.json();
    expect(apps).toHaveLength(1);
    expect(apps[0].status).toBe("unknown");
    // The whole point: it must NOT be `down`.
    expect(apps[0].status).not.toBe("down");
    expect(apps[0].statusDetail).toContain("Docker is unreachable");

    app.deps.host.listContainers = originalListContainers;
    await app.close();
  });

  it("does not leak filesystem paths to viewers when Docker is unreachable", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "jf", services: {} }),
      stderr: "",
    });
    await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["jellyfin"] },
    });
    const viewer = await createViewer(app, cookie);

    // One app's compose file goes missing.
    app.deps.host.files.delete("jellyfin/compose.yaml");

    const res = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(200);
    const apps = res.json();
    expect(apps).toHaveLength(1);
    expect(apps[0].status).toBe("unknown");
    // No filesystem path leaks to the viewer.
    expect(apps[0].statusDetail).not.toContain("/");
    expect(apps[0].statusDetail).toBe("compose file could not be read");
    await app.close();
  });

  it("bounds concurrent compose config calls to 4 on a cold cache", async () => {
    // GET /api/apps calls statusFor per row in a Promise.all, and each cache miss spawns
    // `docker compose config`. On the first page load after restart, that's one Go binary
    // per app simultaneously — thirty on the target NAS.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);

    // Set up files and results before tracking concurrency.
    const directories: string[] = [];
    for (let i = 0; i < 20; i++) {
      const dir = `app${i}`;
      directories.push(dir);
      app.deps.host.files.set(`${dir}/compose.yaml`, "services: {}\n");
    }
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "p", services: { web: { image: "nginx" } } }),
      stderr: "",
    });

    // Track peak concurrency BEFORE adoption so we measure the cold cache on first list.
    let inFlight = 0;
    let peakConcurrency = 0;
    const originalRunCompose = app.deps.host.runCompose.bind(app.deps.host);
    app.deps.host.runCompose = (target, args) => {
      const handle = originalRunCompose(target, args);
      const wrappedResult = (async () => {
        inFlight++;
        peakConcurrency = Math.max(peakConcurrency, inFlight);
        // Small delay to ensure promises actually overlap and concurrency is measurable.
        await new Promise((resolve) => setTimeout(resolve, 10));
        const result = await handle.result;
        inFlight--;
        return result;
      })();
      return { output: handle.output, result: wrappedResult, cancel: handle.cancel };
    };

    await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories },
    });

    // Reset tracking - we want to measure the list call, not adoption.
    inFlight = 0;
    peakConcurrency = 0;

    // Clear the cache to force a cold-cache scenario on the list call.
    for (const dir of directories) {
      app.deps.composeConfig.invalidate({ directory: dir, composeFile: "compose.yaml" });
    }

    const res = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(20);
    // Without concurrency limiting, this would be 20 (all at once).
    expect(peakConcurrency).toBeLessThanOrEqual(4);
    await app.close();
  });

  it("list and detail agree on status when the stored project name is stale", async () => {
    // Measured with the stored name stale: GET /api/apps/:id reports "up, 1/1 services up"
    // while GET /api/apps reports "down, 0/1 services up, 1 missing" — the same app, the
    // same instant, two answers. The stored copy is written at adoption and reconciled
    // after writes through Homestead, but an SSH edit to .env setting COMPOSE_PROJECT_NAME
    // changes it underneath us.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.files.set("jellyfin/compose.yaml", "services:\n  web:\n    image: nginx\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "jellyfin", services: { web: { image: "nginx" } } }),
      stderr: "",
    });
    await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["jellyfin"] },
    });

    // Simulate an SSH edit that changes what compose resolves to. An edit to .env or
    // compose.yaml changes the file content, which invalidates the cache.
    app.deps.host.files.set(
      "jellyfin/compose.yaml",
      "services:\n  web:\n    image: nginx:latest\n",
    );
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "media", services: { web: { image: "nginx:latest" } } }),
      stderr: "",
    });
    // The container is running under the NEW name.
    app.deps.host.containers = [
      {
        id: "c1",
        names: ["media-web-1"],
        image: "nginx",
        state: "running",
        status: "Up 2 hours",
        project: "media",
        service: "web",
        labels: {},
      },
    ];

    const list = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const listApp = list.json()[0];

    const detail = await app.inject({
      method: "GET",
      url: `/api/apps/${listApp.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    const detailApp = detail.json();

    // The two routes must agree on the app's status.
    expect(listApp.status).toBe(detailApp.status);
    expect(listApp.statusDetail).toBe(detailApp.statusDetail);
    // Both must report the container as up.
    expect(listApp.status).toBe("up");
    expect(listApp.statusDetail).toBe("1/1 services up");
    await app.close();
  });
});
