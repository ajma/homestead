import { apps } from "@server/db/schema";
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

async function ready() {
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  app.deps.host.composeResults.set("config --format json", {
    exitCode: 0,
    stdout: JSON.stringify({ name: "jellyfin", services: { jellyfin: {} } }),
    stderr: "",
  });
  return { app, cookie };
}

describe("POST /api/apps", () => {
  it("creates the directory, writes a compose file, and returns the app", async () => {
    const { app, cookie } = await ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie },
      payload: { displayName: "Jellyfin", directory: "jellyfin" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ displayName: "Jellyfin", directory: "jellyfin" });
    expect(app.deps.host.files.get("jellyfin/compose.yaml")).toContain("services:");
  });

  it("refuses a directory that already exists rather than overwriting it", async () => {
    // Overwriting someone's compose file because they reused a name is unrecoverable
    // from inside Homestead — there is no undo and no editor until Phase 1F.
    const { app, cookie } = await ready();
    app.deps.host.files.set("jellyfin/compose.yaml", "services: { existing: {} }\n");
    const res = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie },
      payload: { displayName: "Jellyfin", directory: "jellyfin" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("directory_exists");
    expect(app.deps.host.files.get("jellyfin/compose.yaml")).toContain("existing");
  });

  it("rejects a directory that escapes the compose root", async () => {
    const { app, cookie } = await ready();
    for (const directory of ["../etc", "a/../../etc", "/etc", "a/b"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/apps",
        headers: { cookie },
        payload: { displayName: "X", directory },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBeTruthy();
    }
  });

  it("leaves no half-created app when the compose write fails", async () => {
    const { app, cookie } = await ready();
    app.deps.host.writeTextFile = async () => {
      throw new Error("disk full");
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie },
      payload: { displayName: "Jellyfin", directory: "jellyfin" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(await app.deps.db.select().from(apps).where(eq(apps.directory, "jellyfin"))).toEqual([]);
  });

  it("creates one enabled docker probe, like adoption does", async () => {
    // An app invisible to monitoring is the bug the probe exists to prevent, and a
    // created app is no different from an adopted one in that respect.
    const { app, cookie } = await ready();
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie },
      payload: { displayName: "Jellyfin", directory: "jellyfin" },
    });
    const probes = await app.inject({
      method: "GET",
      url: `/api/apps/${created.json().id}/probes`,
      headers: { cookie },
    });
    expect(probes.json()).toHaveLength(1);
    expect(probes.json()[0]).toMatchObject({ kind: "docker", enabled: true });
  });

  it("is forbidden to a viewer", async () => {
    const { app, cookie } = await ready();
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie: viewer.cookie },
      payload: { displayName: "X", directory: "x" },
    });
    expect(res.statusCode).toBe(403);
  });
});
