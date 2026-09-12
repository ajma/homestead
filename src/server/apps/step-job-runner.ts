import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { AppBusyError, type AppLock } from "./app-lock.js";
import type { AppRow } from "./job-runner.js";
import { runSteps, type Step, type StepEvent, type StepOutcome } from "./step-sequence.js";

/** Persisted output cap, the same bound `JobRunner` applies to compose output. */
const OUTPUT_CAP = 256 * 1024;

/**
 * Records a `runSteps` sequence as a `jobs` row, under the same per-app `AppLock` a
 * compose job takes — so an expose cannot race a deploy on the same app in either
 * direction, and a step sequence appears in the UI the way a deploy does: a row, a
 * terminal status, output a user can read.
 *
 * Unlike `JobRunner`, `start` does not return until the whole sequence — including any
 * rollback — has finished. There is no `live`/`cancel` here: a step sequence's individual
 * steps are network calls to Cloudflare's API, not a cancellable child process, and the
 * produced interface for this task is exactly `Promise<{ id }>`. Streaming this job's
 * progress to a connected client, if 2C or 2D want it, is new surface on top of this, not
 * a change to it.
 *
 * The output is the deliverable, not a side effect: a failed sequence can leave real
 * resources in someone's Cloudflare account, and `undoFailures` — the steps that could
 * not be cleaned up — is the one thing a reader of this job needs before anything else.
 * `buildOutput` below puts it first.
 */
export class StepJobRunner {
  constructor(private readonly deps: { db: Db; appLock: AppLock }) {}

  async start<C>(
    app: AppRow,
    kind: string,
    steps: Array<Step<C>>,
    ctx: C,
    userId: string,
  ): Promise<{ id: string }> {
    // Same synchronous-window requirement `JobRunner.start` documents: acquire, decide,
    // and (if granted) record the holder before any `await`, so two calls issued in the
    // same tick cannot both pass the check. `AppLock.tryAcquire` is synchronous for
    // exactly this reason.
    if (!this.deps.appLock.tryAcquire(app.id, `${kind} job`)) {
      throw new AppBusyError(app.id, this.deps.appLock.heldBy(app.id) ?? "another job");
    }

    const id = ulid();
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
      // No row exists to record the hold against — free the slot rather than wedging the
      // app behind a job nothing can ever see, cancel, or sweep.
      this.deps.appLock.release(app.id);
      throw error;
    }

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
    } finally {
      // Always — released whether the sequence succeeded, failed, or the write above
      // threw, or a failed step job wedges the app until restart. Matches
      // `JobRunner.finish`'s `finally`.
      this.deps.appLock.release(app.id);
    }

    return { id };
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
