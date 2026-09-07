import type { HistoryBucket } from "@shared/monitoring.js";

export type CheckRow = { at: number; up: boolean };
export type RollupRow = {
  hourStartedAt: number;
  upCount: number;
  downCount: number;
};

/**
 * Uptime over `[from, to)`, or null when nothing was observed.
 *
 * Null rather than zero on purpose: zero renders as "0% uptime", which asserts
 * an outage that was never seen. A window with no checks — the runner was
 * stopped, or the monitor was created later — has no answer, and saying so is
 * more useful than inventing one.
 *
 * `checks` and `rollups` must describe disjoint periods, since both are simply
 * added: an observation present in each would be counted twice. Callers get
 * this for free rather than having to arrange it — `rollUpAndPrune` only ever
 * rolls hours lying entirely below its cutoff and prunes exactly the rows it
 * rolled, so no surviving raw check falls inside any rolled hour.
 */
export function uptimeRatio(
  checks: CheckRow[],
  rollups: RollupRow[],
  from: number,
  to: number,
): number | null {
  const HOUR = 3_600_000;
  let up = 0;
  let total = 0;

  for (const r of rollups) {
    // Include any rollup whose hour overlaps [from, to).
    // A bucket at hourStartedAt covers [hourStartedAt, hourStartedAt + HOUR).
    // Over-include to avoid missing outages: a bucket ending at `from` has no
    // overlap, but one ending after `from` does.
    //
    // An overlapping bucket is counted whole rather than pro-rated, because we
    // do not know how its observations fell within the hour and splitting the
    // counts would invent precision. The error is bounded by one partial hour
    // at each end of the window, and only arises where the window reaches back
    // past the raw-retention horizon into rollup data at all.
    const hourEnd = r.hourStartedAt + HOUR;
    if (hourEnd <= from || r.hourStartedAt >= to) continue;
    up += r.upCount;
    total += r.upCount + r.downCount;
  }
  for (const c of checks) {
    if (c.at < from || c.at >= to) continue;
    if (c.up) up += 1;
    total += 1;
  }

  return total === 0 ? null : up / total;
}

export function historyBuckets(
  checks: CheckRow[],
  from: number,
  to: number,
  bucketCount: number,
): HistoryBucket[] {
  if (bucketCount <= 0) return [];

  const span = (to - from) / bucketCount;
  const up = new Array<number>(bucketCount).fill(0);
  const total = new Array<number>(bucketCount).fill(0);

  for (const c of checks) {
    if (c.at < from || c.at >= to) continue;
    const i = Math.min(bucketCount - 1, Math.floor((c.at - from) / span));
    if (c.up) up[i] = (up[i] ?? 0) + 1;
    total[i] = (total[i] ?? 0) + 1;
  }

  return Array.from({ length: bucketCount }, (_, i) => {
    const t = total[i] ?? 0;
    const u = up[i] ?? 0;
    return {
      startedAt: from + i * span,
      ratio: t === 0 ? null : u / t,
    };
  });
}
