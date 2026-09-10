import { lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checkResults, checkRollups } from "../db/schema.js";

const HOUR = 3600;
export const RAW_RETENTION_HOURS = 48;
export const ROLLUP_RETENTION_DAYS = 90;

/**
 * Aggregates every complete hour that has no rollup yet, then prunes both tiers.
 *
 * "Every un-rolled hour", not "the previous hour", because the machine may have been off:
 * this is the startup catch-up the spec asks for and the hourly job at the same time.
 *
 * Rolling up strictly BEFORE pruning is load-bearing. Reversed, a sample older than the
 * raw window is deleted before it is ever summarised, and the 30-day timeline gets a hole
 * that nothing can fill afterwards.
 *
 * Never throws: this runs on a timer whose rejection would vanish.
 */
export async function runRetention(db: Db, now: number): Promise<{ hoursRolled: number }> {
  let hoursRolled = 0;
  try {
    const currentHourStart = now - (now % HOUR);

    // One statement: bucket every sample from a complete hour that has no rollup row yet.
    // `INSERT … SELECT … HAVING NOT EXISTS` keeps it idempotent, so a second run in the
    // same hour changes nothing.
    const inserted = await db.run(sql`
      INSERT INTO check_rollups (probe_id, hour_start, up_count, degraded_count, down_count, avg_latency_ms, max_latency_ms)
      SELECT
        probe_id,
        checked_at - (checked_at % ${HOUR}) AS hour_start,
        SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END),
        SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END),
        SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END),
        CAST(AVG(latency_ms) AS INTEGER),
        MAX(latency_ms)
      FROM check_results
      WHERE checked_at < ${currentHourStart}
      GROUP BY probe_id, hour_start
      HAVING NOT EXISTS (
        SELECT 1 FROM check_rollups r
        WHERE r.probe_id = check_results.probe_id AND r.hour_start = hour_start
      )
    `);
    hoursRolled = Number(inserted.rowsAffected ?? 0);

    await db
      .delete(checkResults)
      .where(lt(checkResults.checkedAt, now - RAW_RETENTION_HOURS * HOUR));
    await db
      .delete(checkRollups)
      .where(lt(checkRollups.hourStart, now - ROLLUP_RETENTION_DAYS * 24 * HOUR));
  } catch {
    // A retention failure is a disk-space problem for tomorrow, not a reason to take the
    // timer down today.
  }
  return { hoursRolled };
}
