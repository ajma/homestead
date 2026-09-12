import { runningJobs } from "@server/apps/running-jobs";
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
  const id = ulid();
  await db.insert(jobs).values({
    id,
    appId,
    kind: "up",
    status: "running",
    ...over,
  });
  return id;
}

describe("runningJobs", () => {
  it("returns the running job's id for an app with one", async () => {
    const db = await seed();
    const appId = await addApp(db, "jellyfin");
    const jobId = await addJob(db, appId);

    const result = await runningJobs(db, [appId]);
    expect(result.get(appId)).toBe(jobId);
  });

  it("is absent for an app with only succeeded and failed jobs", async () => {
    const db = await seed();
    const appId = await addApp(db, "jellyfin");
    await addJob(db, appId, { status: "succeeded" });
    await addJob(db, appId, { status: "failed" });

    const result = await runningJobs(db, [appId]);
    expect(result.has(appId)).toBe(false);
  });

  it("is absent for an app with no jobs at all", async () => {
    const db = await seed();
    const appId = await addApp(db, "jellyfin");

    const result = await runningJobs(db, [appId]);
    expect(result.has(appId)).toBe(false);
  });

  it("returns an empty map without querying when given no app ids", async () => {
    const db = await seed();
    const result = await runningJobs(db, []);
    expect(result.size).toBe(0);
  });

  it("only includes requested apps, even when another app has a running job", async () => {
    const db = await seed();
    const requested = await addApp(db, "jellyfin");
    const other = await addApp(db, "gitea");
    await addJob(db, other);

    const result = await runningJobs(db, [requested]);
    expect(result.has(other)).toBe(false);
    expect(result.size).toBe(0);
  });

  it("returns two apps' own running jobs, not one overwritten by the other", async () => {
    const db = await seed();
    const appA = await addApp(db, "jellyfin");
    const appB = await addApp(db, "gitea");
    const jobA = await addJob(db, appA);
    const jobB = await addJob(db, appB);

    const result = await runningJobs(db, [appA, appB]);
    expect(result.get(appA)).toBe(jobA);
    expect(result.get(appB)).toBe(jobB);
  });
});
