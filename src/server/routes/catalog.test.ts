import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { CATALOG } from "@shared/catalog/index.js";
import { describe, expect, it } from "vitest";

async function ready() {
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  // `POST /api/apps`'s own read-back (`statusFor`) resolves compose to compute status;
  // stubbed the same way `apps-create.test.ts`'s `ready()` does.
  app.deps.host.composeResults.set("config --format json", {
    exitCode: 0,
    stdout: JSON.stringify({ name: "uptime-kuma", services: { "uptime-kuma": {} } }),
    stderr: "",
  });
  return { app, cookie };
}

describe("GET /api/catalog", () => {
  it("lists every catalog entry for an admin", async () => {
    const { app, cookie } = await ready();
    const res = await app.inject({ method: "GET", url: "/api/catalog", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(CATALOG.length);
    expect(body[0]).toMatchObject({
      slug: CATALOG[0]?.slug,
      name: CATALOG[0]?.name,
      description: CATALOG[0]?.description,
      iconRef: CATALOG[0]?.iconRef,
      homepage: CATALOG[0]?.homepage,
    });
    expect(body[0].compose).toBe(CATALOG[0]?.compose);
  });

  it("requires authentication", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/catalog" });
    expect(res.statusCode).toBe(401);
  });

  it("is forbidden to a viewer — the catalog is admin-only, proved by route, not by hiding a button", async () => {
    const { app, cookie } = await ready();
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "GET",
      url: "/api/catalog",
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("creating an app from a catalog entry writes that entry's compose file verbatim — the file on disk, not the form state", async () => {
    const { app, cookie } = await ready();
    const entry = CATALOG[0];
    if (!entry) throw new Error("catalog is empty");

    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie },
      payload: {
        displayName: entry.name,
        directory: entry.slug,
        description: entry.description,
        iconRef: entry.iconRef,
        compose: entry.compose,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(app.deps.host.files.get(`${entry.slug}/compose.yaml`)).toBe(entry.compose);
  });
});
