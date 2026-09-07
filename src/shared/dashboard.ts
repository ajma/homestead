import type { TargetStatus } from "./monitoring.js";

export type AppSource = "project" | "manual";

export type ConfidenceTier =
  | "verified"
  | "responding"
  | "degraded"
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
