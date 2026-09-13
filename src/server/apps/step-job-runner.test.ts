import { AppBusyError, AppLock } from "@server/apps/app-lock";
import { ComposeConfigCache } from "@server/apps/compose-config";
import { JobBusyError, JobRunner } from "@server/apps/job-runner";
import { StepJobRunner } from "@server/apps/step-job-runner";
import type { Step } from "@server/apps/step-sequence";
import type { Db } from "@server/db/client";
import { createDb, runMigrations } from "@server/db/client";
import { apps, hosts, jobs, users } from "@server/db/schema";
import { FakeHost } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";

type Ctx = { log: string[] };

function step(
  name: string,
  opts: { fail?: boolean; undo?: boolean; undoFails?: boolean } = {},
): Step<Ctx> {
  const s: Step<Ctx> = {
    name,
    run: async (ctx) => {
      ctx.log.push(`run:${name}`);
      if (opts.fail) throw new Error(`${name} failed`);
    },
  };
  if (opts.undo || opts.undoFails) {
    s.undo = async (ctx) => {
      ctx.log.push(`undo:${name}`);
      if (opts.undoFails) throw new Error(`${name} undo failed`);
    };
  }
  return s;
}

/** A step whose `run` blocks until `release()` is called — for asserting lock state
 * mid-sequence, the same reason `job-runner.test.ts` uses `host.gateCompose()`. */
function gatedStep(name: string): { step: Step<Ctx>; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    step: {
      name,
      run: async (ctx) => {
        ctx.log.push(`run:${name}`);
        await gate;
      },
    },
    release,
  };
}

async function seed(): Promise<{ db: Db; row: typeof apps.$inferSelect; userId: string }> {
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
  return { db, row, userId };
}

describe("StepJobRunner", () => {
  let db: Db;
  let row: typeof apps.$inferSelect;
  let userId: string;
  let appLock: AppLock;
  let runner: StepJobRunner;

  beforeEach(async () => {
    ({ db, row, userId } = await seed());
    appLock = new AppLock();
    runner = new StepJobRunner({ db, appLock });
  });

  it("writes a succeeded job row naming every step, on success", async () => {
    const { id } = await runner.start(
      row.id,
      "cloudflare_expose",
      [step("a"), step("b"), step("c")],
      { log: [] },
      userId,
    );

    const [saved] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(saved?.status).toBe("succeeded");
    expect(saved?.kind).toBe("cloudflare_expose");
    expect(saved?.output).toContain("a");
    expect(saved?.output).toContain("b");
    expect(saved?.output).toContain("c");
  });

  it("writes a failed job row naming the failing step and what was rolled back", async () => {
    const { id } = await runner.start(
      row.id,
      "cloudflare_expose",
      [step("create-tunnel", { undo: true }), step("create-dns-record", { fail: true })],
      { log: [] },
      userId,
    );

    const [saved] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(saved?.status).toBe("failed");
    expect(saved?.output).toContain("create-dns-record");
    expect(saved?.output).toMatch(/create-dns-record.*failed/i);
    expect(saved?.output).toContain("create-tunnel");
    expect(saved?.output).toMatch(/rolled back.*create-tunnel/i);
  });

  it("puts undoFailures first in the output, not appended at the end", async () => {
    const { id } = await runner.start(
      row.id,
      "cloudflare_expose",
      [step("create-tunnel", { undoFails: true }), step("create-dns-record", { fail: true })],
      { log: [] },
      userId,
    );

    const [saved] = await db.select().from(jobs).where(eq(jobs.id, id));
    const output = saved?.output ?? "";
    expect(output).toMatch(/manual cleanup required/i);
    expect(output).toContain("create-tunnel");
    // Prominent means near the top, not merely present somewhere in a long transcript.
    const cleanupIndex = output.search(/manual cleanup required/i);
    const failedSummaryIndex = output.indexOf('FAILED at step "create-dns-record"');
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(cleanupIndex).toBeLessThan(failedSummaryIndex);
  });

  it("holds the app lock for the sequence's duration and releases it after success", async () => {
    const gated = gatedStep("wait");
    const promise = runner.start(row.id, "cloudflare_expose", [gated.step], { log: [] }, userId);

    expect(appLock.heldBy(row.id)).toBe("cloudflare_expose job");
    gated.release();
    await promise;
    expect(appLock.heldBy(row.id)).toBeUndefined();
  });

  it("holds the app lock for the sequence's duration and releases it after failure", async () => {
    const gated = gatedStep("wait");
    const failing: Step<Ctx> = {
      name: "boom",
      run: async () => {
        throw new Error("boom");
      },
    };
    // Use a step that fails immediately but still exercise the release-on-failure path
    // by asserting the lock is held while the (synchronous-looking) sequence resolves and
    // gone once it has.
    const promise = runner.start(
      row.id,
      "cloudflare_expose",
      [gated.step, failing],
      { log: [] },
      userId,
    );

    expect(appLock.heldBy(row.id)).toBe("cloudflare_expose job");
    gated.release();
    const result = await promise;
    expect(appLock.heldBy(row.id)).toBeUndefined();

    const [saved] = await db.select().from(jobs).where(eq(jobs.id, result.id));
    expect(saved?.status).toBe("failed");
  });

  it("cannot start while a docker compose job holds the lock", async () => {
    const host = new FakeHost();
    host.files.set("jellyfin/compose.yaml", "services: {}\n");
    host.gateCompose();
    const composeRunner = new JobRunner({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      appLock,
    });

    const composeJob = await composeRunner.start(row, "up", userId);

    await expect(
      runner.start(row.id, "cloudflare_expose", [step("a")], { log: [] }, userId),
    ).rejects.toBeInstanceOf(AppBusyError);

    host.releaseCompose();
    await composeJob.done;
  });

  it("blocks a docker compose job while it holds the lock — the reverse direction", async () => {
    // The one-directional version of this test would pass against a runner that takes
    // the lock but never checks it. Both directions have to be proven.
    const host = new FakeHost();
    host.files.set("jellyfin/compose.yaml", "services: {}\n");
    const composeRunner = new JobRunner({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      appLock,
    });

    const gated = gatedStep("wait");
    const stepPromise = runner.start(
      row.id,
      "cloudflare_expose",
      [gated.step],
      { log: [] },
      userId,
    );

    expect(appLock.heldBy(row.id)).toBe("cloudflare_expose job");
    let busyError: unknown;
    try {
      await composeRunner.start(row, "up", userId);
    } catch (error) {
      busyError = error;
    }
    expect(busyError).toBeInstanceOf(JobBusyError);
    // Concern carried from Task 2/3: the compose runner must not hand the client a job id
    // that does not exist. The step job holding the lock is not this JobRunner's own, so
    // there is nothing to resolve — `runningJobId` must be absent, not a guess.
    expect((busyError as JobBusyError).runningJobId).toBeUndefined();
    expect((busyError as JobBusyError).holder).toBe("cloudflare_expose job");

    gated.release();
    await stepPromise;
  });

  it("frees the app lock when the job row cannot be written", async () => {
    // `JobRunner` has the equivalent test (`job-runner.test.ts`: "frees the slot when the
    // job row cannot be written"); `StepJobRunner` was modelled on it but did not inherit
    // it (Phase 2B whole-branch review, Minor 8). Deleting the `release` in `start`'s
    // insert-failure `catch` left the whole suite green — nothing wedged the app behind a
    // job with no row until this test existed to notice.
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
    await expect(
      runner.start(row.id, "cloudflare_expose", [step("a")], { log: [] }, userId),
    ).rejects.toThrow("disk I/O error");
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (db as any).insert = original;

    expect(appLock.heldBy(row.id)).toBeUndefined();
    // The app is usable again immediately.
    const { id } = await runner.start(
      row.id,
      "cloudflare_expose",
      [step("a")],
      { log: [] },
      userId,
    );
    const [saved] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(saved?.status).toBe("succeeded");
  });

  it("blocks a second start issued in the SAME TICK, not just a serialized one", async () => {
    // The synchronous-window counterpart to the "same tick" test `JobRunner` has
    // (`job-runner.test.ts`): probed directly and found correct but untested (Phase 2B
    // whole-branch review, Minor 8) — this pins it the same way.
    const gated = gatedStep("wait");
    const settled = Promise.allSettled([
      runner.start(row.id, "cloudflare_expose", [gated.step], { log: [] }, userId),
      runner.start(row.id, "cloudflare_expose", [step("a")], { log: [] }, userId),
    ]);
    gated.release();
    const results = await settled;

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(AppBusyError);
  });
});
