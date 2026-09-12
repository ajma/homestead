import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { apps, hosts, jobs } from "../db/schema.js";
import { sweepStrandedJobs } from "./sweep.js";

const NOW = 1_700_000_000;

// The brief's seed shape assumed `hosts.name`/`apps.slug` alone; the schema also requires
// `composeRoot`/`dockerSocket` on hosts and `displayName`/`projectName` on apps (no
// defaults), matching the `seed()` helper in job-runner.test.ts. Adapted, values preserved.
async function seedApp(db: Db, id: string): Promise<void> {
  await db
    .insert(hosts)
    .values({ id: "host-1", name: "local", kind: "local", composeRoot: "/v", dockerSocket: "/s" })
    .onConflictDoNothing();
  await db.insert(apps).values({
    id,
    hostId: "host-1",
    slug: id,
    displayName: id,
    directory: id,
    composeFile: "compose.yaml",
    projectName: id,
  });
}

describe("sweepStrandedJobs", () => {
  let db: Db;

  beforeEach(async () => {
    ({ db } = await createDb(":memory:"));
    await runMigrations(db);
    await seedApp(db, "app-1");
  });

  it("marks a row stranded at running as failed, naming the interruption", async () => {
    await db.insert(jobs).values({
      id: "job-1",
      appId: "app-1",
      kind: "up",
      status: "running",
      startedAt: NOW - 60,
    });

    const repaired = await sweepStrandedJobs(db, NOW);

    expect(repaired).toBe(1);
    const [row] = await db.select().from(jobs);
    if (!row) throw new Error("expected a job row");
    expect(row.status).toBe("failed");
    expect(row.finishedAt).toBe(NOW);
    expect(row.output).toContain("interrupted");
  });

  it("repairs a queued row too", async () => {
    await db.insert(jobs).values({ id: "job-2", appId: "app-1", kind: "pull", status: "queued" });

    expect(await sweepStrandedJobs(db, NOW)).toBe(1);
    const [row] = await db.select().from(jobs);
    if (!row) throw new Error("expected a job row");
    expect(row.status).toBe("failed");
  });

  it("leaves a job that already finished completely alone", async () => {
    await db.insert(jobs).values({
      id: "job-3",
      appId: "app-1",
      kind: "up",
      status: "succeeded",
      startedAt: NOW - 120,
      finishedAt: NOW - 100,
      exitCode: 0,
      output: "done",
    });

    expect(await sweepStrandedJobs(db, NOW)).toBe(0);
    const [row] = await db.select().from(jobs);
    expect(row).toMatchObject({
      status: "succeeded",
      finishedAt: NOW - 100,
      exitCode: 0,
      output: "done",
    });
  });

  it("does not overwrite a failed job's own output with the sweep message", async () => {
    await db.insert(jobs).values({
      id: "job-4",
      appId: "app-1",
      kind: "up",
      status: "failed",
      finishedAt: NOW - 50,
      exitCode: 1,
      output: "service web failed to start",
    });

    await sweepStrandedJobs(db, NOW);
    const [row] = await db.select().from(jobs);
    if (!row) throw new Error("expected a job row");
    expect(row.output).toBe("service web failed to start");
  });

  it("repairs a stranded step job the same as a stranded compose job", async () => {
    // The sweep's predicate is `jobs.status`, which does not read `kind` at all — so a
    // step job (recorded by `StepJobRunner`, under a kind like `cloudflare_expose` rather
    // than one of `JobRunner`'s four) should already be covered. Verified, not assumed:
    // Phase 2B carries a named instruction not to take that on faith.
    await db.insert(jobs).values({
      id: "step-job-1",
      appId: "app-1",
      kind: "cloudflare_expose",
      status: "running",
      startedAt: NOW - 30,
    });

    const repaired = await sweepStrandedJobs(db, NOW);

    expect(repaired).toBe(1);
    const [row] = await db.select().from(jobs);
    if (!row) throw new Error("expected a job row");
    expect(row.kind).toBe("cloudflare_expose");
    expect(row.status).toBe("failed");
    expect(row.output).toContain("interrupted");
  });

  it("reports zero on a clean database rather than throwing", async () => {
    expect(await sweepStrandedJobs(db, NOW)).toBe(0);
  });

  it("leaves no job that a jobs listing would report as running", async () => {
    await db.insert(jobs).values([
      { id: "job-a", appId: "app-1", kind: "up", status: "running", startedAt: NOW - 10 },
      { id: "job-b", appId: "app-1", kind: "pull", status: "queued" },
    ]);

    await sweepStrandedJobs(db, NOW);

    const rows = await db.select().from(jobs);
    expect(rows.filter((r) => r.status === "running" || r.status === "queued")).toEqual([]);
  });
});
