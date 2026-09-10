import { createDb, runMigrations } from "@server/db/client";
import { apps, hosts, probes, users } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

async function freshDb() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  return db;
}

describe("schema", () => {
  it("defaults a new user to viewer with full scope", async () => {
    const db = await freshDb();
    const id = ulid();
    await db.insert(users).values({ id, name: "Ada", email: "ada@example.com" });
    const [row] = await db.select().from(users);
    expect(row?.role).toBe("viewer");
    expect(row?.scopeAllApps).toBe(true);
  });

  it("rejects two apps sharing a slug on one host", async () => {
    const db = await freshDb();
    const hostId = ulid();
    await db.insert(hosts).values({
      id: hostId,
      name: "local",
      composeRoot: "/volume2/docker",
      dockerSocket: "/var/run/docker.sock",
    });
    const row = (slug: string) => ({
      id: ulid(),
      hostId,
      slug,
      displayName: slug,
      directory: slug,
      composeFile: "compose.yaml",
      projectName: slug,
    });
    await db.insert(apps).values(row("jellyfin"));
    await expect(db.insert(apps).values(row("jellyfin"))).rejects.toThrow();
  });

  it("cascades probe deletion when an app is removed", async () => {
    const db = await freshDb();
    const hostId = ulid();
    await db.insert(hosts).values({
      id: hostId,
      name: "local",
      composeRoot: "/volume2/docker",
      dockerSocket: "/var/run/docker.sock",
    });
    const appId = ulid();
    await db.insert(apps).values({
      id: appId,
      hostId,
      slug: "immich",
      displayName: "Immich",
      directory: "immich",
      composeFile: "compose.yaml",
      projectName: "immich",
    });
    await db.insert(probes).values({ id: ulid(), appId, kind: "docker" });
    await db.delete(apps).where(eq(apps.id, appId));
    expect(await db.select().from(probes)).toHaveLength(0);
  });
});
