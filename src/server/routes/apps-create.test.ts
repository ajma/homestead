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

  it("survives two concurrent creates for different directories", async () => {
    // The adopt route wraps its transaction in `retryOnBusy`; before this fix, create did
    // not. Two ordinary, non-conflicting creates fired together must both succeed rather
    // than one losing a database-internal race that has nothing to do with either
    // directory.
    const { app, cookie } = await ready();
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/apps",
        headers: { cookie },
        payload: { displayName: "Jellyfin", directory: "jellyfin" },
      }),
      app.inject({
        method: "POST",
        url: "/api/apps",
        headers: { cookie },
        payload: { displayName: "Immich", directory: "immich" },
      }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
  });

  it("survives a competing transaction opening on the shared connection mid-create", async () => {
    // libSQL's `:memory:` client has exactly one physical connection (see `db/retry.ts`):
    // two `db.transaction()` calls at once always collide, and in production this is the
    // scheduler's own probe-persistence transaction landing at the same moment a create
    // is in flight, not another instance of this same route. Reproduced directly rather
    // than by racing two HTTP requests against each other: two injected requests rarely
    // land close enough in wall-clock time in this in-process harness to force a genuine
    // collision, whereas firing a bystander transaction at the exact instant this route
    // opens its own reproduces the ONE scenario `retryOnBusy` exists for, deterministically.
    //
    // Measured: without `retryOnBusy` around this route's transaction, this test fails
    // every time with a raw 500 (`LibsqlError: TRANSACTION_ACTIVE`), not intermittently.
    const { app, cookie } = await ready();
    const originalTransaction = app.deps.db.transaction.bind(app.deps.db);
    let triggered = false;
    // biome-ignore lint/suspicious/noExplicitAny: narrow test double over db.transaction
    (app.deps.db as any).transaction = (fn: any) => {
      if (!triggered) {
        triggered = true;
        // Fire-and-forget, deliberately not awaited: a bystander transaction opening on
        // the shared connection at the exact instant the create route opens its own.
        void originalTransaction(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
      }
      return originalTransaction(fn);
    };
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/apps",
        headers: { cookie },
        payload: { displayName: "Jellyfin", directory: "jellyfin" },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (app.deps.db as any).transaction = originalTransaction;
    }
  });

  it("resolves two concurrent creates of the SAME directory into one 201 and one clean 409", async () => {
    // Not a 500, and not a raw SQL message: `apps_host_directory` is unique, but the
    // constraint is never what actually fires here — `writeTextFile`'s own hash guard is
    // a single-writer gate that only lets one of the two racing writes land, and the
    // loser must come back as the ordinary "already exists" response, not a crash.
    const { app, cookie } = await ready();
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/apps",
        headers: { cookie },
        payload: { displayName: "Jellyfin", directory: "jellyfin" },
      }),
      app.inject({
        method: "POST",
        url: "/api/apps",
        headers: { cookie },
        payload: { displayName: "Jellyfin Two", directory: "jellyfin" },
      }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error).toBe("directory_exists");
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
