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

  it("holds the mutex against two starts in the SAME TICK", async () => {
    // The form the serialised test cannot catch. Measured with the row insert placed
    // before the reservation: both calls returned a job and both spawned
    // `docker compose up` on one stack, because each passed the busy check while the
    // other was still awaiting its insert. A double-click on Deploy is enough.
    const { host, row, userId, runner } = await seed();
    host.composeResults.set("up -d", { exitCode: 0, stdout: "ok\n", stderr: "" });
    host.gateCompose();

    const settled = await Promise.allSettled([
      runner.start(row, "up", userId),
      runner.start(row, "up", userId),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(1);
    const rejected = settled.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(JobBusyError);

    host.releaseCompose();
  });

  it("frees the slot when the job row cannot be written", async () => {
    // The process is spawned before the insert, so a failed insert must not leave an
    // untracked `up` running against an app that now looks idle.
    const { db, host, row, userId, runner } = await seed();
    host.composeResults.set("up -d", { exitCode: 0, stdout: "", stderr: "" });
    // A second row with the same primary key is the simplest way to make the insert fail.
    const clash = ulid();
    const original = db.insert.bind(db);
    let first = true;
    // biome-ignore lint/suspicious/noExplicitAny: narrow test double over one method
    (db as any).insert = (table: unknown) => {
      if (first) {
        first = false;
        throw new Error("disk I/O error");
      }
      return original(table as never);
    };
    await expect(runner.start(row, "up", userId)).rejects.toThrow("disk I/O error");
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (db as any).insert = original;
    void clash;

    // The app is usable again immediately.
    host.composeResults.set("down", { exitCode: 0, stdout: "", stderr: "" });
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

  it("does not emit unhandled rejection when job bookkeeping fails and done is never awaited", async () => {
    // The terminal case for a single-process appliance: click Deploy, do not open the log
    // pane, and let the status update hit SQLITE_BUSY or a full disk. Without a catch,
    // the rejection is unhandled and Node's default is to terminate the process.
    const { db, host, row, userId, runner } = await seed();
    host.composeResults.set("up -d", { exitCode: 0, stdout: "ok\n", stderr: "" });

    let rejection: unknown = null;
    const onRejection = (reason: unknown) => {
      rejection = reason;
    };
    process.on("unhandledRejection", onRejection);

    try {
      const original = db.update.bind(db);
      let callCount = 0;
      // biome-ignore lint/suspicious/noExplicitAny: narrow test double over one method
      (db as any).update = (table: unknown) => {
        callCount++;
        // Fail the second update (the graceUntil write on the apps table).
        if (callCount === 2) {
          throw new Error("SQLITE_BUSY");
        }
        return original(table as never);
      };

      await runner.start(row, "up", userId);
      // Do not await job.done — simulates user closing the log pane before the job finishes.
      // Wait long enough for the job to complete internally.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // biome-ignore lint/suspicious/noExplicitAny: restore
      (db as any).update = original;

      expect(rejection).toBeNull();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  describe("shutdown", () => {
    it("cancels an in-flight job and lets it write its terminal row", async () => {
      const { db, host, row, userId, runner } = await seed();
      host.holdCompose = true; // the compose child does not exit on its own

      const job = await runner.start(row, "up", userId);
      const before = await db.select().from(jobs).where(eq(jobs.id, job.id));
      expect(before[0]?.status).toBe("running");

      await runner.shutdown(2000);

      const after = await db.select().from(jobs).where(eq(jobs.id, job.id));
      expect(after[0]?.status).toBe("failed");
      expect(after[0]?.finishedAt).not.toBeNull();
    });

    it("waits out a start() still inside its insert-await window, not the placeholder done", async () => {
      // Reviewer's reproduction: `start()` is called and NOT awaited, so `shutdown()` runs
      // while `this.running` holds a slot whose `done` is still the synchronous placeholder
      // `Promise.resolve()` — set before the row insert, overwritten only after it resolves.
      // A `shutdown()` that trusts that placeholder returns before the real row write lands.
      const { db, host, row, userId, runner } = await seed();
      host.composeResults.set("up -d", { exitCode: 0, stdout: "ok\n", stderr: "" });

      const startPromise = runner.start(row, "up", userId);
      await runner.shutdown(2000);

      const job = await startPromise;
      const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id));
      expect(saved?.status).not.toBe("running");
      expect(saved?.finishedAt).not.toBeNull();
    });

    it("frees the per-app slot, so nothing is left wedged", async () => {
      const { host, row, userId, runner } = await seed();
      host.holdCompose = true;

      await runner.start(row, "up", userId);
      await runner.shutdown(2000);

      // A second start would throw JobBusyError if the slot were still held.
      host.holdCompose = false;
      host.composeResults.set("up -d", { exitCode: 0, stdout: "", stderr: "" });
      await expect(runner.start(row, "up", userId)).resolves.toBeDefined();
    });

    it("returns rather than hanging when a child ignores cancellation", async () => {
      const { host, row, userId, runner } = await seed();
      host.holdCompose = true;
      host.ignoreCancel = true;

      await runner.start(row, "up", userId);

      const started = Date.now();
      await runner.shutdown(200);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("resolves immediately when nothing is running", async () => {
      const { runner } = await seed();
      await expect(runner.shutdown(2000)).resolves.toBeUndefined();
    });

    it("settles done when start()'s insert rejects, rather than making shutdown() wait out its full timeout", async () => {
      // Coverage gap flagged in the 1H task-3 brief: `start()`'s insert-failure `catch`
      // calls `settleDone()` so a job that never got a row does not leave `shutdown()`
      // waiting on a `done` placeholder that nothing will ever resolve. No committed test
      // exercised that call — remove it from the catch and every other test in this file
      // still passes, but this one hangs for the full 2000ms below instead of settling
      // almost immediately.
      const { db, host, row, userId, runner } = await seed();
      host.composeResults.set("up -d", { exitCode: 0, stdout: "ok\n", stderr: "" });

      const original = db.insert.bind(db);
      // biome-ignore lint/suspicious/noExplicitAny: narrow test double over one method
      (db as any).insert = () => ({
        values: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("disk I/O error")), 20);
          }),
      });

      // Not awaited: `shutdown()` must race the still-pending insert, not a call that has
      // already settled.
      const startPromise = runner.start(row, "up", userId);
      startPromise.catch(() => {}); // observed now so the eventual rejection is never unhandled

      const started = Date.now();
      await runner.shutdown(2000);
      const elapsed = Date.now() - started;

      // biome-ignore lint/suspicious/noExplicitAny: restore
      (db as any).insert = original;
      await expect(startPromise).rejects.toThrow("disk I/O error");

      // The failed insert settles `done` within ~20ms. Without `settleDone()` in the catch,
      // `shutdown()` would still be waiting out its 2000ms budget for a job that never ran.
      expect(elapsed).toBeLessThan(500);
    });
  });
});
