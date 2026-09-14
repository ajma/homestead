import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { CATALOGUE } from "@shared/catalogue/index.js";
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

describe("GET /api/catalogue", () => {
  it("lists every catalogue entry for an admin", async () => {
    const { app, cookie } = await ready();
    const res = await app.inject({ method: "GET", url: "/api/catalogue", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(CATALOGUE.length);
    expect(body[0]).toMatchObject({
      slug: CATALOGUE[0]?.slug,
      name: CATALOGUE[0]?.name,
      description: CATALOGUE[0]?.description,
      iconRef: CATALOGUE[0]?.iconRef,
      homepage: CATALOGUE[0]?.homepage,
    });
    expect(body[0].compose).toBe(CATALOGUE[0]?.compose);
  });

  it("requires authentication", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/catalogue" });
    expect(res.statusCode).toBe(401);
  });

  it("is forbidden to a viewer — the catalogue is admin-only, proved by route, not by hiding a button", async () => {
    const { app, cookie } = await ready();
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "GET",
      url: "/api/catalogue",
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("creating an app from a catalogue entry writes that entry's compose file verbatim — the file on disk, not the form state", async () => {
    const { app, cookie } = await ready();
    const entry = CATALOGUE[0];
    if (!entry) throw new Error("catalogue is empty");

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
