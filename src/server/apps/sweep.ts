import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";

/**
 * The message a swept job carries. `failed` rather than a new status value is deliberate:
 * the status union at `@shared/admin.ts` is consumed in many places and a user reads
 * "crashed" and "failed" the same way. The distinction lives here instead.
 */
const SWEPT_OUTPUT =
  "This job was interrupted: Homestead restarted while it was running. " +
  "The compose command may or may not have completed — check the app's containers.";

/**
 * Repairs jobs a crash left mid-flight.
 *
 * `JobRunner.finish` is the only writer of a terminal status and it runs off the in-memory
 * `running` Map, which does not survive a restart. Without this, a killed process leaves a
 * row at `running` with a null `finishedAt` forever, and `ActionBar` resumes from the most
 * recent row — so every page load after a crash shows a job that will never end.
 *
 * Runs once at startup, after migrations and before `listen`, when nothing can be running
 * yet by definition: this process has started no jobs, and Homestead is one process by
 * design (spec §2). Any `running` row it finds therefore belongs to a previous life. If
 * that ever stops being true — a second writer, a worker pool, anything but one process —
 * this sweep would start failing jobs that are legitimately in flight, and would need to
 * become conditional on more than "the process just started".
 *
 * `exitCode` stays null on purpose. No process exited; inventing a code would put a number
 * in the UI that never came from anywhere.
 */
export async function sweepStrandedJobs(db: Db, nowSeconds: number): Promise<number> {
  const stranded = await db
    .update(jobs)
    .set({ status: "failed", finishedAt: nowSeconds, output: SWEPT_OUTPUT })
    .where(inArray(jobs.status, ["running", "queued"]))
    .returning({ id: jobs.id });

  return stranded.length;
}
