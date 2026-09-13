import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { AppBusyError, type AppLock } from "./app-lock.js";
import { runSteps, type Step, type StepEvent, type StepOutcome } from "./step-sequence.js";

/** Persisted output cap, the same bound `JobRunner` applies to compose output. */
const OUTPUT_CAP = 256 * 1024;

/**
 * The `AppLock` key for a sequence that has no app yet to key its mutex on — a sequence
 * that CREATES an app (2C's tunnel provision is the first: the `apps` row does not exist
 * until one of its own steps inserts it) starts before any row, and therefore any real
 * `appId`, exists. A sentinel outside the ulid alphabet, so it can never collide with a
 * real id. Only one such no-app sequence may run at a time system-wide, which is the
 * correct granularity until a second kind of app-creating step sequence exists — there is
 * nothing narrower to key it to yet.
 */
const NO_APP_LOCK_KEY = " no-app-yet";

/**
 * Records a `runSteps` sequence as a `jobs` row, under the same per-app `AppLock` a
 * compose job takes — so an expose cannot race a deploy on the same app in either
 * direction, and a step sequence appears in the UI the way a deploy does: a row, a
 * terminal status, output a user can read.
 *
 * `start` returns as soon as the job row is inserted — it does not wait for the sequence
 * (2F Task 1). Blocking here through 2C/2D was measured to be worse than slow: it 524s
 * once Homestead is itself reached through the tunnel it is provisioning (Task 2 is what
 * makes that configuration possible), because the load balancer in front of a
 * self-exposed Homestead times out an HTTP response long before a multi-minute sequence
 * finishes. The lock and the job row are unaffected by this — both are still held/updated
 * for the sequence's real duration, in the background; only the caller's wait moved.
 * There is no `live`/`cancel` here: a step sequence's individual steps are network calls
 * to Cloudflare's API, not a cancellable child process. Streaming this job's progress to a
 * connected client reuses `GET /api/jobs/:jobId/stream`'s existing no-`live`-handle poll
 * (`routes/jobs.ts`'s `waitForTerminalJob`), not new surface this class has to grow.
 *
 * The output is the deliverable, not a side effect: a failed sequence can leave real
 * resources in someone's Cloudflare account, and `undoFailures` — the steps that could
 * not be cleaned up — is the one thing a reader of this job needs before anything else.
 * `buildOutput` below puts it first.
 */
export class StepJobRunner {
  /**
   * Every sequence currently between its lock acquisition and its terminal-row write —
   * now the ONLY place that duration is visible at all, since `start` (below) no longer
   * stays pending for it. `shutdown()` reads this to know what to wait for; there is no
   * per-job registry like `JobRunner.running` because nothing here is cancellable or
   * streamable yet (see the class doc).
   */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly deps: { db: Db; appLock: AppLock }) {}

  /**
   * Waits for any in-flight sequence to reach its terminal-row write, bounded by
   * `timeoutMs`.
   *
   * This WAITS; it never cancels. `JobRunner.shutdown` can cancel because a compose
   * child process understands SIGTERM and a partially-applied `docker compose up` is safe
   * to leave half-done — the next `up` reconciles it. A step sequence has no equivalent:
   * its steps are calls to Cloudflare's API that create real remote resources, and
   * `runSteps`'s rollback is triggered by a *step failing*, not by the process dying —
   * there is no signal to send that would make an in-flight step unwind itself. Deciding
   * what SHOULD happen to a half-finished sequence on shutdown — tear it down via
   * rollback, or leave it for the next boot to resume — remains an open design question,
   * not a decision this method makes; it only buys the sequence already running time to
   * finish writing its own terminal row before `db.close()` runs out from under it, which
   * is what was actually measured missing (the whole-branch review's ruling on the
   * shutdown gap). That is more load-bearing after Task 1 than before it: `start` no
   * longer keeps its caller waiting for the sequence, so a real in-flight sequence
   * routinely outlives the request that started it, not just the rare case of a process
   * dying mid-`await`.
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    const inFlight = [...this.inFlight];
    if (inFlight.length === 0) return;

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });

    try {
      await Promise.race([Promise.allSettled(inFlight), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * `appId` is `null` for a sequence that has no app to associate the job with YET — see
   * `NO_APP_LOCK_KEY` above. `jobs.appId` is nullable in the schema for exactly this case
   * (there is no FK to satisfy when nothing has been created), and `runningJobs`/`sweep`
   * already tolerate a null `appId` on a step-kind job. When `appId` is a real id, this
   * behaves exactly as it always has: locked, and recorded, by that id.
   */
  async start<C>(
    appId: string | null,
    kind: string,
    steps: Array<Step<C>>,
    ctx: C,
    userId: string,
  ): Promise<{ id: string }> {
    const lockKey = appId ?? NO_APP_LOCK_KEY;
    // Same synchronous-window requirement `JobRunner.start` documents: acquire, decide,
    // and (if granted) record the holder before any `await`, so two calls issued in the
    // same tick cannot both pass the check. `AppLock.tryAcquire` is synchronous for
    // exactly this reason.
    if (!this.deps.appLock.tryAcquire(lockKey, `${kind} job`)) {
      throw new AppBusyError(lockKey, this.deps.appLock.heldBy(lockKey) ?? "another job");
    }

    const id = ulid();
    try {
      await this.deps.db.insert(jobs).values({
        id,
        appId,
        kind,
        status: "running",
        startedAt: Math.floor(Date.now() / 1000),
        userId,
      });
    } catch (error) {
      // No row exists to record the hold against — free the slot rather than wedging the
      // app behind a job nothing can ever see, cancel, or sweep.
      this.deps.appLock.release(lockKey);
      throw error;
    }

    // Registered before the first `await` inside `run` executes, and de-registered once
    // it settles — a `shutdown()` call landing at any point in between sees this sequence
    // and waits for it. NOT awaited here: that is the entire point of Task 1. `run` is an
    // async function, so calling it already starts executing synchronously up to its own
    // first `await` (inside `runSteps`) before this line returns — the lock is real and
    // the first step is already underway by the time the caller gets `id` back.
    const sequence = this.run(id, lockKey, steps, ctx);
    this.inFlight.add(sequence);
    void sequence.finally(() => this.inFlight.delete(sequence));

    return { id };
  }

  /**
   * Runs the sequence to its terminal row write and releases the lock — entirely in the
   * background relative to `start`'s caller. Never rejects: `runSteps` already turns a
   * step failure into a `StepOutcome`, so the only way to get here is the terminal
   * `db.update` itself throwing, and with nothing left awaiting this promise directly
   * (only `Promise.allSettled` in `shutdown`), an uncaught rejection would not surface as
   * a failed request — it would surface as an `unhandledRejection` and, on current Node
   * defaults, take the whole process down. Catching and logging instead leaves a stale
   * `running` row for the next boot's sweep to find, which is a much smaller problem.
   * Matches `JobRunner.finish`'s own `catch`/`finally` for exactly this reason.
   */
  private async run<C>(id: string, lockKey: string, steps: Array<Step<C>>, ctx: C): Promise<void> {
    try {
      const transcript: string[] = [];
      const outcome = await runSteps(steps, ctx, {
        onProgress: (event) => transcript.push(describeEvent(event)),
      });

      await this.deps.db
        .update(jobs)
        .set({
          status: outcome.ok ? "succeeded" : "failed",
          finishedAt: Math.floor(Date.now() / 1000),
          output: cap(buildOutput(outcome, transcript)),
        })
        .where(eq(jobs.id, id));
    } catch (error) {
      console.error(`[step-job-runner] Failed to update job ${id}:`, error);
    } finally {
      // Always — released whether the sequence succeeded, failed, or the write above
      // threw, or a failed step job wedges the app until restart. Matches
      // `JobRunner.finish`'s `finally`.
      this.deps.appLock.release(lockKey);
    }
  }
}

function cap(output: string): string {
  return output.length > OUTPUT_CAP
    ? `… output truncated, showing the last ${OUTPUT_CAP} characters …\n${output.slice(output.length - OUTPUT_CAP)}`
    : output;
}

function describeEvent(event: StepEvent): string {
  if (event.stage === "start") {
    return event.phase === "run" ? `> running ${event.step}` : `> rolling back ${event.step}`;
  }
  if (event.ok) return "  ok";
  return event.phase === "run"
    ? `  FAILED: ${describeError(event.error)}`
    : `  FAILED (not rolled back): ${describeError(event.error)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `undoFailures` is placed first, not appended: the question a user reading a failed
 * job actually has is "do I now have orphaned resources, and which?", and that answer
 * must not require scrolling past a transcript to find.
 */
function buildOutput(outcome: StepOutcome, transcript: string[]): string {
  const sections: string[] = [];

  if (!outcome.ok && outcome.undoFailures.length > 0) {
    sections.push(
      [
        "!!! MANUAL CLEANUP REQUIRED !!!",
        "These steps could NOT be rolled back — check these resources by hand:",
        ...outcome.undoFailures.map(
          (failure) => `  - ${failure.step}: ${describeError(failure.error)}`,
        ),
      ].join("\n"),
    );
  }

  sections.push(transcript.join("\n"));

  sections.push(
    outcome.ok
      ? `Succeeded. Steps: ${outcome.completed.join(", ")}`
      : [
          `FAILED at step "${outcome.failed}": ${describeError(outcome.error)}`,
          outcome.undone.length > 0
            ? `Rolled back: ${outcome.undone.join(", ")}`
            : "Rolled back: nothing (the failure was the first step)",
        ].join("\n"),
  );

  return sections.filter((section) => section !== "").join("\n\n");
}
