import type { AppStatus, FaultClass, ProbeKind } from "./types.js";

/** One probe's current state, as the launcher sees it. Never carries `lastDetail`. */
export type ProbeSnapshot = {
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
};
