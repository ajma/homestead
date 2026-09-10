import { buildTestApp, createViewer, type FakeHost, signUpAdmin } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

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
    (app.deps.host as FakeHost).files.set(
      "jellyfin/compose.yaml",
      "services:\n  web:\n    image: nginx\n",
    );
    (app.deps.host as FakeHost).composeResults.set("config --format json", {
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

  it("refuses to adopt a directory with an invalid compose file", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    (app.deps.host as FakeHost).files.set("broken/compose.yaml", "services: {}\n");
    (app.deps.host as FakeHost).composeResults.set("config --format json", {
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
    (app.deps.host as FakeHost).files.set("jellyfin/compose.yaml", "services: {}\n");
    (app.deps.host as FakeHost).composeResults.set("config --format json", {
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
    (app.deps.host as FakeHost).files.set("jellyfin/compose.yaml", "services: {}\n");
    (app.deps.host as FakeHost).composeResults.set("config --format json", {
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
    (app.deps.host as FakeHost).files.set("a/compose.yaml", "services: {}\n");
    (app.deps.host as FakeHost).composeResults.set("config --format json", {
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

  it("refuses to delete a system app", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    (app.deps.host as FakeHost).files.set("cloudflared/compose.yaml", "services: {}\n");
    (app.deps.host as FakeHost).composeResults.set("config --format json", {
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
    await app.deps.db
      .update(await import("@server/db/schema").then((m) => m.apps))
      .set({ isSystem: true });
    const res = await app.inject({ method: "DELETE", url: `/api/apps/${id}`, headers: { cookie } });
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

  it("gives colliding directory names distinct slugs", async () => {
    // `My Media` and `My_Media` both normalise to `mymedia` — the underscore is
    // stripped, the hyphen in `my-media` is not, so THESE two are the colliding pair.
    // `apps_host_slug` is unique, so without disambiguation the second insert raised a
    // constraint violation that surfaced as a 500 mid-adopt, discarding the successes.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    (app.deps.host as FakeHost).files.set("My Media/compose.yaml", "services: {}\n");
    (app.deps.host as FakeHost).files.set("My_Media/compose.yaml", "services: {}\n");
    (app.deps.host as FakeHost).composeResults.set("config --format json", {
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
    (app.deps.host as FakeHost).files.set("nameless/compose.yaml", "services: {}\n");
    (app.deps.host as FakeHost).composeResults.set("config --format json", {
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
    (app.deps.host as FakeHost).files.set("a/compose.yaml", "services: {}\n");
    (app.deps.host as FakeHost).composeResults.set("config --format json", {
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

  it("lists every app with a single call to Docker", async () => {
    // One round trip for the whole page. Per-row lookups meant one call per app on the
    // screen that shows all of them — thirty on this NAS, every page load.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    for (const dir of ["a", "b", "c"]) {
      (app.deps.host as FakeHost).files.set(`${dir}/compose.yaml`, "services: {}\n");
    }
    (app.deps.host as FakeHost).composeResults.set("config --format json", {
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
    (app.deps.host as FakeHost).listContainersCalls = 0;
    const res = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
    expect(res.json()).toHaveLength(3);
    expect((app.deps.host as FakeHost).listContainersCalls).toBe(1);
    await app.close();
  });

  it("never shows a viewer the raw output of docker compose config", async () => {
    // Measured before the split: a viewer's statusDetail read
    // `validating /volume2/docker/jellyfin/compose.yaml: ... invalid value
    // "sk-live-9f3c8" from /volume2/docker/jellyfin/.env` — an absolute path and an
    // interpolated secret, shown to the housemate this role exists to be safe for.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    (app.deps.host as FakeHost).files.set("jellyfin/compose.yaml", "services: {}\n");
    (app.deps.host as FakeHost).composeResults.set("config --format json", {
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
    (app.deps.host as FakeHost).composeResults.set("config --format json", {
      exitCode: 1,
      stdout: "",
      stderr: secret,
    });
    (app.deps.host as FakeHost).files.set("jellyfin/compose.yaml", "services: {}\n# edited\n");

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
});
