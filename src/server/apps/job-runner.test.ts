import { ComposeConfigCache } from "@server/apps/compose-config";
import { JobBusyError, JobRunner } from "@server/apps/job-runner";
import { createDb, runMigrations } from "@server/db/client";
import { apps, hosts, jobs, users } from "@server/db/schema";
import { FakeHost } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

async function seed() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  await db.insert(hosts).values({
    id: "local",
    name: "local",
    composeRoot: "/v",
    dockerSocket: "/s",
  });
  const userId = ulid();
  await db.insert(users).values({
    id: userId,
    email: "a@example.com",
    name: "A",
    role: "admin",
    emailVerified: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const app = {
    id: ulid(),
    hostId: "local",
    slug: "jellyfin",
    displayName: "Jellyfin",
    directory: "jellyfin",
    composeFile: "compose.yaml",
    projectName: "jellyfin",
  };
  await db.insert(apps).values(app);
  const [row] = await db.select().from(apps).where(eq(apps.id, app.id));
  if (!row) throw new Error("seed failed");

  const host = new FakeHost();
  host.files.set("jellyfin/compose.yaml", "services: {}\n");
  return {
    db,
    host,
    row,
    userId,
    runner: new JobRunner({ db, host, composeConfig: new ComposeConfigCache(host) }),
  };
}

describe("JobRunner", () => {
  it("records a job row and its output", async () => {
    const { db, host, row, userId, runner } = await seed();
    host.composeResults.set("up -d", { exitCode: 0, stdout: "Container started\n", stderr: "" });

    const job = await runner.start(row, "up", userId);
    await job.done;

    const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(saved?.status).toBe("succeeded");
    expect(saved?.exitCode).toBe(0);
    expect(saved?.kind).toBe("up");
    expect(saved?.output).toContain("Container started");
  });

  it("marks a non-zero exit as failed", async () => {
    const { db, host, row, userId, runner } = await seed();
    host.composeResults.set("up -d", { exitCode: 1, stdout: "", stderr: "no such image\n" });
    const job = await runner.start(row, "up", userId);
    await job.done;
    const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(saved?.status).toBe("failed");
    expect(saved?.exitCode).toBe(1);
    expect(saved?.output).toContain("no such image");
  });

  it("refuses a second job while one is running, naming the one in flight", async () => {
    // The mutex. A `pull` and a `down` racing on one stack is how a user ends up with
    // half-replaced containers and no way to tell what happened.
    const { host, row, userId, runner } = await seed();
    host.composeResults.set("pull", { exitCode: 0, stdout: "pulled\n", stderr: "" });
    host.gateCompose();

    const first = await runner.start(row, "pull", userId);
    await expect(runner.start(row, "down", userId)).rejects.toBeInstanceOf(JobBusyError);

    host.releaseCompose();
    await first.done;
    // Once it finishes the lock is gone.
    host.composeResults.set("down", { exitCode: 0, stdout: "stopped\n", stderr: "" });
    await (await runner.start(row, "down", userId)).done;
  });

  it("releases the mutex even when the job throws", async () => {
    const { host, row, userId, runner } = await seed();
    host.composeResults.set("up -d", { exitCode: 1, stdout: "", stderr: "boom" });
    await (await runner.start(row, "up", userId)).done;
    // A failed job must not wedge the app forever.
    host.composeResults.set("down", { exitCode: 0, stdout: "", stderr: "" });
    await (await runner.start(row, "down", userId)).done;
  });

  it("sets the grace window when the job finishes, not when it starts", async () => {
    const { db, host, row, userId, runner } = await seed();
    host.composeResults.set("restart", { exitCode: 0, stdout: "ok\n", stderr: "" });
    host.gateCompose();
    const job = await runner.start(row, "restart", userId);

    const [during] = await db.select().from(apps).where(eq(apps.id, row.id));
    // Still running: the old containers are up and their status is real. Suppressing it
    // for the length of a multi-minute pull would hide a genuine failure.
    expect(during?.graceUntil).toBeNull();

    host.releaseCompose();
    await job.done;
    const [after] = await db.select().from(apps).where(eq(apps.id, row.id));
    expect(after?.graceUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("streams output as chunks, not as one blob", async () => {
    const { host, row, userId, runner } = await seed();
    host.composeChunkCount = 4;
    host.composeResults.set("up -d", { exitCode: 0, stdout: "abcdefgh", stderr: "" });
    const job = await runner.start(row, "up", userId);
    const chunks: string[] = [];
    for await (const chunk of job.output) chunks.push(chunk.text);
    await job.done;
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe("abcdefgh");
  });

  it("caps the persisted output, keeping the tail", async () => {
    const { db, host, row, userId, runner } = await seed();
    host.composeResults.set("pull", {
      exitCode: 0,
      stdout: `${"x".repeat(300_000)}THE-END`,
      stderr: "",
    });
    const job = await runner.start(row, "pull", userId);
    await job.done;
    const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect((saved?.output ?? "").length).toBeLessThan(300_000);
    // The end is where the error is.
    expect(saved?.output).toContain("THE-END");
    expect(saved?.output).toContain("truncated");
  });

  it("invalidates the compose config cache after a job", async () => {
    // `up` can pull a new image and `pull` certainly does, so the resolved config and the
    // container set the status rollup compares against are both stale afterwards.
    // The cache must be the SAME instance the runner holds, and the db the same one the
    // app row lives in — a second `seed()` here would violate the app's foreign key and
    // fail for a reason that has nothing to do with caching.
    const { db, host, row, userId } = await seed();
    host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "jellyfin", services: {} }),
      stderr: "",
    });
    host.composeResults.set("up -d", { exitCode: 0, stdout: "", stderr: "" });

    const cache = new ComposeConfigCache(host);
    const runner = new JobRunner({ db, host, composeConfig: cache });
    const target = { directory: "jellyfin", composeFile: "compose.yaml" };

    await cache.resolve(target);
    const afterFirstResolve = host.composeCalls.length;
    await (await runner.start(row, "up", userId)).done;
    await cache.resolve(target);

    // One call for `up`, one for the re-resolve. Without the invalidation the second
    // resolve is a cache hit and this is `afterFirstResolve + 1`.
    expect(host.composeCalls.length).toBe(afterFirstResolve + 2);
  });
});
