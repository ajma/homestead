import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";

/**
 * Only these job kinds change what is running. `pull` fetches images without starting
 * or restarting anything the app depends on, and `down` is the opposite of a deploy —
 * counting either would tell the admin something happened that did not.
 */
const DEPLOY_KINDS = ["up", "restart"] as const;

/**
 * The most recent successful deploy for each of the given app ids, in one grouped
 * query. Built for `GET /api/apps`, where the alternative is one query per row on the
 * screen that lists every app — but it is exactly as cheap for a single id, so single-app
 * reads reuse it rather than trusting a stale value forever.
 */
export async function deployTimestamps(db: Db, appIds: string[]): Promise<Map<string, number>> {
  if (appIds.length === 0) return new Map();

  const rows = await db
    .select({ appId: jobs.appId, lastDeployAt: sql<number>`max(${jobs.finishedAt})` })
    .from(jobs)
    .where(
      and(
        inArray(jobs.appId, appIds),
        eq(jobs.status, "succeeded"),
        inArray(jobs.kind, [...DEPLOY_KINDS]),
        isNotNull(jobs.finishedAt),
      ),
    )
    .groupBy(jobs.appId);

  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.appId !== null && row.lastDeployAt !== null) map.set(row.appId, row.lastDeployAt);
  }
  return map;
}
