import type { AppStatus, FaultClass, ProbeKind } from "./types.js";

/**
 * One probe's current state, as the launcher sees it. Never carries `lastDetail`.
 *
 * `probeId` is the probe's own row id, not derived from `kind` — an app can only have one
 * probe of each kind today, but the id is what an SSE `status` event carries, and matching
 * on it (rather than on `kind`, which the event does not even include) is what lets the
 * client find the right entry in `LauncherApp.probes` to update.
 */
export type ProbeSnapshot = {
  probeId: string;
  kind: ProbeKind;
  label: string | null;
  status: AppStatus;
  faultClass: FaultClass | null;
  statusSince: number | null;
  lastCheckedAt: number | null;
};

/** An app's rolled-up state plus the human cause. `since` is epoch seconds. */
export type StatusReason = { status: AppStatus; reason: string; since: number | null };

/**
 * One launcher tile. A distinct type from `ViewerApp`, and like it, every property is
 * listed explicitly — a column added to `apps` must not be able to reach a viewer's
 * browser without someone editing this declaration.
 */
export type LauncherApp = {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  iconRef: string | null;
  category: string | null;
  launchUrl: string | null;
  sortOrder: number;
  status: AppStatus;
  reason: string;
  since: number | null;
  /**
   * Every enabled probe's current state. The client needs these to apply a single
   * probe's SSE event and re-derive the app's status the way the server would — without
   * them it can only overwrite, which made one probe recovering paint a tile green while
   * another was still down.
   */
  probes: ProbeSnapshot[];
};

/** One probe's row in the health panel. Never carries raw probe detail. */
export type HealthSignal = {
  probeId: string;
  kind: ProbeKind;
  label: string | null;
  status: AppStatus;
  reason: string;
  since: number | null;
  lastCheckedAt: number | null;
  latencyMs: number | null;
};

/**
 * One day of the timeline. Ratios in 0..1, each the mean across the app's probes of
 * that probe's own share for the day — NOT pooled counts.
 *
 * Pooling made the day read as whichever probe polled fastest: a 60s docker probe up all
 * day beside a 300s HTTP probe down all day summed to 83% healthy for an app whose web
 * interface was unreachable the whole time. Each probe now gets one vote.
 *
 * `probeCount` is how many probes reported at all that day. Zero means no data, which a
 * renderer must distinguish from a healthy day — the ratios are all 0 in both cases.
 */
export type DayBucket = {
  dayStart: number;
  upRatio: number;
  degradedRatio: number;
  downRatio: number;
  probeCount: number;
};

export type AppHealth = { appId: string; signals: HealthSignal[]; history: DayBucket[] };
