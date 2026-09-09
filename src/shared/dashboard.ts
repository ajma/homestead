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
  /**
   * What the app is for, in the owner's words.
   *
   * For a project-backed app this is the project's description, so two tiles
   * from one project carry the same one — identity is set per project, and a
   * stack that publishes two ports is rare enough not to warrant a second
   * place to set it. Always null for a manual app, which has no such field.
   */
  description: string | null;
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
