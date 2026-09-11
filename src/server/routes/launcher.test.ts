import { apps, probes } from "@server/db/schema";
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

async function seeded() {
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
  return { app, cookie, id: adopted.json().adopted[0].id as string };
}

describe("GET /api/launcher", () => {
  it("never calls Docker, so a wedged socket cannot take the launcher down", async () => {
    const { app, cookie } = await seeded();
    let dockerCalls = 0;
    app.deps.host.listContainers = async () => {
      dockerCalls++;
      throw new Error("docker socket is wedged");
    };
    const res = await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(dockerCalls).toBe(0);
    expect(res.json().apps).toHaveLength(1);
  });

  it("reports the probe's denormalised status, not a live rollup", async () => {
    const { app, cookie, id } = await seeded();
    await app.deps.db
      .update(probes)
      .set({ lastStatus: "down", lastFaultClass: "app", statusSince: 4242 })
      .where(eq(probes.appId, id));
    const [tile] = (
      await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie } })
    ).json().apps;
    expect(tile).toMatchObject({ status: "down", reason: "Containers not running", since: 4242 });
  });

  it("omits apps hidden from the launcher", async () => {
    const { app, cookie, id } = await seeded();
    await app.deps.db.update(apps).set({ showOnLauncher: false }).where(eq(apps.id, id));
    expect(
      (await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie } })).json().apps,
    ).toEqual([]);
  });

  it("omits archived apps", async () => {
    const { app, cookie, id } = await seeded();
    await app.deps.db.update(apps).set({ archivedAt: 1 }).where(eq(apps.id, id));
    expect(
      (await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie } })).json().apps,
    ).toEqual([]);
  });

  it("shows a scoped viewer only their apps", async () => {
    const { app, cookie } = await seeded();
    const scoped = await createViewer(app, cookie, { scopeAllApps: false, appIds: [] });
    const res = await app.inject({
      method: "GET",
      url: "/api/launcher",
      headers: { cookie: scoped.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().apps).toEqual([]);
  });

  it("leaks no operational fields to a viewer", async () => {
    const { app, cookie } = await seeded();
    const viewer = await createViewer(app, cookie);
    const [tile] = (
      await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie: viewer.cookie } })
    ).json().apps;
    for (const forbidden of ["directory", "composeFile", "projectName", "hostId", "lastDetail"]) {
      expect(Object.keys(tile)).not.toContain(forbidden);
    }
  });

  it("reports unknown for an app with no probes rather than up", async () => {
    const { app, cookie, id } = await seeded();
    await app.deps.db.delete(probes).where(eq(probes.appId, id));
    const [tile] = (
      await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie } })
    ).json().apps;
    expect(tile).toMatchObject({ status: "unknown", reason: "Not checked yet" });
  });

  it("requires authentication", async () => {
    const { app } = await seeded();
    expect((await app.inject({ method: "GET", url: "/api/launcher" })).statusCode).toBe(401);
  });
});
