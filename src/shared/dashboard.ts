import type { MonitorSummary, TargetStatus } from "./monitoring.js";

export type AppSource = "project" | "manual";

export type ConfidenceTier =
  | "verified"
  | "responding"
  | "down"
  | "blocked"
  | "unknown";

export type AppSummary = {
  /** `project_slug:service` or `manual:<id>` */
  key: string;
  source: AppSource;
  name: string;
  projectSlug: string | null;
  service: string | null;
  hostPort: number | null;
  /** The exposure hostname, or null when the app is not published. */
  hostname: string | null;
  iconSlug: string | null;
  iconUrl: string | null;
  status: TargetStatus;
  tier: ConfidenceTier;
  /**
   * The checks behind the dot, in the order the tile lists them.
   *
   * The dot is a rollup, and a rollup of several checks answers "is it up"
   * while hiding "which part is not". The route already assembles these to
   * compute `status` and `tier`; sending them costs one array and saves the
   * reader a trip to the database.
   */
  monitors: MonitorSummary[];
};

export type DeviceSummary = {
  id: string;
  name: string;
  kind: string;
  hidden: boolean;
  tailscaleNodeId: string | null;
  connectedToControl: boolean | null;
  lastSeen: number | null;
  os: string | null;
  status: TargetStatus;
};

export type DashboardData = {
  apps: AppSummary[];
  devices: DeviceSummary[];
  projectCount: number | null;
};
