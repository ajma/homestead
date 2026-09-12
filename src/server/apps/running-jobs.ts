import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { JOB_KINDS } from "./job-runner.js";

/**
 * The running job for each of `appIds`, or absence when there is none.
 *
 * One grouped query for the whole page, same reasoning as `deployTimestamps` beside it:
 * the per-row alternative is one request per app on the screen that lists every app, and
 * every row was fetching that app's entire job history to answer a yes-or-no question.
 *
 * There is at most one running job per app — both `JobRunner` and `StepJobRunner` acquire
 * the same per-app `AppLock` (`app-lock.ts`) before recording a `running` row, and release
 * it only after the row goes terminal — so a `Map` rather than a list of lists is not a
 * simplification, it is the shape of the data. (That mutual exclusion is wiring, not a
 * private field either runner owns — see `job-runner.ts`'s doc on `appLock` — so it holds
 * only as long as every call site keeps sharing one `AppLock` instance.)
 *
 * Restricted to `JOB_KINDS` deliberately: this map's only consumer is `GET /api/apps`,
 * which hands its values to the client as `runningJobId` for `GET /api/jobs/:id/stream` to
 * resolve. `JobRunner.live` can only ever resolve one of ITS OWN jobs — a step job's kind
 * (e.g. `cloudflare_expose`) is never in `JOB_KINDS` — so without this filter a `running`
 * step-job row would be handed out as a `runningJobId` the stream route cannot follow: it
 * takes the "already finished" branch and emits `done` with `status: "running"`
 * immediately, re-enabling a client's action buttons while the sequence is still in
 * flight. Measured (Phase 2B whole-branch review, Important 2). A step job's own
 * `runningJobId`-equivalent, if 2C or 2D want one, is new surface on top of this, not a
 * loosening of this filter.
 */
export async function runningJobs(db: Db, appIds: string[]): Promise<Map<string, string>> {
  if (appIds.length === 0) return new Map();

  const rows = await db
    .select({ id: jobs.id, appId: jobs.appId })
    .from(jobs)
    .where(
      and(inArray(jobs.appId, appIds), eq(jobs.status, "running"), inArray(jobs.kind, JOB_KINDS)),
    );

  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.appId !== null) map.set(row.appId, row.id);
  }
  return map;
}
