import type { AuthContext } from "@server/auth/context";
import { can, canForApp, requireAdmin, visibleAppsWhere } from "@server/auth/context";
import { createDb, runMigrations } from "@server/db/client";
import { apps, hosts } from "@server/db/schema";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

const admin: AuthContext = {
  userId: "u1",
  email: "a@x",
  role: "admin",
  scopeAllApps: true,
  appIds: [],
  authPath: "password",
};
const viewerAll: AuthContext = { ...admin, userId: "u2", role: "viewer" };
const viewerScoped: AuthContext = {
  ...viewerAll,
  userId: "u3",
  scopeAllApps: false,
  appIds: ["app-a"],
};

describe("capabilities", () => {
  it("grants admins every capability", () => {
    expect(can(admin, "app:config")).toBe(true);
    expect(can(admin, "user:manage")).toBe(true);
  });

  it("limits viewers to reading", () => {
    expect(can(viewerAll, "app:read")).toBe(true);
    expect(can(viewerAll, "app:config")).toBe(false);
    expect(can(viewerAll, "app:lifecycle")).toBe(false);
    expect(can(viewerAll, "app:secrets")).toBe(false);
  });

  it("denies a scoped viewer an app outside their scope", () => {
    expect(canForApp(viewerScoped, "app:read", "app-a")).toBe(true);
    expect(canForApp(viewerScoped, "app:read", "app-b")).toBe(false);
  });

  it("grants an all-scope viewer every app", () => {
    expect(canForApp(viewerAll, "app:read", "anything")).toBe(true);
  });
});

describe("visibleAppsWhere", () => {
  async function seed() {
    const { db } = await createDb(":memory:");
    await runMigrations(db);
    const hostId = ulid();
    await db.insert(hosts).values({
      id: hostId,
      name: "local",
      composeRoot: "/x",
      dockerSocket: "/y",
    });
    for (const slug of ["a", "b", "c"]) {
      await db.insert(apps).values({
        id: `app-${slug}`,
        hostId,
        slug,
        displayName: slug,
        directory: slug,
        composeFile: "compose.yaml",
        projectName: slug,
      });
    }
    return db;
  }

  it("returns every app for an all-scope user", async () => {
    const db = await seed();
    const rows = await db.select().from(apps).where(visibleAppsWhere(viewerAll));
    expect(rows).toHaveLength(3);
  });

  it("returns only scoped apps for a scoped viewer", async () => {
    const db = await seed();
    const rows = await db.select().from(apps).where(visibleAppsWhere(viewerScoped));
    expect(rows.map((r) => r.id)).toEqual(["app-a"]);
  });

  it("returns nothing for a scoped viewer with an empty allowlist", async () => {
    const db = await seed();
    const none: AuthContext = { ...viewerScoped, appIds: [] };
    const rows = await db.select().from(apps).where(visibleAppsWhere(none));
    expect(rows).toHaveLength(0);
  });

  it("composes with other conditions", async () => {
    const db = await seed();
    const rows = await db
      .select()
      .from(apps)
      .where(and(visibleAppsWhere(viewerAll), eq(apps.slug, "b")));
    expect(rows).toHaveLength(1);
  });

  it("still yields nothing when an empty allowlist is composed with other conditions", async () => {
    const db = await seed();
    const none: AuthContext = { ...viewerScoped, appIds: [] };
    // `sql`1 = 0`` must survive being ANDed with a condition that would otherwise match.
    const rows = await db
      .select()
      .from(apps)
      .where(and(visibleAppsWhere(none), eq(apps.slug, "b")));
    expect(rows).toHaveLength(0);
  });
});

describe("requireAdmin and requireCapability cannot diverge", () => {
  it("admin passes both, viewer fails both", () => {
    const asRequest = (auth: AuthContext) => ({ auth }) as unknown as FastifyRequest;
    expect(() => requireAdmin(asRequest(admin))).not.toThrow();
    expect(can(admin, "user:manage")).toBe(true);
    expect(() => requireAdmin(asRequest(viewerAll))).toThrow();
    expect(can(viewerAll, "user:manage")).toBe(false);
  });
});
