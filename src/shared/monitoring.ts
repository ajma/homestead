export type TargetType = "device" | "app";
export type MonitorType = "tailscale" | "tcp" | "http" | "dns" | "push";
export type DeviceKind = "phone" | "laptop" | "nas" | "vm" | "other";

/** A monitor's current state, derived from its most recent check. */
export type MonitorState = "up" | "down" | "unknown";

export type MonitorSummary = {
  id: string;
  type: MonitorType;
  required: boolean;
  enabled: boolean;
  state: MonitorState;
  lastCheckedAt: number | null;
  error: string | null;
};

/**
 * A target's dot. `reason` names the monitor that failed, because "container
 * exited" and "callback timed out" send you to different places.
 */
export type TargetStatus = {
  state: MonitorState;
  reason: string | null;
};

export type UptimeWindow = { windowMs: number; ratio: number | null };

/** One segment of the history bar. `ratio` is null for a bucket with no data. */
export type HistoryBucket = { startedAt: number; ratio: number | null };

export type DeviceSummary = {
  id: string;
  name: string;
  kind: DeviceKind;
  hidden: boolean;
  tailscaleNodeId: string | null;
  connectedToControl: boolean | null;
  lastSeen: number | null;
  os: string | null;
  status: TargetStatus;
};
