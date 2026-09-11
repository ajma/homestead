import { deployTimestamps } from "@server/apps/deploy-timestamps";
import { createDb, runMigrations } from "@server/db/client";
import { apps, hosts, jobs } from "@server/db/schema";
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

async function addJob(
  db: Awaited<ReturnType<typeof seed>>,
  appId: string,
  over: Partial<typeof jobs.$inferInsert> = {},
) {
  await db.insert(jobs).values({
    id: ulid(),
    appId,
    kind: "up",
    status: "succeeded",
    finishedAt: 1_000,
    ...over,
  });
}

describe("deployTimestamps", () => {
  it("returns the finish time of a succeeded up job", async () => {
    const db = await seed();
    const appId = await addApp(db, "jellyfin");
    await addJob(db, appId, { finishedAt: 12_345 });

    const result = await deployTimestamps(db, [appId]);
    expect(result.get(appId)).toBe(12_345);
  });

  it("does not count a pull as a deploy", async () => {
    const db = await seed();
    const appId = await addApp(db, "jellyfin");
    await addJob(db, appId, { kind: "pull", finishedAt: 999 });

    const result = await deployTimestamps(db, [appId]);
    expect(result.has(appId)).toBe(false);
  });

  it("does not count a failed up as a deploy", async () => {
    const db = await seed();
    const appId = await addApp(db, "jellyfin");
    await addJob(db, appId, { status: "failed", finishedAt: 999 });

    const result = await deployTimestamps(db, [appId]);
    expect(result.has(appId)).toBe(false);
  });

  it("picks the later of two succeeded deploys", async () => {
    const db = await seed();
    const appId = await addApp(db, "jellyfin");
    await addJob(db, appId, { finishedAt: 100 });
    await addJob(db, appId, { kind: "restart", finishedAt: 200 });

    const result = await deployTimestamps(db, [appId]);
    expect(result.get(appId)).toBe(200);
  });

  it("has no entry for an app with no jobs at all", async () => {
    const db = await seed();
    const appId = await addApp(db, "jellyfin");

    const result = await deployTimestamps(db, [appId]);
    expect(result.has(appId)).toBe(false);
  });

  it("returns an empty map without querying when given no app ids", async () => {
    const db = await seed();
    const result = await deployTimestamps(db, []);
    expect(result.size).toBe(0);
  });
});
