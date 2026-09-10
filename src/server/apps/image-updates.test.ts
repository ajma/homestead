import { ComposeConfigCache } from "@server/apps/compose-config";
import { ImageUpdateChecker } from "@server/apps/image-updates";
import { createDb, runMigrations } from "@server/db/client";
import { apps, hosts, imageStatus } from "@server/db/schema";
import { FakeHost } from "@server/test-helpers";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

const CONFIG = JSON.stringify({
  name: "jellyfin",
  services: { web: { image: "nginx:alpine" }, db: { image: "postgres:16" } },
});

async function seed() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  await db.insert(hosts).values({ id: "local", name: "l", composeRoot: "/v", dockerSocket: "/s" });
  const row = {
    id: ulid(),
    hostId: "local",
    slug: "jellyfin",
    displayName: "J",
    directory: "jellyfin",
    composeFile: "compose.yaml",
    projectName: "jellyfin",
  };
  await db.insert(apps).values(row);
  const [app] = await db.select().from(apps).where(eq(apps.id, row.id));
  if (!app) throw new Error("seed failed");

  const host = new FakeHost();
  host.files.set("jellyfin/compose.yaml", "services: {}\n");
  host.composeResults.set("config --format json", { exitCode: 0, stdout: CONFIG, stderr: "" });
  return { db, host, app };
}

describe("ImageUpdateChecker", () => {
  it("flags a service whose registry digest differs from the local one", async () => {
    const { db, host, app } = await seed();
    host.images.set("nginx:alpine", { id: "sha256:local", repoDigests: ["nginx@sha256:old"] });
    host.images.set("postgres:16", { id: "sha256:local2", repoDigests: ["postgres@sha256:same"] });
    const checker = new ImageUpdateChecker({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      registry: {
        latestDigest: async (image) => (image === "nginx:alpine" ? "sha256:new" : "sha256:same"),
      },
    });

    await checker.check(app);
    const rows = await db.select().from(imageStatus).where(eq(imageStatus.appId, app.id));
    expect(rows).toHaveLength(2);
    const web = rows.find((r) => r.serviceName === "web");
    expect(web).toMatchObject({
      currentDigest: "sha256:old",
      latestDigest: "sha256:new",
      updateAvailable: true,
    });
    expect(rows.find((r) => r.serviceName === "db")?.updateAvailable).toBe(false);
  });

  it("does not claim an update when the registry cannot be reached", async () => {
    // A null digest means "unknown", and reporting unknown as "update available" would
    // train the user to ignore the badge.
    const { db, host, app } = await seed();
    host.images.set("nginx:alpine", { id: "x", repoDigests: ["nginx@sha256:old"] });
    const checker = new ImageUpdateChecker({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      registry: { latestDigest: async () => null },
    });
    await checker.check(app);
    const [web] = await db
      .select()
      .from(imageStatus)
      .where(and(eq(imageStatus.appId, app.id), eq(imageStatus.serviceName, "web")));
    expect(web?.updateAvailable).toBe(false);
    expect(web?.latestDigest).toBeNull();
    expect(web?.checkedAt).toBeGreaterThan(0);
  });

  it("does not claim an update when the image was never pulled", async () => {
    const { db, host, app } = await seed();
    const checker = new ImageUpdateChecker({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      registry: { latestDigest: async () => "sha256:new" },
    });
    await checker.check(app);
    const [web] = await db
      .select()
      .from(imageStatus)
      .where(and(eq(imageStatus.appId, app.id), eq(imageStatus.serviceName, "web")));
    expect(web?.currentDigest).toBeNull();
    expect(web?.updateAvailable).toBe(false);
  });

  it("compares the digest for the repository actually being checked", async () => {
    // An image tagged into two repositories carries one RepoDigests entry per
    // repository. Taking index 0 compares a Docker Hub digest against one fetched from a
    // private registry — they never match, so the app shows an update that pulling can
    // never clear. A badge that never clears teaches the user to ignore every badge.
    const { db, host, app } = await seed();
    host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({
        name: "jellyfin",
        services: { web: { image: "myregistry.example.com/nginx:alpine" } },
      }),
      stderr: "",
    });
    host.images.set("myregistry.example.com/nginx:alpine", {
      id: "x",
      repoDigests: ["nginx@sha256:hub", "myregistry.example.com/nginx@sha256:private"],
    });
    const checker = new ImageUpdateChecker({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      registry: { latestDigest: async () => "sha256:private" },
    });
    await checker.check(app);
    const [web] = await db.select().from(imageStatus).where(eq(imageStatus.appId, app.id));
    expect(web?.currentDigest).toBe("sha256:private");
    expect(web?.updateAvailable).toBe(false);
  });

  it("records a service whose local inspect throws, rather than omitting it", async () => {
    // A wedged Docker socket throws from inspectImage. Skipping the row leaves the
    // service silently absent from the panel, which reads as "not checked" rather than
    // "checked, could not tell".
    const { db, host, app } = await seed();
    host.inspectImageErrors.set("postgres:16", new Error("connect ENOENT"));
    const checker = new ImageUpdateChecker({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      registry: { latestDigest: async () => "sha256:new" },
    });
    await expect(checker.check(app)).resolves.toBeUndefined();
    const rows = await db.select().from(imageStatus).where(eq(imageStatus.appId, app.id));
    const db16 = rows.find((r) => r.serviceName === "db");
    expect(db16).toBeDefined();
    expect(db16?.currentDigest).toBeNull();
    expect(db16?.updateAvailable).toBe(false);
    expect(db16?.checkedAt).toBeGreaterThan(0);
  });

  it("forgets a service the compose file no longer declares", async () => {
    const { db, host, app } = await seed();
    host.images.set("nginx:alpine", { id: "x", repoDigests: ["nginx@sha256:old"] });
    const checker = new ImageUpdateChecker({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      registry: { latestDigest: async () => "sha256:new" },
    });
    await checker.check(app);
    expect(await db.select().from(imageStatus).where(eq(imageStatus.appId, app.id))).toHaveLength(
      2,
    );

    // `db` is dropped from the file.
    host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "jellyfin", services: { web: { image: "nginx:alpine" } } }),
      stderr: "",
    });
    host.files.set("jellyfin/compose.yaml", "services: {}\n# changed\n");
    await checker.check(app);
    const rows = await db.select().from(imageStatus).where(eq(imageStatus.appId, app.id));
    // Otherwise the removed service keeps advertising an update for something gone.
    expect(rows.map((r) => r.serviceName)).toEqual(["web"]);
  });

  it("re-running replaces rather than duplicating", async () => {
    const { db, host, app } = await seed();
    host.images.set("nginx:alpine", { id: "x", repoDigests: ["nginx@sha256:old"] });
    const checker = new ImageUpdateChecker({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      registry: { latestDigest: async () => "sha256:new" },
    });
    await checker.check(app);
    await checker.check(app);
    expect(await db.select().from(imageStatus).where(eq(imageStatus.appId, app.id))).toHaveLength(
      2,
    );
  });

  it("does not throw when the database write fails", async () => {
    // `check()` is documented as never throwing, and 1C calls it in a loop over every
    // app — so a locked database or a full disk on one app must not end the sweep for
    // everything after it. The upsert lives inside the per-service guard for this
    // reason; a comment promising the contract is not the same as providing it.
    const { db, host, app } = await seed();
    host.images.set("nginx:alpine", { id: "x", repoDigests: ["nginx@sha256:old"] });
    const original = db.insert.bind(db);
    // biome-ignore lint/suspicious/noExplicitAny: narrow test double over one method
    (db as any).insert = () => {
      throw new Error("SQLITE_BUSY: database is locked");
    };
    try {
      const checker = new ImageUpdateChecker({
        db,
        host,
        composeConfig: new ComposeConfigCache(host),
        registry: { latestDigest: async () => "sha256:new" },
      });
      await expect(checker.check(app)).resolves.toBeUndefined();
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (db as any).insert = original;
    }
  });

  it("does nothing and does not throw when the compose file will not resolve", async () => {
    const { db, host, app } = await seed();
    host.composeResults.set("config --format json", { exitCode: 1, stdout: "", stderr: "bad" });
    const checker = new ImageUpdateChecker({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      registry: { latestDigest: async () => "sha256:new" },
    });
    await expect(checker.check(app)).resolves.toBeUndefined();
    expect(await db.select().from(imageStatus)).toEqual([]);
  });

  it("does nothing and does not throw when the compose file cannot be read", async () => {
    // Rename compose.yaml over SSH, or let the SMB mount return EIO. Without a guard,
    // `resolve()` throws despite the doc-block saying check() never does. Consequence for
    // 1C: the scheduled sweep dies at the first moved file and never reaches the rest.
    const { db, host, app } = await seed();
    host.readTextFileErrors.set("jellyfin/compose.yaml", new Error("ENOENT: no such file"));
    const checker = new ImageUpdateChecker({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      registry: { latestDigest: async () => "sha256:new" },
    });
    await expect(checker.check(app)).resolves.toBeUndefined();
    expect(await db.select().from(imageStatus)).toEqual([]);
  });
});
