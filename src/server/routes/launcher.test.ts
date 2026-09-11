import { apps, probes } from "@server/db/schema";
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
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

  it("ignores a disabled probe rather than pinning the tile to its last status", async () => {
    // A disabled probe is not evidence of anything — the comment on query.ts says so —
    // but nothing bound that until now: deleting the filter left the whole suite green.
    const { app, cookie, id } = await seeded();
    await app.deps.db
      .update(probes)
      .set({ lastStatus: "down", lastFaultClass: "app", statusSince: 111, enabled: false })
      .where(eq(probes.appId, id));
    const [tile] = (
      await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie } })
    ).json().apps;
    expect(tile).toMatchObject({ status: "unknown", reason: "Not checked yet" });
  });
});

describe("GET /api/launcher/:appId/health", () => {
  it("returns the signals for an app the caller can see", async () => {
    const { app, cookie, id } = await seeded();
    const res = await app.inject({
      method: "GET",
      url: `/api/launcher/${id}/health`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().signals).toHaveLength(1);
    expect(res.json().history).toHaveLength(30);
  });

  it("404s for an app outside the caller's scope, never 403", async () => {
    // A 403 would confirm the app exists. For a scoped viewer that is the disclosure
    // the scope exists to prevent.
    const { app, cookie, id } = await seeded();
    const scoped = await createViewer(app, cookie, { scopeAllApps: false, appIds: [] });
    const res = await app.inject({
      method: "GET",
      url: `/api/launcher/${id}/health`,
      headers: { cookie: scoped.cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("404s identically for an app that does not exist", async () => {
    const { app, cookie } = await seeded();
    const res = await app.inject({
      method: "GET",
      url: `/api/launcher/${ulid()}/health`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("404s for an app hidden from the launcher, so the two routes agree on what 'hidden' means", async () => {
    const { app, cookie, id } = await seeded();
    await app.deps.db.update(apps).set({ showOnLauncher: false }).where(eq(apps.id, id));
    const res = await app.inject({
      method: "GET",
      url: `/api/launcher/${id}/health`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s for an archived app", async () => {
    const { app, cookie, id } = await seeded();
    await app.deps.db.update(apps).set({ archivedAt: 1 }).where(eq(apps.id, id));
    const res = await app.inject({
      method: "GET",
      url: `/api/launcher/${id}/health`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("launcher ordering", () => {
  it("puts fully-tied apps in a stable, total order", async () => {
    // Same category, same sortOrder, same displayName: the first three sort keys all
    // tie, and the underlying select carries no ORDER BY. Without an id tiebreaker the
    // grid can reshuffle between refreshes, which users notice and cannot reproduce.
    const { app, cookie } = await seeded();
    const [existing] = await app.deps.db.select().from(apps);
    if (!existing) throw new Error("fixture did not adopt an app");

    for (const suffix of ["b", "a", "c"]) {
      await app.deps.db.insert(apps).values({
        ...existing,
        id: `tie-${suffix}`,
        slug: `tie-${suffix}`,
        directory: `tie-${suffix}`,
        displayName: "Same Name",
        category: "Tied",
        sortOrder: 0,
      });
    }

    const order = async () =>
      (await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie } }))
        .json()
        .apps.filter((a: { category: string | null }) => a.category === "Tied")
        .map((a: { id: string }) => a.id);

    expect(await order()).toEqual(["tie-a", "tie-b", "tie-c"]);
    expect(await order()).toEqual(await order());
  });
});
