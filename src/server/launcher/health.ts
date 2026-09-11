import type { AppHealth, DayBucket, HealthSignal } from "@shared/launcher.js";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checkRollups, probes } from "../db/schema.js";
import { rollUpProbes } from "./status-phrase.js";

const DAY = 86_400;
const WINDOW_DAYS = 30;

/**
 * The three signals plus a 30-day timeline.
 *
 * Deliberately never returns `probes.lastDetail`. An HTTP probe's detail can carry
 * fragments of the response body, and a viewer opens this panel — so the safe shape is
 * the only shape, with no role branch here to get wrong. Admins get detail on the edit
 * page instead.
 *
 * 30 days of hourly rollups is 720 rows per probe, which no sparkline can render
 * usefully on a phone. Aggregating to days happens here, once, rather than in every
 * client.
 */
export async function appHealth(db: Db, appId: string, now: number): Promise<AppHealth> {
  const rows = await db
    .select()
    .from(probes)
    .where(and(eq(probes.appId, appId), eq(probes.enabled, true)));

  const signals: HealthSignal[] = rows.map((row) => {
    const snapshot = {
      kind: row.kind,
      label: row.label,
      status: row.lastStatus,
      faultClass: row.lastFaultClass,
      statusSince: row.statusSince,
      lastCheckedAt: row.lastCheckedAt,
    };
    // Each signal gets its own phrase, so a one-probe rollup names that probe's cause.
    const { reason } = rollUpProbes([snapshot]);
    return {
      probeId: row.id,
      kind: row.kind,
      label: row.label,
      status: row.lastStatus,
      reason,
      since: row.statusSince,
      lastCheckedAt: row.lastCheckedAt,
      latencyMs: row.lastLatencyMs,
    };
  });

  const today = now - (now % DAY);
  const oldest = today - (WINDOW_DAYS - 1) * DAY;

  // Pre-seed every day so the sparkline has no holes. A missing day is indistinguishable
  // from a zero day to a reader, and a gap in an SVG polyline just looks broken.
  const buckets = new Map<number, DayBucket>();
  for (let day = oldest; day <= today; day += DAY) {
    buckets.set(day, { dayStart: day, up: 0, degraded: 0, down: 0 });
  }

  if (rows.length > 0) {
    const hourly = await db
      .select()
      .from(checkRollups)
      .where(
        and(
          inArray(
            checkRollups.probeId,
            rows.map((r) => r.id),
          ),
          gte(checkRollups.hourStart, oldest),
        ),
      );
    for (const hour of hourly) {
      const bucket = buckets.get(hour.hourStart - (hour.hourStart % DAY));
      if (!bucket) continue; // A future-dated row. Not ours to reason about.
      bucket.up += hour.upCount;
      bucket.degraded += hour.degradedCount;
      bucket.down += hour.downCount;
    }
  }

  return { appId, signals, history: [...buckets.values()].sort((a, b) => a.dayStart - b.dayStart) };
}
