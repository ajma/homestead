import { lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checkRollups, checks } from "../db/schema.js";

const HOUR_MS = 3_600_000;
/** Raw checks are kept 7 days; hourly rollups are kept indefinitely. */
export const RAW_RETENTION_MS = 7 * 24 * HOUR_MS;

export async function rollUpAndPrune(
  db: Db,
  now: number,
): Promise<{ rolled: number; pruned: number }> {
  // Align the cutoff down to an hour boundary so only *complete* hours are ever
  // rolled. Unaligned, a run splits the hour the cutoff lands in: it rolls the
  // first part, prunes it, and the next run finds only the remainder and — by
  // the replace semantics below — overwrites the bucket with it, erasing the
  // earlier observations for good. Retention becomes "7 days, plus up to an
  // hour", which costs nothing.
  //
  // This also keeps rollups and surviving raw checks disjoint: every rolled
  // hour lies entirely below the cutoff and every surviving raw row at or
  // above it, so `uptimeRatio` can add both sources without double-counting.
  const cutoff = Math.floor((now - RAW_RETENTION_MS) / HOUR_MS) * HOUR_MS;
  const old = await db.select().from(checks).where(lt(checks.at, cutoff));
  if (old.length === 0) return { rolled: 0, pruned: 0 };

  const buckets = new Map<
    string,
    {
      monitorId: string;
      hourStartedAt: number;
      upCount: number;
      downCount: number;
    }
  >();
  for (const row of old) {
    const hour = Math.floor(row.at / HOUR_MS) * HOUR_MS;
    const key = `${row.monitorId}:${hour}`;
    const b = buckets.get(key) ?? {
      monitorId: row.monitorId,
      hourStartedAt: hour,
      upCount: 0,
      downCount: 0,
    };
    if (row.up) b.upCount += 1;
    else b.downCount += 1;
    buckets.set(key, b);
  }

  for (const b of buckets.values()) {
    await db
      .insert(checkRollups)
      .values(b)
      // Replace, never add: the nightly job can run twice after a restart, and
      // an additive upsert would inflate every historical uptime figure with no
      // error anywhere.
      .onConflictDoUpdate({
        target: [checkRollups.monitorId, checkRollups.hourStartedAt],
        set: {
          upCount: sql`excluded.up_count`,
          downCount: sql`excluded.down_count`,
        },
      });
  }

  await db.delete(checks).where(lt(checks.at, cutoff));
  return { rolled: buckets.size, pruned: old.length };
}
