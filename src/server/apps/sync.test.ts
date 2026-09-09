import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "../db/client.js";
import { monitors } from "../db/schema.js";
import { syncAppMonitors } from "./sync.js";

describe("syncAppMonitors", () => {
  it("provisions monitors for a project's apps end to end", async () => {
    const db = createDb(":memory:");
    await runMigrations(db);
    const created = await syncAppMonitors(db, {
      listProjects: async () => ["media"],
      composeConfig: async () => ({
        services: {
          jellyfin: { ports: [{ published: "8096", target: 8096 }] },
        },
      }),
      hostnameFor: async () => null,
    });
    expect(created.created).toBe(2);
    const rows = await db.select().from(monitors);
    expect(rows.map((r) => r.type).sort()).toEqual(["docker", "http"]);
    expect(rows.every((r) => r.targetType === "app")).toBe(true);
    expect(rows.every((r) => r.targetId === "media:jellyfin")).toBe(true);
  });

  it("removes a monitor when its service loses its port", async () => {
    const db = createDb(":memory:");
    await runMigrations(db);
    const withPort = {
      services: { jellyfin: { ports: [{ published: "8096", target: 8096 }] } },
    };
    const deps = (config: unknown) => ({
      listProjects: async () => ["media"],
      composeConfig: async () => config,
      hostnameFor: async () => null,
    });

    await syncAppMonitors(db, deps(withPort));
    expect(await db.select().from(monitors)).toHaveLength(2);

    // The port is gone from the compose file.
    const r = await syncAppMonitors(db, deps({ services: { jellyfin: {} } }));
    expect(r.removed).toBe(2);
    expect(await db.select().from(monitors)).toHaveLength(0);
  });

  it("leaves a user-edited monitor alone", async () => {
    // Changing an interval or marking a monitor advisory is a deliberate act.
    // A rewrite-everything implementation would silently undo it.
    const db = createDb(":memory:");
    await runMigrations(db);
    const deps = {
      listProjects: async () => ["media"],
      composeConfig: async () => ({
        services: {
          jellyfin: { ports: [{ published: "8096", target: 8096 }] },
        },
      }),
      hostnameFor: async () => null,
    };

    await syncAppMonitors(db, deps);
    const [probe] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.type, "http"));
    if (!probe)
      throw new Error("expected an http monitor after the first sync");
    await db
      .update(monitors)
      .set({ intervalSeconds: 600, required: false })
      .where(eq(monitors.id, probe.id));

    await syncAppMonitors(db, deps);

    const [after] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, probe.id));
    expect(after).toMatchObject({ intervalSeconds: 600, required: false });
  });

  it("does not delete monitors when the compose file will not parse", async () => {
    // A syntax error is not evidence that the apps are gone. Treating it as
    // "this project has no services" would delete every monitor and its history.
    const db = createDb(":memory:");
    await runMigrations(db);
    const good = {
      services: { jellyfin: { ports: [{ published: "8096", target: 8096 }] } },
    };
    await syncAppMonitors(db, {
      listProjects: async () => ["media"],
      composeConfig: async () => good,
      hostnameFor: async () => null,
    });
    expect(await db.select().from(monitors)).toHaveLength(2);

    const r = await syncAppMonitors(db, {
      listProjects: async () => ["media"],
      composeConfig: async () => {
        throw new Error("yaml: line 3: mapping values are not allowed here");
      },
      hostnameFor: async () => null,
    });

    expect(r.removed).toBe(0);
    expect(await db.select().from(monitors)).toHaveLength(2);
  });

  it("updates monitor config when port changes, preserving user edits", async () => {
    // When a service moves from port 8096 to 9096, the http monitor
    // must point at the new port. But a user-edited intervalSeconds must survive.
    const db = createDb(":memory:");
    await runMigrations(db);
    const deps = (port: string) => ({
      listProjects: async () => ["media"],
      composeConfig: async () => ({
        services: { jellyfin: { ports: [{ published: port, target: 8096 }] } },
      }),
      hostnameFor: async () => null,
    });

    // Sync at port 8096
    await syncAppMonitors(db, deps("8096"));
    const [probe] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.type, "http"));
    if (!probe) throw new Error("expected an http monitor");

    // User edits the interval
    await db
      .update(monitors)
      .set({ intervalSeconds: 600 })
      .where(eq(monitors.id, probe.id));

    // Port changes to 9096
    await syncAppMonitors(db, deps("9096"));

    const [updated] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, probe.id));
    expect(updated?.config).toBe(
      JSON.stringify({ url: "http://127.0.0.1:9096" }),
    );
    expect(updated?.intervalSeconds).toBe(600);
  });

  it("does not touch project B when reconciling project A", async () => {
    // Multi-project isolation: reconciling media must not delete or update
    // monitors for dev, even though both are synced in the same pass.
    const db = createDb(":memory:");
    await runMigrations(db);
    const deps = {
      listProjects: async () => ["media", "dev"],
      composeConfig: async (slug: string) => {
        if (slug === "media") {
          return {
            services: {
              jellyfin: { ports: [{ published: "8096", target: 8096 }] },
            },
          };
        }
        return {
          services: { nginx: { ports: [{ published: "80", target: 80 }] } },
        };
      },
      hostnameFor: async () => null,
    };

    await syncAppMonitors(db, deps);
    const mediaMonitors = await db
      .select()
      .from(monitors)
      .where(eq(monitors.targetId, "media:jellyfin"));
    const devMonitors = await db
      .select()
      .from(monitors)
      .where(eq(monitors.targetId, "dev:nginx"));

    expect(mediaMonitors).toHaveLength(2);
    expect(devMonitors).toHaveLength(2);
  });

  it("reconciles other projects when one throws a parse error", async () => {
    // A sweep that aborts on the first bad compose file would silently stop
    // provisioning for everything after it.
    const db = createDb(":memory:");
    await runMigrations(db);
    const deps = {
      listProjects: async () => ["media", "dev"],
      composeConfig: async (slug: string) => {
        if (slug === "media") {
          throw new Error("yaml: unexpected indent");
        }
        return {
          services: { nginx: { ports: [{ published: "80", target: 80 }] } },
        };
      },
      hostnameFor: async () => null,
    };

    await syncAppMonitors(db, deps);

    // media has no monitors (compose failed)
    const mediaMonitors = await db
      .select()
      .from(monitors)
      .where(eq(monitors.targetId, "media:jellyfin"));
    expect(mediaMonitors).toHaveLength(0);

    // dev still got reconciled
    const devMonitors = await db
      .select()
      .from(monitors)
      .where(eq(monitors.targetId, "dev:nginx"));
    expect(devMonitors).toHaveLength(2);
  });
});
