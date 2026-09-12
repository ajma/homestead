import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { Db } from "../db/client.js";
import { apps, jobs } from "../db/schema.js";
import type { Host, JobChunk, JobHandle } from "../host/types.js";
import type { AppLock } from "./app-lock.js";
import type { ComposeConfigCache } from "./compose-config.js";

export const JOB_KINDS = ["up", "down", "restart", "pull"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** The compose arguments each action maps to. Fixed here so no caller can pass its own. */
const ARGS: Record<JobKind, string[]> = {
  up: ["up", "-d"],
  down: ["down"],
  restart: ["restart"],
  pull: ["pull"],
};

/** A `pull` on a large stack runs for minutes; 30 is generous without being unbounded. */
const JOB_TIMEOUT_MS = 30 * 60_000;
/** Persisted output cap. The tail is kept — the end is where the error is. */
const OUTPUT_CAP = 256 * 1024;
/** Seconds after a job during which probe failures render as `starting` (spec §4). */
const GRACE_SECONDS = 120;

/**
 * Thrown by `start` when `AppLock` refuses the slot. `holder` is always the lock's own
 * description of whoever is holding it (e.g. `"pull job"`) — safe to show a user
 * regardless of who took the lock. `runningJobId` is populated only when the holder is
 * THIS runner's own in-flight job, because only then does a `jobs` row exist for the
 * route to resolve; a step job (or any future runner sharing the same `AppLock`) has no
 * job id this registry can vouch for, so it is omitted rather than guessed. A route
 * handing a client an id that resolves nothing is worse than a route with no id at all —
 * see `routes/jobs.ts`.
 */
export class JobBusyError extends Error {
  constructor(
    readonly holder: string,
    readonly runningJobId?: string,
  ) {
    super(`Another job is already running for this app: ${holder}`);
    this.name = "JobBusyError";
  }
}

export type AppRow = typeof apps.$inferSelect;

export type RunningJob = {
  id: string;
  appId: string;
  kind: JobKind;
  output: AsyncIterable<JobChunk>;
  done: Promise<void>;
};

export class JobRunner {
  /**
   * The registry the SSE route reads to attach to a job already in flight, and `cancel`
   * and `shutdown` read to reach a running job's handle. This is no longer the mutex —
   * see `appLock` below — because the step runner is per-app too, and two private maps
   * keyed by the same app id do not exclude each other at all.
   */
  private readonly running = new Map<string, RunningJob & { handle: JobHandle }>();

  /**
   * The per-app mutex, shared with the step runner. Required, not defaulted: an optional
   * `appLock` that falls back to a private instance compiles cleanly for a call site that
   * forgets to share it, which reinstates — silently — the exact failure Task 2 exists to
   * eliminate (two runners with two private locks do not exclude each other at all). A
   * mutation that dropped `appLock` from one construction while leaving the other's
   * intact was measured to leave the entire suite green under the optional form; making
   * this required turns that same mutation into a compile error instead. Every call site
   * that matters (`index.ts`, `test-helpers.ts`, and any test that starts a `JobRunner`
   * and a `StepJobRunner` against the same app) already has an `AppLock` to pass.
   */
  private readonly appLock: AppLock;

  constructor(
    private readonly deps: {
      db: Db;
      host: Host;
      composeConfig: ComposeConfigCache;
      appLock: AppLock;
    },
  ) {
    this.appLock = deps.appLock;
  }

  live(jobId: string): RunningJob | undefined {
    for (const job of this.running.values()) if (job.id === jobId) return job;
    return undefined;
  }

  cancel(jobId: string): boolean {
    for (const job of this.running.values()) {
      if (job.id === jobId) {
        job.handle.cancel();
        return true;
      }
    }
    return false;
  }

  /**
   * Cancels every in-flight job and waits for each to write its terminal row.
   *
   * Cancelling rather than waiting is the only option that exists: `JOB_TIMEOUT_MS` is
   * thirty minutes and Docker SIGKILLs ten seconds after SIGTERM. A cancelled job lands as
   * `failed` through the normal `finish` path, which is the same place the startup sweep
   * would have put it — the difference is that this one happens while we can still write
   * it, so the next boot has nothing to repair.
   *
   * `timeoutMs` bounds the wait. A child that ignores SIGTERM must not be able to hold the
   * process open past the orchestrator's grace period; the row it leaves behind is the
   * sweep's problem on the next boot, which is exactly what the sweep is for.
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    const inFlight = [...this.running.values()];
    if (inFlight.length === 0) return;

    for (const job of inFlight) job.handle.cancel();

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });

    try {
      await Promise.race([Promise.allSettled(inFlight.map((job) => job.done)), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async start(app: AppRow, kind: JobKind, userId: string): Promise<RunningJob> {
    // The mutex decision is `appLock.tryAcquire` alone — not the registry below, which is
    // bookkeeping for `live`/`cancel`/`shutdown` and no longer guards anything. Everything
    // from here to `this.running.set` must stay synchronous.
    //
    // Measured with the insert placed first: two `start` calls in the same tick both
    // returned a job and both spawned `docker compose up` on the same stack, because
    // each passed the check above while the other was still awaiting its insert. A
    // double-click on Deploy is enough. `ulid()` and `runCompose` are both synchronous —
    // `runCompose` returns a handle, not a promise — so the slot can be taken before any
    // await exists to yield at.
    if (!this.appLock.tryAcquire(app.id, `${kind} job`)) {
      // `inFlight` is only ever set by THIS runner's own `start`, so its presence means
      // the lock's current holder is this runner's own job — the id is real and the
      // route can resolve it. Its absence means something else holds the lock (a step
      // job sharing this `AppLock`); `heldBy` still names it, but there is no job id to
      // give, so `runningJobId` is left undefined rather than falling back to `app.id`.
      const inFlight = this.running.get(app.id);
      throw new JobBusyError(this.appLock.heldBy(app.id) ?? "another job", inFlight?.id);
    }

    const id = ulid();
    const handle = this.deps.host.runCompose(
      { directory: app.directory, composeFile: app.composeFile },
      ARGS[kind],
      { timeoutMs: JOB_TIMEOUT_MS },
    );

    // `done` must be truthful the instant the slot is taken, not just once the row insert
    // below resolves. `shutdown()` reads `job.done` off the `running` map to know whether a
    // job it is about to cancel has finished writing its terminal row — a placeholder that
    // is already resolved (as a bare `Promise.resolve()` would be) makes that a lie for the
    // length of this `await`, and `shutdown()` returns as soon as that lie settles rather
    // than waiting for the real completion. This deferred is settled exactly once: either
    // by `finish()` below once the row is terminal, or synchronously in the `catch` below
    // once the failed insert has freed the slot — never both, and never left pending after
    // the slot is gone.
    let settleDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settleDone = resolve;
    });

    const job: RunningJob & { handle: JobHandle } = {
      id,
      appId: app.id,
      kind,
      handle,
      output: handle.output,
      done,
    };
    this.running.set(app.id, job);

    try {
      await this.deps.db.insert(jobs).values({
        id,
        appId: app.id,
        kind,
        status: "running",
        startedAt: Math.floor(Date.now() / 1000),
        userId,
      });
    } catch (error) {
      // The process is already running but has no row to record it against. Kill it and
      // free the slot, rather than leaving an untracked `up` on the user's stack.
      handle.cancel();
      this.running.delete(app.id);
      this.appLock.release(app.id);
      settleDone();
      throw error;
    }

    job.done = this.finish(app, job, handle).then(settleDone);
    return job;
  }

  private async finish(app: AppRow, job: RunningJob, handle: JobHandle): Promise<void> {
    try {
      const result = await handle.result;
      const combined = [result.stdout, result.stderr].filter((part) => part !== "").join("\n");
      const output =
        combined.length > OUTPUT_CAP
          ? `… output truncated, showing the last ${OUTPUT_CAP} characters …\n${combined.slice(combined.length - OUTPUT_CAP)}`
          : combined;

      await this.deps.db
        .update(jobs)
        .set({
          status: result.exitCode === 0 ? "succeeded" : "failed",
          exitCode: result.exitCode,
          finishedAt: Math.floor(Date.now() / 1000),
          output,
        })
        .where(eq(jobs.id, job.id));

      // The config and the container set are both stale now: `up` can pull a new image and
      // `pull` certainly does.
      this.deps.composeConfig.invalidate({
        directory: app.directory,
        composeFile: app.composeFile,
      });

      // Set on completion, not on start. During a multi-minute `pull` the old containers
      // are still up and their status is real; suppressing it would hide a live failure.
      await this.deps.db
        .update(apps)
        .set({ graceUntil: Math.floor(Date.now() / 1000) + GRACE_SECONDS })
        .where(eq(apps.id, app.id));
    } catch (error) {
      // A job whose bookkeeping failed is a job with a stale row — a much smaller problem
      // than letting the rejection go unhandled and terminate the process. Log and swallow.
      console.error(`[job-runner] Failed to update job ${job.id}:`, error);
    } finally {
      // Always, or a failed job wedges the app until restart.
      this.running.delete(app.id);
      this.appLock.release(app.id);
    }
  }
}
