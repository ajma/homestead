import { and, inArray, notInArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { JOB_KINDS } from "./job-runner.js";

/**
 * The message a swept job carries. `failed` rather than a new status value is deliberate:
 * the status union at `@shared/admin.ts` is consumed in many places and a user reads
 * "crashed" and "failed" the same way. The distinction lives here instead.
 *
 * Two variants, not one: a compose job's damage (if any) is in the app's containers, but a
 * step job's (a `cloudflare_expose`, from 2D onward) is Cloudflare-side — DNS records and
 * Access applications a killed sequence's rollback never ran for (see the whole-branch
 * review's ruling on the shutdown gap, Important 1). Telling a user to "check the app's
 * containers" about a stranded step job points them at the one place the damage is NOT.
 */
const SWEPT_OUTPUT_COMPOSE =
  "This job was interrupted: Homestead restarted while it was running. " +
  "The compose command may or may not have completed — check the app's containers.";

const SWEPT_OUTPUT_STEP =
  "This job was interrupted: Homestead restarted while it was in progress. " +
  "It may have created resources outside Homestead's own database — such as Cloudflare DNS " +
  "records or Access applications — that a normal failure would have rolled back. Check them " +
  "by hand.";

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
  const strandedCompose = await db
    .update(jobs)
    .set({ status: "failed", finishedAt: nowSeconds, output: SWEPT_OUTPUT_COMPOSE })
    .where(and(inArray(jobs.status, ["running", "queued"]), inArray(jobs.kind, JOB_KINDS)))
    .returning({ id: jobs.id });

  const strandedStep = await db
    .update(jobs)
    .set({ status: "failed", finishedAt: nowSeconds, output: SWEPT_OUTPUT_STEP })
    .where(and(inArray(jobs.status, ["running", "queued"]), notInArray(jobs.kind, [...JOB_KINDS])))
    .returning({ id: jobs.id });

  return strandedCompose.length + strandedStep.length;
}
