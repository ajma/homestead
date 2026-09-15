import { exposureHostnames } from "@server/apps/exposure-hostnames";
import { createDb, runMigrations } from "@server/db/client";
import { apps, exposures, hosts } from "@server/db/schema";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

async function seed() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  await db.insert(hosts).values({ id: "local", name: "l", composeRoot: "/v", dockerSocket: "/s" });
  return db;
}

async function addApp(db: Awaited<ReturnType<typeof seed>>, slug: string) {
  const id = ulid();
  await db.insert(apps).values({
    id,
    hostId: "local",
    slug,
    displayName: slug,
    directory: slug,
    composeFile: "compose.yaml",
    projectName: slug,
  });
  return id;
}

async function addExposure(
  db: Awaited<ReturnType<typeof seed>>,
  appId: string,
  over: Partial<typeof exposures.$inferInsert> = {},
) {
  await db.insert(exposures).values({
    id: ulid(),
    appId,
    hostname: `${appId}.example.com`,
    ingressService: "http://web:80",
    ...over,
  });
}

describe("exposureHostnames", () => {
  it("returns the hostname for an app that has an exposure", async () => {
    const db = await seed();
    const appId = await addApp(db, "jellyfin");
    await addExposure(db, appId, { hostname: "jellyfin.example.com" });

    const result = await exposureHostnames(db, [appId]);
    expect(result.get(appId)).toBe("jellyfin.example.com");
  });

  it("has no entry for an app with no exposure", async () => {
    const db = await seed();
    const appId = await addApp(db, "jellyfin");

    const result = await exposureHostnames(db, [appId]);
    expect(result.has(appId)).toBe(false);
  });

  it("reports every state, not only ready", async () => {
    // The inventory column only needs "is there a hostname", not "is it fully live" —
    // the Exposure tab is where an admin goes to see or act on the state itself.
    const db = await seed();
    const appId = await addApp(db, "jellyfin");
    await addExposure(db, appId, { hostname: "jellyfin.example.com", state: "provisioning" });

    const result = await exposureHostnames(db, [appId]);
    expect(result.get(appId)).toBe("jellyfin.example.com");
  });

  it("keeps two apps' hostnames separate", async () => {
    const db = await seed();
    const jellyfin = await addApp(db, "jellyfin");
    const sonarr = await addApp(db, "sonarr");
    await addExposure(db, jellyfin, { hostname: "jellyfin.example.com" });
    await addExposure(db, sonarr, { hostname: "sonarr.example.com" });

    const result = await exposureHostnames(db, [jellyfin, sonarr]);
    expect(result.get(jellyfin)).toBe("jellyfin.example.com");
    expect(result.get(sonarr)).toBe("sonarr.example.com");
  });

  it("returns an empty map without querying when given no app ids", async () => {
    const db = await seed();
    const result = await exposureHostnames(db, []);
    expect(result.size).toBe(0);
  });
});
