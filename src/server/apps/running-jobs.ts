import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";

/**
 * The running job for each of `appIds`, or absence when there is none.
 *
 * One grouped query for the whole page, same reasoning as `deployTimestamps` beside it:
 * the per-row alternative is one request per app on the screen that lists every app, and
 * every row was fetching that app's entire job history to answer a yes-or-no question.
 *
 * There is at most one running job per app — `JobRunner` holds a per-app mutex
 * (`job-runner.ts:49`) — so a `Map` rather than a list of lists is not a simplification,
 * it is the shape of the data.
 */
export async function runningJobs(db: Db, appIds: string[]): Promise<Map<string, string>> {
  if (appIds.length === 0) return new Map();

  const rows = await db
    .select({ id: jobs.id, appId: jobs.appId })
    .from(jobs)
    .where(and(inArray(jobs.appId, appIds), eq(jobs.status, "running")));

  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.appId !== null) map.set(row.appId, row.id);
  }
  return map;
}
