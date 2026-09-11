import type { AppHealth, DayBucket, HealthSignal } from "@shared/launcher.js";
import { rollUpProbes } from "@shared/status-phrase.js";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checkRollups, probes } from "../db/schema.js";

const DAY = 86_400;
const WINDOW_DAYS = 30;

/**
 * The rollups for a set of probes within the trailing window, scoped at the database
 * level rather than relying on the caller to discard what it didn't ask for.
 *
 * Exported so the 30-day lower bound can be bound by a test that counts rows returned,
 * rather than one that inspects `appHealth`'s output — a row outside the window is
 * indistinguishable, at that layer, from one this query never fetched.
 */
export async function fetchRollupsInWindow(db: Db, probeIds: string[], oldest: number) {
  return db
    .select()
    .from(checkRollups)
    .where(and(inArray(checkRollups.probeId, probeIds), gte(checkRollups.hourStart, oldest)));
}

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
      probeId: row.id,
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
    buckets.set(day, { dayStart: day, upRatio: 0, degradedRatio: 0, downRatio: 0, probeCount: 0 });
  }

  if (rows.length > 0) {
    const hourly = await fetchRollupsInWindow(
      db,
      rows.map((r) => r.id),
      oldest,
    );

    // Bucket per probe per day first, so a probe polling every 60s doesn't outvote one
    // polling every 300s — see DayBucket's doc comment for why pooling raw counts lied.
    const perDayPerProbe = new Map<
      number,
      Map<string, { up: number; degraded: number; down: number }>
    >();
    for (const hour of hourly) {
      const day = hour.hourStart - (hour.hourStart % DAY);
      if (!buckets.has(day)) continue; // A future- (or past-window-) dated row. Not ours to reason about.
      let perProbe = perDayPerProbe.get(day);
      if (!perProbe) {
        perProbe = new Map();
        perDayPerProbe.set(day, perProbe);
      }
      const totals = perProbe.get(hour.probeId) ?? { up: 0, degraded: 0, down: 0 };
      totals.up += hour.upCount;
      totals.degraded += hour.degradedCount;
      totals.down += hour.downCount;
      perProbe.set(hour.probeId, totals);
    }

    // Collapse each day's per-probe totals into ratios, then average the ratios — never
    // the raw counts — so every probe that reported that day gets exactly one vote.
    for (const [day, perProbe] of perDayPerProbe) {
      const bucket = buckets.get(day);
      if (!bucket) continue;
      let contributing = 0;
      let upSum = 0;
      let degradedSum = 0;
      let downSum = 0;
      for (const totals of perProbe.values()) {
        const sampleCount = totals.up + totals.degraded + totals.down;
        if (sampleCount === 0) continue; // No samples today: this probe casts no vote.
        contributing += 1;
        upSum += totals.up / sampleCount;
        degradedSum += totals.degraded / sampleCount;
        downSum += totals.down / sampleCount;
      }
      if (contributing === 0) continue; // Bucket stays at its zeroed, no-data default.
      bucket.upRatio = upSum / contributing;
      bucket.degradedRatio = degradedSum / contributing;
      bucket.downRatio = downSum / contributing;
      bucket.probeCount = contributing;
    }
  }

  return { appId, signals, history: [...buckets.values()].sort((a, b) => a.dayStart - b.dayStart) };
}
