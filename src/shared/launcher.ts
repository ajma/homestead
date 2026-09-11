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
